// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
//
// Smoke-test for server.js-wiringen. server.js eier ingen ruter selv, men
// wirer pino-http request-logger, Sentry-init/error-middleware og graceful
// shutdown. Vitest setter VITEST=true, så server.js hopper over db.init() +
// auto-listen ved require — vi starter en egen ephemeral-lytter (port 0) for
// å sende ekte requests gjennom hele middleware-kjeden.

const http = require('http');

// db-singletonen mutes (vi.mock fanger ikke require() i dette oppsettet —
// vi muterer metoder på den faktiske modulen i stedet).
const db = require('../db');

const { app, server, gracefulShutdown, errorMiddleware } = require('../server');

// Hjelper: send en GET mot app via en midlertidig lytter, returner {status, body}.
function getViaApp(sti) {
  return new Promise((resolve, reject) => {
    const lytter = http.createServer(app);
    lytter.listen(0, '127.0.0.1', () => {
      const { port } = lytter.address();
      const req = http.request({ host: '127.0.0.1', port, path: sti, method: 'GET' }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => lytter.close(() => resolve({ status: res.statusCode, body })));
      });
      req.on('error', (e) => lytter.close(() => reject(e)));
      req.end();
    });
  });
}

describe('server.js wiring', () => {
  it('eksporterer app, http-server og gracefulShutdown', () => {
    expect(typeof app).toBe('function'); // express-app er callable
    expect(server).toBeInstanceOf(http.Server);
    expect(typeof gracefulShutdown).toBe('function');
  });

  it('request gjennom hele kjeden (logger + ruter) svarer på /api/health', async () => {
    const res = await getViaApp('/api/health');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it('error-middleware svarer 500 JSON uten å kaste', () => {
    // Tester den faktiske error-handleren som er wiret inn (app.use sist).
    let status = null;
    let payload = null;
    const res = {
      headersSent: false,
      status(s) { status = s; return this; },
      json(o) { payload = o; return this; },
    };
    const req = { log: { error() {} } };
    expect(() => errorMiddleware(new Error('test-boom'), req, res, () => {})).not.toThrow();
    expect(status).toBe(500);
    expect(payload).toEqual({ ok: false, error: 'Intern feil' });
  });

  it('error-middleware respekterer err.status og hopper over når headers er sendt', () => {
    let status = null;
    const res404 = { headersSent: false, status(s) { status = s; return this; }, json() { return this; } };
    errorMiddleware(Object.assign(new Error('nope'), { status: 404 }), {}, res404, () => {});
    expect(status).toBe(404);

    let kalt = false;
    const resSent = { headersSent: true, status() { kalt = true; return this; }, json() { return this; } };
    errorMiddleware(new Error('sent'), {}, resSent, () => {});
    expect(kalt).toBe(false); // skal ikke skrive når headers allerede er sendt
  });

  it('gracefulShutdown lukker http-server + pg-pool og exit 0', async () => {
    let serverClosed = false;
    let poolEnded = false;
    let exitKode = null;

    const origClose = server.close;
    server.close = (cb) => {
      serverClosed = true;
      if (cb) cb();
      return server;
    };
    const origPool = db.pool;
    db.pool = { end: async () => { poolEnded = true; } };
    const origExit = process.exit;
    process.exit = (kode) => { exitKode = kode; };

    try {
      await gracefulShutdown('SIGTERM');
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      server.close = origClose;
      db.pool = origPool;
      process.exit = origExit;
    }

    expect(serverClosed).toBe(true);
    expect(poolEnded).toBe(true);
    expect(exitKode).toBe(0);
  });
});
