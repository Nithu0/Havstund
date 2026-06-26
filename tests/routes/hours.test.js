// describe/it/expect er globale (vitest.config.js -> globals: true)
// Tester /api/hours:
//  - GET /        -> { hours, closed } paa offentlig form (ingen auth)
//  - PUT /:ukedag -> 0-6 gyldig, utenfor -> 400, ikke-tall -> 400; rolle-gating
// CJS-monster (jf. insights.test.js): vi muterer db-singletonen — samme ref
// som routes/hours.js holder. vi.mock fanger ikke require() her.
const express = require('express');

const db = require('../../db');

// Styrer hva db returnerer per kall basert paa SQL-teksten.
const state = { hours: [], closed: [], puttet: null };

db.isConfigured = () => true;
db.query = async (text, params) => {
  if (/FROM business_hours/i.test(text)) return { rows: state.hours };
  if (/FROM closed_dates/i.test(text)) return { rows: state.closed };
  return { rows: [] };
};
db.one = async (text, params) => {
  if (/INSERT INTO business_hours/i.test(text)) {
    state.puttet = params;
    return { ukedag: params[0], apner: params[1], stenger: params[2], stengt: params[3] };
  }
  return null;
};

const router = require('../../routes/hours');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/hours', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function reqJson(srv, sti, opts) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, opts);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Sjef' };

describe('GET /api/hours', () => {
  it('returnerer { hours, closed } paa offentlig form (ingen auth)', async () => {
    state.hours = [
      { ukedag: 0, apner: '10:00:00', stenger: '16:00:00', stengt: false },
      { ukedag: 6, apner: null, stenger: null, stengt: true },
    ];
    state.closed = [{ dato: '2026-12-24', grunn: 'Julaften' }];
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await reqJson(srv, '/api/hours');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.hours)).toBe(true);
      expect(Array.isArray(res.body.closed)).toBe(true);
      expect(res.body.hours).toHaveLength(2);
      expect(res.body.hours[0].ukedag).toBe(0);
      expect(res.body.closed[0]).toMatchObject({ dato: '2026-12-24', grunn: 'Julaften' });
    } finally { srv.close(); }
  });
});

describe('PUT /api/hours/:ukedag (validering 0-6)', () => {
  function put(srv, ukedag, kropp) {
    return reqJson(srv, `/api/hours/${ukedag}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(kropp),
    });
  }

  it('godtar ukedag 0 og 6 (grenser)', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const a = await put(srv, 0, { apner: '10:00', stenger: '16:00', stengt: false });
      expect(a.status).toBe(200);
      expect(a.body.ukedag).toBe(0);
      const b = await put(srv, 6, { stengt: true });
      expect(b.status).toBe(200);
      expect(b.body.ukedag).toBe(6);
    } finally { srv.close(); }
  });

  it('avviser ukedag 7 og -1 og ikke-tall med 400', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      expect((await put(srv, 7, {})).status).toBe(400);
      expect((await put(srv, -1, {})).status).toBe(400);
      expect((await put(srv, 'man', {})).status).toBe(400);
    } finally { srv.close(); }
  });

  it('avviser ugyldig tid-format med 400', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await put(srv, 2, { apner: '25:00' });
      expect(r.status).toBe(400);
    } finally { srv.close(); }
  });

  it('rolle-gating: 401 uten innlogging, 403 for kunde', async () => {
    const anon = await lytt(lagApp(undefined));
    try {
      expect((await put(anon, 1, { stengt: true })).status).toBe(401);
    } finally { anon.close(); }
    const kunde = await lytt(lagApp({ id: 9, rolle: 'kunde', navn: 'Per' }));
    try {
      expect((await put(kunde, 1, { stengt: true })).status).toBe(403);
    } finally { kunde.close(); }
  });
});
