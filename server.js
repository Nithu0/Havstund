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

app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.use(agentAuth);    // service-token -> 'agent'-principal (brain). FØR authOptional.
app.use(authOptional); // setter req.user hvis innlogget (valgfritt)
app.use(agentGate);    // agent kun på allowlistede ruter (også handler-rolle-ruter)

// Helsesjekk for Railway — pinger DB med SELECT 1 (db.ping). Svarer 200 når
// databasen faktisk svarer, ellers 503. Kaster aldri selv (try/catch).
app.get('/api/health', async (_req, res) => {
  try {
    await db.ping();
    // DB svarer. Men init (skjema/seed) kan ha feilet — da er vi i degradert
    // drift: appen serves, så vi svarer 200 (ingen Railway-restart-loop), men
    // rapporterer generisk "degraded" (aldri rå initErr.message) for synlighet.
    if (typeof db.isDegraded === 'function' && db.isDegraded()) {
      return res.status(200).json({ ok: true, db: 'degraded' });
    }
    res.json({ ok: true, db: 'up' });
  } catch {
    // DB er faktisk nede/ikke pingbar -> 503 utløser Railway-restart (ON_FAILURE).
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
    } catch (e) {
      console.error('  ✗ kunne ikke laste rute ' + f + ':', e.message);
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
    } catch (e) {
      console.error('  ✗ kunne ikke laste realtime ' + f + ':', e.message);
    }
  }
}

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
    sentry.captureException(err);
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
