// describe/it/expect er globale (vitest.config.js -> globals: true).
// Driver rate-limiterne i lib/security.js ende-til-ende: bygger en minimal
// Express-app, kjører applySecurity(app), monterer dummy-handlere og fyrer
// N+1 forespørsler mot ekte HTTP (app.listen(0) + fetch), likt de andre
// rute-testene. Ingen supertest i prosjektet.

const express = require('express');
const { applySecurity } = require('../../lib/security');

// --- env-snapshot: hver test kan sette RATE_LIMIT_*-knapper uten å lekke ---
const ENV_KEYS = [
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_KUNDE_MAX',
  'RATE_LIMIT_KUNDE_WINDOW_MS',
  'RATE_LIMIT_PWCHANGE_MAX',
  'RATE_LIMIT_PWCHANGE_WINDOW_MS',
  'RATE_LIMIT_GLOBAL_MAX',
  'RATE_LIMIT_GLOBAL_WINDOW_MS',
];
let snapshot;
beforeEach(() => {
  snapshot = {};
  for (const k of ENV_KEYS) snapshot[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (snapshot[k] === undefined) delete process.env[k];
    else process.env[k] = snapshot[k];
  }
});

// Bygger app med gitt env, kjører applySecurity, monterer dummy-handlere som
// svarer 200. En passert forespørsel -> 200, en blokkert -> 429.
function byggApp(env = {}) {
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  const app = express();
  applySecurity(app); // setter trust proxy + monterer limiterne
  app.use(express.json());
  const ok = (_req, res) => res.json({ ok: true });
  app.post('/api/chat/thread', ok);
  app.get('/api/chat/threads', ok);
  app.post('/api/meldinger', ok);
  app.post('/api/auth/change-password', ok);
  app.all('/api/udekket', ok); // rute uten spesifikk limiter -> kun backstop
  return app;
}

function lytt(app) {
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
}

async function req(srv, sti, metode = 'POST') {
  const { port } = srv.address();
  const opts = { method: metode };
  if (metode === 'POST') {
    opts.headers = { 'content-type': 'application/json' };
    opts.body = '{}';
  }
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, opts);
  return r.status;
}

// Fyrer n forespørsler sekvensielt, returnerer array av statuskoder.
async function fyr(srv, sti, n, metode = 'POST') {
  const koder = [];
  for (let i = 0; i < n; i++) koder.push(await req(srv, sti, metode));
  return koder;
}

describe('rate limiting — kundevendte skjemaer (chat + meldinger)', () => {
  it('POST /api/chat gir 429 etter at grensen er nådd', async () => {
    // Lav kunde-grense, romslig backstop så den ikke forstyrrer.
    const srv = await lytt(byggApp({ RATE_LIMIT_KUNDE_MAX: 2, RATE_LIMIT_GLOBAL_MAX: 1000 }));
    try {
      const koder = await fyr(srv, '/api/chat/thread', 3);
      expect(koder.slice(0, 2)).toEqual([200, 200]);
      expect(koder[2]).toBe(429);
    } finally { srv.close(); }
  });

  it('POST /api/meldinger deler samme kunde-bøtte', async () => {
    const srv = await lytt(byggApp({ RATE_LIMIT_KUNDE_MAX: 2, RATE_LIMIT_GLOBAL_MAX: 1000 }));
    try {
      const koder = await fyr(srv, '/api/meldinger', 3);
      expect(koder[2]).toBe(429);
    } finally { srv.close(); }
  });

  it('GET mot chat rammes IKKE av kunde-limiteren (kun POST)', async () => {
    const srv = await lytt(byggApp({ RATE_LIMIT_KUNDE_MAX: 1, RATE_LIMIT_GLOBAL_MAX: 1000 }));
    try {
      const koder = await fyr(srv, '/api/chat/threads', 3, 'GET');
      expect(koder).toEqual([200, 200, 200]);
    } finally { srv.close(); }
  });
});

describe('rate limiting — passordbytte (streng)', () => {
  it('POST /api/auth/change-password gir 429 etter grensen', async () => {
    const srv = await lytt(byggApp({ RATE_LIMIT_PWCHANGE_MAX: 2, RATE_LIMIT_GLOBAL_MAX: 1000 }));
    try {
      const koder = await fyr(srv, '/api/auth/change-password', 3);
      expect(koder.slice(0, 2)).toEqual([200, 200]);
      expect(koder[2]).toBe(429);
    } finally { srv.close(); }
  });
});

describe('rate limiting — global backstop', () => {
  it('udekket /api-rute får 429 fra backstop', async () => {
    // Spesifikke grenser høye, backstop lav -> backstop er det som slår til.
    const srv = await lytt(byggApp({ RATE_LIMIT_GLOBAL_MAX: 2, RATE_LIMIT_KUNDE_MAX: 1000 }));
    try {
      const koder = await fyr(srv, '/api/udekket', 3);
      expect(koder.slice(0, 2)).toEqual([200, 200]);
      expect(koder[2]).toBe(429);
    } finally { srv.close(); }
  });

  it('en blokkert spesifikk grense brenner ikke backstop-kvoten (rekkefølge)', async () => {
    // Kunde-grense = 1 (blokkerer raskt), backstop = 3. Etter at kunde-limiteren
    // har sendt 429, skal en udekket rute fortsatt ha backstop-kvote igjen:
    // kun de FØRSTE forespørslene (som passerte kunde-limiteren og nådde next())
    // teller mot backstop.
    const srv = await lytt(byggApp({ RATE_LIMIT_KUNDE_MAX: 1, RATE_LIMIT_GLOBAL_MAX: 3 }));
    try {
      // 1 passerer kunde+backstop (backstop-teller=1), 4 blokkeres av kunde (429)
      // og når ALDRI backstop.
      const chat = await fyr(srv, '/api/chat/thread', 5);
      expect(chat[0]).toBe(200);
      expect(chat.slice(1)).toEqual([429, 429, 429, 429]);
      // Backstop har brukt 1 av 3. En udekket rute skal derfor kunne få 2 til (200),
      // deretter 429. Hadde de blokkerte chat-kallene talt mot backstop, ville
      // dette slått ut tidligere.
      const udekket = await fyr(srv, '/api/udekket', 3);
      expect(udekket.slice(0, 2)).toEqual([200, 200]);
      expect(udekket[2]).toBe(429);
    } finally { srv.close(); }
  });
});

describe('rate limiting — full av-knapp', () => {
  it('RATE_LIMIT_ENABLED=false gir ingen 429 uansett volum', async () => {
    const srv = await lytt(byggApp({
      RATE_LIMIT_ENABLED: 'false',
      RATE_LIMIT_KUNDE_MAX: 1,
      RATE_LIMIT_GLOBAL_MAX: 1,
      RATE_LIMIT_PWCHANGE_MAX: 1,
    }));
    try {
      const chat = await fyr(srv, '/api/chat/thread', 5);
      const pw = await fyr(srv, '/api/auth/change-password', 5);
      const any = await fyr(srv, '/api/udekket', 5);
      expect(chat.every((s) => s === 200)).toBe(true);
      expect(pw.every((s) => s === 200)).toBe(true);
      expect(any.every((s) => s === 200)).toBe(true);
    } finally { srv.close(); }
  });
});
