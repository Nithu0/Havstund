// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester /api/crm/customers/:id/profile:
//  - rolle-gating (requireRole): admin -> 200, ansatt -> 403, kunde -> 403,
//    ikke innlogget -> 401. Kundeprofil = PII, derfor kun admin.
// CJS-monster (jf. customers.test.js): vi muterer db-singletonen — samme
// objekt-referanse som routes/crm.js holder via require('../db').
const express = require('express');

const db = require('../../db');

const state = { configured: true, bruker: null, rows: [] };

db.isConfigured = () => state.configured;
db.one = async () => state.bruker;
db.query = async () => ({ rows: state.rows });

const router = require('../../routes/crm');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/crm', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function get(srv, sti) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}/api/crm${sti}`);
  let data = null;
  try { data = await r.json(); } catch { /* tomt */ }
  return { status: r.status, data };
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Admin' };
const ANSATT = { id: 3, rolle: 'ansatt', navn: 'Ansatt' };
const KUNDE = { id: 2, rolle: 'kunde', navn: 'Kunde' };

describe('routes/crm — /customers/:id/profile tilgang (admin-only)', () => {
  beforeEach(() => {
    state.configured = true;
    state.bruker = { id: 7, navn: 'Ola', epost: 'ola@x.no', rolle: 'kunde', opprettet: null };
    state.rows = [];
  });

  it('admin faar 200 og kundeprofil', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await get(srv, '/customers/7/profile');
      expect(r.status).toBe(200);
      expect(r.data.bruker).toMatchObject({ id: 7, epost: 'ola@x.no' });
    } finally { srv.close(); }
  });

  it('ansatt-rolle faar 403 (kundeprofil er admin-only)', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const r = await get(srv, '/customers/7/profile');
      expect(r.status).toBe(403);
    } finally { srv.close(); }
  });

  it('kunde-rolle faar 403', async () => {
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await get(srv, '/customers/7/profile');
      expect(r.status).toBe(403);
    } finally { srv.close(); }
  });

  it('uten innlogging faar 401', async () => {
    const srv = await lytt(lagApp(null));
    try {
      const r = await get(srv, '/customers/7/profile');
      expect(r.status).toBe(401);
    } finally { srv.close(); }
  });
});
