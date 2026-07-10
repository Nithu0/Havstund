// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// Bolge 98-justering — /api/personalchat (ansatt<->admin chat, ADMIN-siden).
//
// Denne suiten beviser asymmetrien mot ansatt-siden (routes/min.js):
//   * ADMIN-ONLY: en ansatt naar ALDRI /api/personalchat -> 403.
//   * avsender settes ALLTID server-side ('admin') — aldri fra klient.
//   * ansatt_id tas fra URL (:ansattId) og valideres mot ansatte, ikke fra body.
//   * traad-oversikten teller ANSATTES uleste meldinger.
//
// CJS-monster (jf. regnskap-admin-gate.test.js): vi muterer db-singletonen —
// samme ref som routes/personalchat.js holder. requireRole er EKTE; req.user
// injiseres av en test-middleware slik at rolle-gaten testes paa ekte.
const express = require('express');

const db = require('../../db');

const state = {
  ansatteById: {},        // id -> rad
  oversikt: [],           // rader traad-oversikten returnerer
  traad: [],              // meldinger i en traad
  insertParams: null,     // [ansatt_id, tekst]
  updateLest: null,       // UPDATE ... lest-params
};

function nullstill() {
  state.ansatteById = { 100: { id: 100, navn: 'Ola', stilling: 'Guide' } };
  state.oversikt = [];
  state.traad = [];
  state.insertParams = null;
  state.updateLest = null;
}

db.isConfigured = () => true;

db.one = async (text, params) => {
  // SELECT ... FROM ansatte WHERE id = $1 (validering)
  if (/FROM ansatte\s+WHERE id/i.test(text)) {
    return state.ansatteById[params[0]] || null;
  }
  // INSERT INTO personal_meldinger — avsender bindes til 'admin' server-side.
  if (/INSERT INTO personal_meldinger/i.test(text)) {
    state.insertParams = params; // [ansatt_id, tekst]
    return { id: 800, ansatt_id: params[0], avsender: 'admin', tekst: params[1], lest: false };
  }
  return null;
};

db.query = async (text, params) => {
  if (/INSERT INTO audit_log/i.test(text)) return { rows: [] };
  if (/UPDATE personal_meldinger/i.test(text)) {
    state.updateLest = params;
    return { rows: [] };
  }
  // Traad-oversikt (LATERAL) — SELECT ... FROM ansatte a LEFT JOIN LATERAL ...
  if (/FROM ansatte a[\s\S]*LATERAL/i.test(text)) {
    return { rows: state.oversikt };
  }
  // Full traad
  if (/FROM personal_meldinger/i.test(text)) {
    return { rows: state.traad };
  }
  return { rows: [] };
};

const router = require('../../routes/personalchat');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/personalchat', router);
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
const KUNDE = { id: 9, rolle: 'kunde', navn: 'Fremmed' };

// ===================== ADMIN-ONLY (asymmetri mot /api/min) =====================

describe('personalchat — admin-only', () => {
  const ruter = [
    ['GET', '/api/personalchat'],
    ['GET', '/api/personalchat/100'],
    ['POST', '/api/personalchat/100'],
  ];
  for (const [method, sti] of ruter) {
    it(`ansatt -> 403 paa ${method} ${sti}`, async () => {
      nullstill();
      const srv = await lytt(lagApp(ANSATT));
      try {
        const res = await reqJson(srv, method, sti, method === 'POST' ? { tekst: 'x' } : undefined);
        expect(res.status).toBe(403);
        expect(state.insertParams).toBeNull(); // naadde aldri INSERT
      } finally { srv.close(); }
    });
  }

  it('kunde -> 403', async () => {
    nullstill();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const res = await reqJson(srv, 'GET', '/api/personalchat');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });

  it('uinnlogget -> 401', async () => {
    nullstill();
    const srv = await lytt(lagApp(null));
    try {
      const res = await reqJson(srv, 'GET', '/api/personalchat');
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });
});

// ===================== TRAAD-OVERSIKT + SVAR =====================

describe('personalchat — oversikt og svar', () => {
  it('GET / -> traad-oversikt m/ uleste-teller', async () => {
    nullstill();
    state.oversikt = [
      { ansatt_id: 100, navn: 'Ola', stilling: 'Guide', siste_tekst: 'Hei', siste_avsender: 'ansatt', siste_tid: 't', uleste: 2 },
    ];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'GET', '/api/personalchat');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].uleste).toBe(2);
    } finally { srv.close(); }
  });

  it('GET /:ansattId -> full traad, markerer ansattes meldinger lest', async () => {
    nullstill();
    state.traad = [
      { id: 1, ansatt_id: 100, avsender: 'ansatt', tekst: 'Hei', lest: false, opprettet: 't' },
    ];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'GET', '/api/personalchat/100');
      expect(res.status).toBe(200);
      expect(res.body.ansatt.id).toBe(100);
      expect(Array.isArray(res.body.meldinger)).toBe(true);
      // UPDATE ... lest filtrert paa den valgte ansatt_id (100).
      expect(state.updateLest[0]).toBe(100);
    } finally { srv.close(); }
  });

  it('GET /:ansattId paa ukjent ansatt -> 404', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'GET', '/api/personalchat/999');
      expect(res.status).toBe(404);
    } finally { srv.close(); }
  });

  it('POST /:ansattId -> lagres med avsender=admin (aldri fra klient)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/personalchat/100', {
        tekst: 'Godkjent, bra jobba', avsender: 'ansatt', ansatt_id: 200,
      });
      expect(res.status).toBe(201);
      expect(res.body.melding.avsender).toBe('admin');
      // INSERT-param[0] = ansatt_id fra URL (100), IKKE body-verdien 200.
      expect(state.insertParams[0]).toBe(100);
      // avsender er SQL-konstant — klientens 'ansatt' naar aldri params.
      expect(state.insertParams).not.toContain('ansatt');
    } finally { srv.close(); }
  });

  it('POST /:ansattId paa ukjent ansatt -> 404', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/personalchat/999', { tekst: 'Hei' });
      expect(res.status).toBe(404);
      expect(state.insertParams).toBeNull();
    } finally { srv.close(); }
  });

  it('POST /:ansattId med tom tekst -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/personalchat/100', { tekst: '  ' });
      expect(res.status).toBe(400);
      expect(state.insertParams).toBeNull();
    } finally { srv.close(); }
  });

  it('POST /:ansattId med ugyldig id -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/personalchat/abc', { tekst: 'Hei' });
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });
});
