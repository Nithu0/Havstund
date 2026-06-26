// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
//
// HULL 1 — service-token -> 'agent'-rolle på nettsiden.
// Beviser:
//  (a) gyldig WEBSITE_SERVICE_TOKEN -> 200/agent-tilgang på en brain-brukt rute
//  (b) feil/manglende token -> 401/403
//  (c) tom env (WEBSITE_SERVICE_TOKEN uset) -> ingen tilgang (fail-closed)
//  + agent slipper KUN gjennom på allowlistede ruter (ikke-allowlistet -> 403)
//
// CJS-mønster (jf. brain-shim.test.js / hours.test.js): vi muterer db-singletonen
// og monterer ekte ruter + agent-middleware på en fersk express-app.
const express = require('express');

const db = require('../../db');
const { agentAuth, agentGate } = require('../../lib/agent-auth');

const TOKEN = 'super-hemmelig-service-token-123';

// Stub DB: hours GET (brain-brukt, krever ingen rolle for lesing) + en
// requireRole-gatet skrive-rute (hours PUT). Holder det minimalt.
db.isConfigured = () => true;
db.one = async (text, params) => {
  if (/INSERT INTO business_hours/i.test(text)) {
    return { ukedag: params[0], apner: params[1], stenger: params[2], stengt: params[3] };
  }
  return null;
};
db.query = async (text) => {
  if (/FROM business_hours/i.test(text)) return { rows: [{ ukedag: 0, apner: '09:00', stenger: '17:00', stengt: false }] };
  if (/FROM closed_dates/i.test(text)) return { rows: [] };
  if (/FROM content/i.test(text)) return { rows: [] };
  return { rows: [] };
};

function lagApp() {
  // Frisk require av ruter så de plukker den muterte db-singletonen.
  const app = express();
  app.use(express.json());
  app.use(agentAuth);
  app.use(agentGate);
  app.use('/api/hours', require('../../routes/hours'));
  app.use('/api/admin', require('../../routes/admin'));
  return app;
}

function lytt(app) {
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
async function call(srv, metode, sti, token) {
  const { port } = srv.address();
  const headers = { 'content-type': 'application/json' };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, {
    method: metode,
    headers,
    body: metode === 'GET' ? undefined : JSON.stringify({ apner: '08:00', stenger: '16:00', stengt: false }),
  });
  let b = null; try { b = await r.json(); } catch { b = null; }
  return { status: r.status, body: b };
}

beforeEach(() => { process.env.WEBSITE_SERVICE_TOKEN = TOKEN; });
afterEach(() => { delete process.env.WEBSITE_SERVICE_TOKEN; });

describe('HULL 1 — agent service-token', () => {
  it('(a) gyldig token -> 200 på brain-brukt skrive-rute (PUT /api/hours/:ukedag)', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await call(srv, 'PUT', '/api/hours/0', TOKEN);
      expect(res.status).toBe(200);
      expect(res.body && res.body.ukedag).toBe(0);
    } finally { srv.close(); }
  });

  it('(a) gyldig token -> 200 på brain-brukt lese-rute (GET /api/hours)', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await call(srv, 'GET', '/api/hours', TOKEN);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.hours)).toBe(true);
    } finally { srv.close(); }
  });

  it('(b) manglende token -> 401 (requireRole: ikke innlogget)', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await call(srv, 'PUT', '/api/hours/0'); // ingen Authorization
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });

  it('(b) feil token -> 401 (ingen agent-principal settes)', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await call(srv, 'PUT', '/api/hours/0', 'feil-token');
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });

  it('(c) tom env (uset) -> ingen tilgang selv med "riktig" token (fail-closed)', async () => {
    delete process.env.WEBSITE_SERVICE_TOKEN;
    const srv = await lytt(lagApp());
    try {
      const res = await call(srv, 'PUT', '/api/hours/0', TOKEN);
      expect(res.status).toBe(401); // token-stien er av; ingen principal
    } finally { srv.close(); }
  });

  it('(c) tom streng env -> ingen tilgang (ingen bypass på tom streng)', async () => {
    process.env.WEBSITE_SERVICE_TOKEN = '';
    const srv = await lytt(lagApp());
    try {
      const res = await call(srv, 'PUT', '/api/hours/0', '');
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });

  it('agent KUN på allowlistede ruter: ikke-allowlistet rute -> 403', async () => {
    // /api/admin/stats er IKKE i adapter-allowlista (kun /api/admin/content er).
    const srv = await lytt(lagApp());
    try {
      const res = await call(srv, 'GET', '/api/admin/stats', TOKEN);
      expect(res.status).toBe(403); // agentGate blokkerer før handler
    } finally { srv.close(); }
  });

  it('allowlistet admin-rute: GET /api/admin/content -> 200', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await call(srv, 'GET', '/api/admin/content', TOKEN);
      expect(res.status).toBe(200);
    } finally { srv.close(); }
  });
});
