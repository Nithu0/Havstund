// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
//
// Tester for herdingen i server.js:
//   S1  — rolle-gate foran express.static (beskyttede interne HTML-skall)
//   F52 — global json-grense på 256kb avviser for store payloads
//
// Vitest setter VITEST=true, så server.js hopper over db.init() + auto-listen
// ved require. Vi starter en egen ephemeral-lytter (port 0) og sender ekte
// requests gjennom hele middleware-kjeden. http.request følger IKKE redirects,
// så vi kan observere selve 302-svaret.

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

describe('S1 — rolle-gate foran express.static', () => {
  // Sørg for at bryteren er PÅ (default) uansett hva miljøet hadde.
  let forrige;
  beforeEach(() => {
    forrige = process.env.STATIC_AUTH_ENABLED;
    delete process.env.STATIC_AUTH_ENABLED;
  });
  afterEach(() => {
    if (forrige === undefined) delete process.env.STATIC_AUTH_ENABLED;
    else process.env.STATIC_AUTH_ENABLED = forrige;
  });

  it('uinnlogget GET /regnskap.html -> 302 redirect til /konto', async () => {
    const res = await viaApp({ path: '/regnskap.html' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/konto');
  });

  it('uinnlogget GET /regnskap (uten .html, extensions-form) -> 302 til /konto', async () => {
    // extensions:['html'] gjør at /regnskap også ville servert regnskap.html;
    // gaten må dekke begge former.
    const res = await viaApp({ path: '/regnskap' });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/konto');
  });

  it('feil rolle (kunde) GET /admin-kunder.html -> 302 til /konto', async () => {
    const res = await viaApp({ path: '/admin-kunder.html', headers: { Cookie: kundeCookie() } });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/konto');
  });

  it('admin-cookie GET /regnskap.html -> 200 (siden serveres)', async () => {
    const res = await viaApp({ path: '/regnskap.html', headers: { Cookie: adminCookie() } });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html|<!doctype/i);
  });

  it('admin-cookie GET /regnskap (extensions-form) -> 200', async () => {
    const res = await viaApp({ path: '/regnskap', headers: { Cookie: adminCookie() } });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html|<!doctype/i);
  });

  it('okonomi krever admin: kunde-cookie -> 302, admin -> 200', async () => {
    const nekt = await viaApp({ path: '/okonomi.html', headers: { Cookie: kundeCookie() } });
    expect(nekt.status).toBe(302);
    const ok = await viaApp({ path: '/okonomi.html', headers: { Cookie: adminCookie() } });
    expect(ok.status).toBe(200);
  });

  it('offentlig side (/konto) er ikke gated — uinnlogget -> 200', async () => {
    const res = await viaApp({ path: '/konto.html' });
    expect(res.status).toBe(200);
  });

  it('STATIC_AUTH_ENABLED=false slår av gaten -> 200 uten cookie', async () => {
    process.env.STATIC_AUTH_ENABLED = 'false';
    const res = await viaApp({ path: '/regnskap.html' });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html|<!doctype/i);
  });
});

describe('S1b — dekode-/normaliserings-bypass foran express.static', () => {
  // req.path er RÅ, men express.static DEKODER én gang før filoppslag. En gate
  // som bare stripper '.html' på req.path ser '/regnskap%2Ehtml' som ukjent og
  // slipper den forbi -> static dekoder -> serverer regnskap.html (lekkasje).
  // Disse testene dekker hele klassen: prosentkoding, case, traversal, backslash,
  // null-byte, ugyldig koding og dobbeltkoding. Markør for beskyttet innhold:
  const REGNSKAP_MARKØR = /<title>Regnskap/i;

  let forrige;
  beforeEach(() => {
    forrige = process.env.STATIC_AUTH_ENABLED;
    delete process.env.STATIC_AUTH_ENABLED;
  });
  afterEach(() => {
    if (forrige === undefined) delete process.env.STATIC_AUTH_ENABLED;
    else process.env.STATIC_AUTH_ENABLED = forrige;
  });

  // Stier som MÅ blokkeres uinnlogget (dekoder til en beskyttet side). Alle
  // skal 302 til /konto — aldri servere det beskyttede skallet.
  const blokkeres = [
    '/regnskap%2Ehtml', // encoded dot
    '/regnskap%2ehtml', // encoded dot, lowercase hex
    '/okonomi%2Ehtml', // annen side, encoded dot
    '/REGNSKAP.html', // case (Windows case-ufølsomt filsystem)
    '/regnskap%2EHTML', // encoded dot + uppercase ext
    '/foo/../regnskap.html', // traversal via '..'
    '/./regnskap.html', // '.'-segment
    '/regnskap%5C..%5Cregnskap.html', // backslash-traversal (Windows)
    '/foo%5C..%5Cregnskap.html', // backslash-traversal
  ];
  for (const p of blokkeres) {
    it(`uinnlogget GET ${p} -> IKKE 200 (302 til /konto)`, async () => {
      const res = await viaApp({ path: p });
      expect(res.status).not.toBe(200);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/konto');
      expect(res.body).not.toMatch(REGNSKAP_MARKØR);
    });
  }

  // Ugyldig/utrygg koding -> fail-closed: verken 200 (lekkasje) eller 500
  // (kastende gate). Vi svarer 400.
  const failClosed = [
    '/regnskap%ZZ', // ugyldig prosentkoding (decodeURIComponent kaster)
    '/regnskap%E0%A4%A', // trunkert UTF-8-sekvens (kaster)
    '/regnskap%00.html', // null-byte
    '/regnskap.html%00', // null-byte suffiks
    '/regnskap%2ehtml%00', // encoded dot + null-byte
  ];
  for (const p of failClosed) {
    it(`ugyldig/utrygg koding GET ${p} -> 400, aldri 200/500`, async () => {
      const res = await viaApp({ path: p });
      expect(res.status).toBe(400);
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(500);
      expect(res.body).not.toMatch(REGNSKAP_MARKØR);
    });
  }

  it('dobbeltkoding /regnskap%252Ehtml lekker ikke regnskap (static single-dekoder)', async () => {
    // Bekreftet ved probe: express.static dekoder KUN én gang, så '%252E' blir
    // literal '%2E' i filnavnet -> finnes ikke -> fallback til offentlig
    // index.html. Ingen dekode-løkke i gaten (den ville vært sin egen sårbarhet).
    const res = await viaApp({ path: '/regnskap%252Ehtml' });
    expect(res.body).not.toMatch(REGNSKAP_MARKØR);
  });

  it('trippelkoding /regnskap%25252Ehtml lekker heller ikke', async () => {
    const res = await viaApp({ path: '/regnskap%25252Ehtml' });
    expect(res.body).not.toMatch(REGNSKAP_MARKØR);
  });

  it('admin-cookie GET /regnskap%2Ehtml -> 200 (dekodet til beskyttet side, riktig rolle)', async () => {
    // Med riktig rolle skal den dekodede stien fortsatt tjene siden — porten
    // skal ikke over-blokkere en legitim, autorisert forespørsel.
    const res = await viaApp({ path: '/regnskap%2Ehtml', headers: { Cookie: adminCookie() } });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(REGNSKAP_MARKØR);
  });

  it('STATIC_AUTH_ENABLED=false slår av gaten også for kodede stier -> 200', async () => {
    process.env.STATIC_AUTH_ENABLED = 'false';
    const res = await viaApp({ path: '/regnskap%2Ehtml' });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(REGNSKAP_MARKØR);
  });
});

describe('S1c — ansatt er stengt ute fra admin-skallene, men naar /ansatt', () => {
  // Operator-krav: en ansatt skal KUN ha /ansatt (timeliste + samtale). Admin-
  // dashbordet og de andre stab-/admin-skallene skal 302 til /konto for ansatt.
  let forrige;
  beforeEach(() => {
    forrige = process.env.STATIC_AUTH_ENABLED;
    delete process.env.STATIC_AUTH_ENABLED;
  });
  afterEach(() => {
    if (forrige === undefined) delete process.env.STATIC_AUTH_ENABLED;
    else process.env.STATIC_AUTH_ENABLED = forrige;
  });

  // Sider som naa er admin-only: ansatt-cookie skal 302 til /konto (ikke 200).
  const stengtForAnsatt = [
    '/intranett',
    '/bookinger',
    '/admin-agenda',
    '/kunde-dialog',
    '/admin-innsikt',
    '/admin-kunder',
    '/chat-innboks',
  ];
  for (const p of stengtForAnsatt) {
    it(`ansatt GET ${p} -> 302 til /konto (admin-only)`, async () => {
      const res = await viaApp({ path: p, headers: { Cookie: ansattCookie() } });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/konto');
    });
  }

  it('ansatt GET /ansatt -> 200 (egen side er fortsatt tilgjengelig)', async () => {
    const res = await viaApp({ path: '/ansatt', headers: { Cookie: ansattCookie() } });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html|<!doctype/i);
  });

  it('admin GET /intranett -> 200 (admin beholder dashbordet)', async () => {
    const res = await viaApp({ path: '/intranett', headers: { Cookie: adminCookie() } });
    expect(res.status).toBe(200);
    expect(res.body).toMatch(/<html|<!doctype/i);
  });

  it('admin GET /ansatt -> 200 (admin naar ogsaa ansatt-siden)', async () => {
    const res = await viaApp({ path: '/ansatt', headers: { Cookie: adminCookie() } });
    expect(res.status).toBe(200);
  });
});

describe('F52 — global json-grense (256kb)', () => {
  it('POST med >256kb JSON på en vanlig rute avvises (413)', async () => {
    // ~300 KB body. express.json (256kb) skal kaste PayloadTooLargeError før
    // requesten når ruten -> error-middleware svarer 413.
    const stor = 'a'.repeat(300 * 1024);
    const body = JSON.stringify({ felt: stor });
    const res = await viaApp({
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      body,
    });
    expect(res.status).toBe(413);
  });

  it('POST med liten JSON-body på samme rute passerer parseren (ikke 413)', async () => {
    // Bekrefter at 256kb-grensen ikke er for stram: en normal liten body slipper
    // gjennom parseren og når ruten (uansett hva ruten så svarer).
    const body = JSON.stringify({ epost: 'x@y.no', passord: 'feil' });
    const res = await viaApp({
      path: '/api/auth/login',
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
