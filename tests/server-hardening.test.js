// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
//
// Tester for herdingen i server.js:
//   S1  â€” rolle-gate foran express.static (beskyttede interne HTML-skall)
//   F52 â€” global json-grense pÃ¥ 256kb avviser for store payloads
//
// Vitest setter VITEST=true, sÃ¥ server.js hopper over db.init() + auto-listen
// ved require. Vi starter en egen ephemeral-lytter (port 0) og sender ekte
// requests gjennom hele middleware-kjeden. http.request fÃ¸lger IKKE redirects,
// sÃ¥ vi kan observere selve 302-svaret.

const http = require('http');

const { app } = require('../server');
const { signToken, COOKIE } = require('../lib/auth');

// Hjelper: send en request mot app via en midlertidig lytter.
// opts: { path, method, headers, body }. Returnerer {status, headers, body}.
function viaApp({ path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const lytter = http.createServer(app);
    lytter.listen(0, '127.0.0.1', () => {
      const { port } = lytter.address();
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () =>
            lytter.close(() =>
              resolve({ status: res.statusCode, headers: res.headers, body: data })
            )
          );
        }
      );
      req.on('error', (e) => lytter.close(() => reject(e)));
      if (body != null) req.write(body);
      req.end();
    });
  });
}

function adminCookie() {
  const token = signToken({ id: 1, rolle: 'admin', navn: 'Test Admin' });
  return `${COOKIE}=${token}`;
}
function kundeCookie() {
  const token = signToken({ id: 2, rolle: 'kunde', navn: 'Test Kunde' });
  return `${COOKIE}=${token}`;
}
function ansattCookie() {
  const token = signToken({ id: 3, rolle: 'ansatt', navn: 'Test Ansatt' });
  return `${COOKIE}=${token}`;
}


describe('F52 â€” global json-grense (256kb)', () => {
  it('POST med >256kb JSON pÃ¥ en vanlig rute avvises (413)', async () => {
    // ~300 KB body. express.json (256kb) skal kaste PayloadTooLargeError fÃ¸r
    // requesten nÃ¥r ruten -> error-middleware svarer 413.
    const stor = 'a'.repeat(300 * 1024);
    const body = JSON.stringify({ felt: stor });
    const res = await viaApp({
      path: '/api/bookings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    expect(res.status).toBe(413);
  });

  it('POST med liten JSON-body pÃ¥ samme rute passerer parseren (ikke 413)', async () => {
    // Bekrefter at 256kb-grensen ikke er for stram: en normal liten body slipper
    // gjennom parseren og nÃ¥r ruten (uansett hva ruten sÃ¥ svarer).
    const body = JSON.stringify({ epost: 'x@y.no', passord: 'feil' });
    const res = await viaApp({
      path: '/api/bookings',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    expect(res.status).not.toBe(413);
  });
});
