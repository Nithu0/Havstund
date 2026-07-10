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
// Kun rutene som faktisk tar store payloads får egen 8mb-parser FORAN den
// globale. De to som trenger det er base64-bilde-opplastinger (data:image/…,
// begge kappet på ~7 MB i ruten selv):
//   - POST /api/projects/:id/media   (prosjekt-media, felt `fil`)
//   - POST/PATCH /api/regnskap/poster (kvitteringsbilde, felt `vedlegg`)
// Express markerer req._body=true etter parse, så den globale 256kb-parseren
// hopper over disse når de allerede er parset. Alt annet (activities.bilde er
// bare en sti/URL, admin/content kappet på 50k tegn, kvitteringer er tall/tekst)
// får den lave grensen. Prefiks-nivå er granulariteten auto-mount gir oss;
// begge prefiks er uansett rolle-beskyttet (ansatt|admin).
const storBodyParser = express.json({ limit: '8mb' });
app.use('/api/projects', storBodyParser);
app.use('/api/regnskap', storBodyParser);
// Fase 6: kvittering-opplasting POST-er base64-foto (1-5 MB) til /api/brain/ask.
// Uten egen parser her ville den globale 256kb-grensen gitt 413 på ekte bilder.
// Samme mønster som projects/regnskap; brain-rutene er agent-/rolle-beskyttet.
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

// ---- S1: rolle-gate for interne HTML-skall (default PÅ) ----
// De statiske sidene under er interne admin-/intern-skall. API-dataene bak dem
// er allerede rolle-beskyttet, så uinnlogget tilgang her er skall-eksponering
// (selve HTML-et lastes), ikke en PII-lekkasje. Middleware kjører FØR
// express.static og etter authOptional, så req.user er allerede satt.
// Rollback på 30 sek uten kodeendring: STATIC_AUTH_ENABLED=false.
// Roller pr. side speiler rolle-kravet på sidens primære API (se routes/*).
const BESKYTTEDE_SIDER = {
  'admin-agenda': ['admin'], // admin-only: ansatt bruker /ansatt (kun timeliste + samtale)
  'admin-aktiviteter': ['admin'], // /api/activities/admin/all krever admin
  'admin-innsikt': ['admin'], // admin-only skall
  'admin-kunder': ['admin'], // admin-only skall
  'regnskap': ['admin'], // /api/regnskap/* er admin-only (blocker 2, bolge 98)
  'okonomi': ['admin'], // /api/finance krever admin
  'intranett': ['admin'], // admin-dashbord: ansatt sendes til /ansatt, ikke hit
  'ansatt': ['ansatt', 'admin'], // /api/min/* krever innlogget ansatt/admin (bolge 98, steg 5)
  'chat-innboks': ['admin'], // admin-only skall
  'bookinger': ['admin'], // admin-only skall
  'kunde-dialog': ['admin'], // admin-only skall
};

// Normaliser en rå request-path til NØYAKTIG den oppslagsnøkkelen
// express.static til slutt slår opp — slik at porten ser det samme som static.
// Returnerer null for stier vi ikke trygt kan tolke (fail-closed-signal).
//
// Hvorfor dette er nødvendig: req.path er RÅ (ikke prosentdekodet), men
// express.static/send DEKODER én gang før filoppslag. En navne-allowlist på
// req.path ser derfor '/regnskap%2Ehtml' (ingen treff -> next), mens static
// dekoder til 'regnskap.html' og serverer siden. Vi lukker hele klassen ved å
// dekode + normalisere på SAMME måte som static, ikke bare stripe '.html'.
//
// Dekoding: KUN én gang. Bekreftet ved probe at express.static single-dekoder
// ('/regnskap%252Ehtml' serverer IKKE regnskap.html — static leter etter en fil
// med literal '%2E' i navnet, som ikke finnes). En dekode-LØKKE ville derfor
// avvike fra static OG er sin egen sårbarhet — vi bruker bevisst ikke while.
function normaliserForOppslag(raStien) {
  let sti;
  try {
    // decodeURIComponent er samme dekoder som send bruker; kaster på ugyldig
    // prosentkoding (f.eks. '%ZZ', '%E0%A4%A').
    sti = decodeURIComponent(raStien);
  } catch {
    return null; // udekodbar -> fail-closed
  }
  // Null-byte kan trunkere filoppslag på lavere lag — aldri trygt.
  if (sti.indexOf('\0') !== -1) return null;
  // Windows bruker '\\' som katalogseparator; normaliser til '/' før traversal-
  // kollaps slik at '\\..\\'-varianter ikke slipper unna.
  sti = sti.replace(/\\/g, '/');
  // Kollaps '.', '..' og duplikat-slash slik path-oppslaget faktisk gjør. Dette
  // fanger 'foo/../regnskap.html', '/./regnskap.html' og '%5C..%5C'-variantene.
  sti = path.posix.normalize(sti);
  // Fjern ledende slash(er), strip '.html' (case-ufølsomt), og lowercase.
  // Case-ufølsomt oppslag er forsvar i dybden: filsystemet på Windows er
  // case-ufølsomt (/REGNSKAP.html treffer regnskap.html), mens Linux uansett
  // gir 404 på feil case.
  return sti.replace(/^\/+/, '').replace(/\.html$/i, '').toLowerCase();
}

function beskyttetSideGate(req, res, next) {
  // Default PÅ: kun eksakt 'false' slår av (rollback-bryter).
  if (process.env.STATIC_AUTH_ENABLED === 'false') return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const nøkkel = normaliserForOppslag(req.path);
  if (nøkkel === null) {
    // Udekodbar/utrygg sti: vi kan ikke avgjøre hva static ville slått opp, så
    // vi feiler LUKKET. 400 (ikke redirect): stien er en ugyldig ressurs-
    // identitet, ikke et innloggingsproblem, og 400 kan aldri servere beskyttet
    // HTML. Statisk lag ville uansett ikke servert en beskyttet side fra en
    // sti med samme dekode-feil, så dette divergerer ikke fra static.
    return res.status(400).type('text/plain').send('Ugyldig forespørsel');
  }
  const kreverRoller = BESKYTTEDE_SIDER[nøkkel];
  if (!kreverRoller) return next();
  const rolle = req.user && req.user.rolle;
  if (rolle && kreverRoller.includes(rolle)) return next();
  // Nettleser-navigasjon: redirect til innlogging (ikke 403-JSON).
  return res.redirect('/konto');
}
app.use(beskyttetSideGate);

// ---- Statiske filer (offentlig side + intern shell) ----
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
