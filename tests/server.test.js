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

// Hjelper: send en POST med JSON-body mot app, returner {status, body}.
function postViaApp(sti, jsonBody) {
  const data = Buffer.from(JSON.stringify(jsonBody));
  return new Promise((resolve, reject) => {
    const lytter = http.createServer(app);
    lytter.listen(0, '127.0.0.1', () => {
      const { port } = lytter.address();
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: sti,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => lytter.close(() => resolve({ status: res.statusCode, body })));
        }
      );
      req.on('error', (e) => lytter.close(() => reject(e)));
      req.end(data);
    });
  });
}

describe('server.js wiring', () => {
  it('eksporterer app, http-server og gracefulShutdown', () => {
    expect(typeof app).toBe('function'); // express-app er callable
    expect(server).toBeInstanceOf(http.Server);
    expect(typeof gracefulShutdown).toBe('function');
  });

  it('/api/health svarer 200 {ok:true, db:up} når db.ping resolver', async () => {
    // db-singletonen mutes (vi.mock fanger ikke require() — vi muterer metoden
    // på den faktiske modulen, slik resten av denne testfila gjor).
    const origPing = db.ping;
    db.ping = async () => true;
    try {
      const res = await getViaApp('/api/health');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.db).toBe('up');
    } finally {
      db.ping = origPing;
    }
  });

  it('/api/health svarer 503 {ok:false, db:down} når db.ping kaster (ingen DB)', async () => {
    const origPing = db.ping;
    db.ping = async () => {
      throw new Error('SELECT 1 feilet — ingen DB');
    };
    try {
      const res = await getViaApp('/api/health');
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(false);
      expect(body.db).toBe('down');
    } finally {
      db.ping = origPing;
    }
  });

  it('/api/health svarer 200 {ok:true, db:degraded} når db pinger men init var degradert', async () => {
    // DB svarer og kjernetabellen finnes, men seed/migrasjon-init feilet ->
    // degradert drift. Degradert er en IKKE-fatal init-advarsel: appen serves
    // videre (PR #31 — db-init-feil skal rope høyt, men IKKE crash-loope
    // healthchecken og blokkere fremtidige Railway-deploys). Health skal derfor
    // svare 200 med et synlig degradert-flagg, ikke 503 — men fortsatt rapportere
    // generisk "degraded", aldri rå intern feilmelding.
    const origPing = db.ping;
    const origDegraded = db.isDegraded;
    db.ping = async () => true;
    db.isDegraded = () => true;
    try {
      const res = await getViaApp('/api/health');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(true);
      expect(body.db).toBe('degraded');
      expect(body.degraded).toBe(true);
      // ingen lekkasje av intern init-/skjema-detalj i det offentlige svaret
      expect(res.body).not.toMatch(/schema|skjema|seed|migrasjon|SELECT|users|to_regclass/i);
    } finally {
      db.ping = origPing;
      db.isDegraded = origDegraded;
    }
  });

  it('/api/health svarer 503 {ok:false, db:down} når skjemaet mangler (ping kaster)', async () => {
    // F47: kjerneuttrykket. Selv om DB-motoren svarer på SELECT 1, kaster ping()
    // når kjernetabellen mangler (to_regclass NULL). Health må da svare 503, og
    // aldri lekke at det var *skjemaet* (users-tabellen) som manglet.
    const origPing = db.ping;
    db.ping = async () => {
      throw new Error('Kjerneskjema mangler: tabellen users finnes ikke');
    };
    try {
      const res = await getViaApp('/api/health');
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.ok).toBe(false);
      expect(body.db).toBe('down');
      // det offentlige svaret avslører verken tabellnavn eller skjema-detalj
      expect(res.body).not.toMatch(/schema|skjema|users|to_regclass|Kjerneskjema/i);
    } finally {
      db.ping = origPing;
    }
  });

  it('/api/brain aksepterer body større enn den globale 256kb-grensen (Fase 6 bilde-payload)', async () => {
    // Fase 6 POST-er base64-foto (1-5 MB) til /api/brain/ask. En egen 8mb-parser
    // er montert på /api/brain FORAN den globale 256kb-parseren. Uten den ville
    // en >256kb-body kastet PayloadTooLargeError (status 413) i body-parseren, som
    // errorMiddleware respekterer (err.status). Med parseren parses bodyen OK og
    // request går videre til gate/route — så svaret er ALDRI 413.
    const storBody = { data: 'x'.repeat(400 * 1024) }; // ~400kb > 256kb, < 8mb
    const res = await postViaApp('/api/brain/ask', storBody);
    // Kjernet: parseren avviser den ikke som for stor.
    expect(res.status).not.toBe(413);
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
