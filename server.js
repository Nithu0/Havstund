/* ============================================================
   Havstund — plattform-server (Railway-klar)
   - Serverer offentlig nettside + intern dashboard fra /public
   - Auto-laster REST-ruter fra /routes  -> /api/<filnavn>
   - Auto-laster Socket.IO-handlere fra /realtime
   - Lytter på process.env.PORT
   ============================================================ */
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const db = require('./db');
const { authOptional } = require('./lib/auth');
const { agentAuth, agentGate } = require('./lib/agent-auth');
const { applySecurity } = require('./lib/security');
const { logger, lagRequestLogger } = require('./lib/logger');
const sentry = require('./lib/sentry');

const app = express();
applySecurity(app); // helmet + rate limiting — før body-parsere og ruter

// Strukturert request-logging (pino-http). Etter applySecurity, før ruter,
// slik at hver request får req.log + automatisk request/response-logg.
app.use(lagRequestLogger());

const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);

const PORT = process.env.PORT || 3000;

// Slå på Sentry ved oppstart. No-op uten SENTRY_DSN. Kaster aldri.
sentry.init(app);

// F52 — body-grenser. Global default er lav (256kb) mot minne-/DoS-misbruk.
// Etter forenklingen 2026-08-07 ("kun forsiden") er /api/projects og
// /api/regnskap borte, så bare brain-ruten trenger fortsatt en stor parser:
// kvittering-opplasting POST-er base64-foto (1-5 MB) til /api/brain/ask, og
// den globale 256kb-grensen ville gitt 413 på ekte bilder. Express markerer
// req._body=true etter parse, så den globale parseren hopper over den når den
// allerede er parset. Forsidens egne ruter (activities/bookings/content/hours/
// chat) er tall og kort tekst og får den lave grensen.
const storBodyParser = express.json({ limit: '8mb' });
app.use('/api/brain', storBodyParser);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());
app.use(agentAuth);    // service-token -> 'agent'-principal (brain). FØR authOptional.
app.use(authOptional); // setter req.user hvis innlogget (valgfritt)
app.use(agentGate);    // agent kun på allowlistede ruter (også handler-rolle-ruter)

// Helsesjekk for Railway — verifiserer at DB svarer OG at kjerneskjemaet finnes
// (db.ping gjør begge, se F47). Svarer 503 kun ved ekte brudd: DB nede ELLER
// kjernetabell mangler. Degradert (ikke-fatal init-advarsel, skjema OK) gir 200
// med et synlig degradert-flagg — appen serves videre (PR #31). Kaster aldri
// selv (try/catch).
app.get('/api/health', async (_req, res) => {
  try {
    await db.ping();
    // ping() beviser at DB svarer OG at kjernetabellen finnes. Men init
    // (seed/migrasjoner) kan ha feilet selv om tabellene ble opprettet — da er
    // vi i degradert drift. Degradert er en IKKE-fatal init-advarsel: appen kan
    // fortsatt serve (kjerneskjemaet er OK). Per PR #31 skal en db-init-feil rope
    // høyt, men IKKE crash-loope healthchecken — derfor svarer vi 200 med et
    // synlig degradert-flagg (ikke 503). En 503 her ville blokkert alle
    // fremtidige Railway-deploys hvis en ikke-fatal migrasjons-hikke satte
    // flagget. Vi rapporterer generisk "degraded" — aldri rå intern feilmelding
    // (se db/index.js:38) — så skjema-/init-detaljer aldri lekker offentlig.
    if (typeof db.isDegraded === 'function' && db.isDegraded()) {
      return res.status(200).json({ ok: true, db: 'degraded', degraded: true });
    }
    res.json({ ok: true, db: 'up' });
  } catch {
    // DB nede/ikke pingbar ELLER kjerneskjema mangler -> 503 (ON_FAILURE). Ved
    // manglende skjema fikser en restart det ofte (init kjører schema.sql på
    // nytt). Generisk "down" — ingen skjema-detaljer i det offentlige svaret.
    res.status(503).json({ ok: false, db: 'down' });
  }
});

// ---- Auto-last REST-ruter: routes/foo.js -> /api/foo ----
const routesDir = path.join(__dirname, 'routes');
if (fs.existsSync(routesDir)) {
  for (const f of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))) {
    const name = f.replace(/\.js$/, '');
    try {
      app.use('/api/' + name, require(path.join(routesDir, f)));
      console.log('  ✓ rute  /api/' + name);
    } catch (err) {
      // F48 — strukturert logg + Sentry i stedet for rå console.error.
      logger.error({ err, fil: f }, 'kunne ikke laste REST-rute');
      sentry.captureException(err);
    }
  }
}

// ---- AI-brain (av/på via BRAIN_ENABLED). Returnerer umiddelbart når av. ----
require('./integrations/brain-shim')(app);

// ---- Auto-last Socket.IO-handlere: realtime/*.js (exporterer function(io)) ----
const rtDir = path.join(__dirname, 'realtime');
if (fs.existsSync(rtDir)) {
  for (const f of fs.readdirSync(rtDir).filter((f) => f.endsWith('.js'))) {
    try {
      require(path.join(rtDir, f))(io);
      console.log('  ✓ realtime ' + f);
    } catch (err) {
      // F48 — strukturert logg + Sentry i stedet for rå console.error.
      logger.error({ err, fil: f }, 'kunne ikke laste realtime-handler');
      sentry.captureException(err);
    }
  }
}

// ---- Rolle-gate for interne HTML-skall: FJERNET 2026-08-07 ----
// Porten (S1) fantes for å hindre at uinnloggede lastet skallet til de interne
// admin-/ansatt-/kundesidene. Ved forenklingen ("kun forsiden") ble ALLE de
// sidene slettet — public/ inneholder nå bare index.html. En allowlist som
// vokter filer som ikke finnes er død kode, og redirecten pekte til /konto,
// som også er borte. Fjernet i stedet for å la den råtne.
//
// Hvis en intern side noen gang kommer tilbake: hent porten fra git-historikken
// (den håndterte prosentkoding og path-traversal riktig — ikke skriv den på nytt
// fra minnet), og legg den tilbake FØR express.static.

// ---- Statiske filer (kun den offentlige forsiden) ----
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Fallback: alle ikke-API GET-ruter -> forsiden
app.get(/^\/(?!api).*/, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ---- Feil-middleware (MÅ stå sist, etter alle ruter) ----
// Rapporterer til Sentry (no-op uten DSN), logger via pino og svarer 500.
// 4 argumenter kreves for at Express skal gjenkjenne dette som error-handler.
// eslint-disable-next-line no-unused-vars
function errorMiddleware(err, req, res, _next) {
  try {
    // F50 — send request-kontekst til Sentry for raskere feilsøking. Kun
    // ikke-sensitive felt: aldri body/headers/cookies (PII). rolle hentes fra
    // req.user hvis satt.
    sentry.captureException(err, {
      extra: {
        url: req && req.originalUrl,
        method: req && req.method,
        reqId: req && req.id,
        rolle: (req && req.user && req.user.rolle) || undefined,
      },
    });
  } catch {
    /* Sentry skal aldri velte requesten */
  }
  const log = (req && req.log) || logger;
  log.error({ err }, 'uhåndtert feil i request');
  if (res.headersSent) return;
  res.status(err && err.status ? err.status : 500).json({ ok: false, error: 'Intern feil' });
}
app.use(errorMiddleware);

// ---- Graceful shutdown: lukk http-server + pg-pool, exit 0 ----
let stengerNed = false;
async function gracefulShutdown(signal) {
  if (stengerNed) return;
  stengerNed = true;
  logger.info({ signal }, 'mottok signal — stenger ned pent');

  // Tving exit hvis noe henger (f.eks. åpne keep-alive-sockets).
  const tvangsExit = setTimeout(() => {
    logger.error('graceful shutdown tok for lang tid — tvinger exit');
    process.exit(1);
  }, 10_000);
  if (typeof tvangsExit.unref === 'function') tvangsExit.unref();

  try {
    // 1) Slutt å ta imot nye connections.
    await new Promise((resolve) => server.close(() => resolve()));
    // 2) Lukk pg-poolen om den finnes (null uten DATABASE_URL).
    if (db.pool && typeof db.pool.end === 'function') {
      await db.pool.end();
    }
    clearTimeout(tvangsExit);
    logger.info('nedstenging ferdig');
    process.exit(0);
  } catch (e) {
    logger.error({ err: e }, 'feil under nedstenging');
    clearTimeout(tvangsExit);
    process.exit(1);
  }
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => gracefulShutdown(sig));
}

// ---- Oppstart: init DB (skjema + seed) deretter lytt ----
// Hopp over auto-start under test (vitest setter NODE_ENV=test / VITEST).
const underTest = process.env.NODE_ENV === 'test' || process.env.VITEST;
if (!underTest) {
  db.init().finally(() =>
    server.listen(PORT, () => logger.info({ port: PORT }, 'Havstund kjører'))
  );
}

module.exports = { app, server, gracefulShutdown, errorMiddleware };
