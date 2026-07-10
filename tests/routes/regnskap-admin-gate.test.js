// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// Blocker 2 (bolge 98) — /api/regnskap/* er admin-only.
//   FOR: router.use(requireRole('ansatt','admin')) — ansatt saa alles lonn/timer.
//   NAA: router.use(requireRole('admin'))        — ansatt far 403 overalt her.
//
// I tillegg (blocker 1, del i rutene): POST/PATCH /ansatte befolker user_id, og
// en duplikat user_id (UNIQUE, lagt av migrate() i det andre laget) -> 409.
//
// CJS-monster (jf. regnskap-dagsoppgjor.test.js): vi muterer db-singletonen —
// samme ref som routes/regnskap.js holder. requireRole er EKTE; req.user
// injiseres av en test-middleware slik at rolle-gaten testes paa ekte.
const express = require('express');

const db = require('../../db');

const state = { ansatte: [], insertParams: null, updateParams: null, kastDuplikat: false };

db.isConfigured = () => true;

db.one = async (text, params) => {
  if (/INSERT INTO ansatte/i.test(text)) {
    state.insertParams = params;
    if (state.kastDuplikat) { const e = new Error('dup'); e.code = '23505'; throw e; }
    // params: [navn, epost, stilling, timelonn_ore, konto, user_id]
    return {
      id: 10, user_id: params[5], navn: params[0], epost: params[1],
      stilling: params[2], timelonn_ore: params[3], konto: params[4], aktiv: true,
    };
  }
  if (/UPDATE ansatte/i.test(text)) {
    state.updateParams = params;
    if (state.kastDuplikat) { const e = new Error('dup'); e.code = '23505'; throw e; }
    return {
      id: params[params.length - 1], user_id: 7, navn: 'Ola', epost: null,
      stilling: null, timelonn_ore: 20000, konto: 5000, aktiv: true,
    };
  }
  return null;
};

db.query = async (text) => {
  if (/INSERT INTO audit_log/i.test(text)) return { rows: [] };
  if (/FROM ansatte/i.test(text)) return { rows: state.ansatte };
  return { rows: [] };
};

const router = require('../../routes/regnskap');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/regnskap', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function reqJson(srv, method, sti, body) {
  const { port } = srv.address();
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, opts);
  let b = null;
  try { b = await r.json(); } catch { b = null; }
  return { status: r.status, body: b };
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Sjefen' };
const ANSATT = { id: 2, rolle: 'ansatt', navn: 'Ola' };

function nullstill() {
  state.ansatte = [];
  state.insertParams = null;
  state.updateParams = null;
  state.kastDuplikat = false;
}

// Ruter-nivaa gate: ansatt skal avvises paa ALLE /api/regnskap/*-ruter.
describe('Blocker 2 — /api/regnskap/* er admin-only', () => {
  const ruter = [
    ['GET', '/api/regnskap/timer?maaned=2026-07'],
    ['GET', '/api/regnskap/lonn?maaned=2026-07'],
    ['GET', '/api/regnskap/ansatte'],
    ['GET', '/api/regnskap/poster?maaned=2026-07'],
    ['GET', '/api/regnskap/oversikt?maaned=2026-07'],
  ];

  for (const [method, sti] of ruter) {
    it(`ansatt -> 403 paa ${method} ${sti.split('?')[0]}`, async () => {
      nullstill();
      const srv = await lytt(lagApp(ANSATT));
      try {
        const res = await reqJson(srv, method, sti);
        expect(res.status).toBe(403);
      } finally { srv.close(); }
    });
  }

  it('admin -> 200 paa GET /ansatte (uendret tilgang)', async () => {
    nullstill();
    state.ansatte = [{ id: 1, user_id: null, navn: 'A', epost: null, stilling: null, timelonn_ore: 0, konto: 5000, aktiv: true }];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'GET', '/api/regnskap/ansatte');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    } finally { srv.close(); }
  });

  it('uinnlogget -> 401 (requireRole uten req.user)', async () => {
    nullstill();
    const srv = await lytt(lagApp(null));
    try {
      const res = await reqJson(srv, 'GET', '/api/regnskap/ansatte');
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });
});

// Blocker 1 (del i rutene): user_id-kobling ved POST/PATCH /ansatte.
describe('POST/PATCH /ansatte — user_id-kobling', () => {
  it('POST /ansatte med user_id lagrer koblingen', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/ansatte', {
        navn: 'Kari', timelonn_ore: 25000, user_id: 42,
      });
      expect(res.status).toBe(201);
      expect(res.body.ansatt.user_id).toBe(42);
      // INSERT far user_id som 6. parameter.
      expect(state.insertParams[5]).toBe(42);
    } finally { srv.close(); }
  });

  it('POST /ansatte uten user_id -> null (ukoblet)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/ansatte', {
        navn: 'Per', timelonn_ore: 20000,
      });
      expect(res.status).toBe(201);
      expect(state.insertParams[5]).toBeNull();
    } finally { srv.close(); }
  });

  it('POST /ansatte med ugyldig user_id -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/ansatte', {
        navn: 'Feil', timelonn_ore: 20000, user_id: 'abc',
      });
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('POST /ansatte med duplikat user_id -> 409', async () => {
    nullstill();
    state.kastDuplikat = true;
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/ansatte', {
        navn: 'Dup', timelonn_ore: 20000, user_id: 42,
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/allerede koblet/i);
    } finally { srv.close(); }
  });

  it('PATCH /ansatte/:id kan sette user_id', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'PATCH', '/api/regnskap/ansatte/5', { user_id: 7 });
      expect(res.status).toBe(200);
      // Foerste param er user_id-verdien, siste er id (WHERE).
      expect(state.updateParams[0]).toBe(7);
    } finally { srv.close(); }
  });

  it('PATCH /ansatte/:id kan nullstille user_id (koble fra)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'PATCH', '/api/regnskap/ansatte/5', { user_id: null });
      expect(res.status).toBe(200);
      expect(state.updateParams[0]).toBeNull();
    } finally { srv.close(); }
  });

  it('PATCH /ansatte/:id med duplikat user_id -> 409', async () => {
    nullstill();
    state.kastDuplikat = true;
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'PATCH', '/api/regnskap/ansatte/5', { user_id: 7 });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/allerede koblet/i);
    } finally { srv.close(); }
  });

  it('ansatt -> 403 paa POST /ansatte (gate foran user_id-logikken)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/ansatte', {
        navn: 'X', timelonn_ore: 1, user_id: 9,
      });
      expect(res.status).toBe(403);
      expect(state.insertParams).toBeNull(); // naadde aldri INSERT
    } finally { srv.close(); }
  });
});
