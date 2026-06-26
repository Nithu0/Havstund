// describe/it/expect er globale (vitest.config.js -> globals: true).
// vi.mock fanger ikke CJS require() her, saa vi muterer db-singletonen
// (samme objekt-referanse som routes/customers.js holder via require('../db')).
const express = require('express');

const db = require('../../db');

// Fanger siste db.query-kall saa vi kan verifisere parametrisering.
const state = {
  configured: true,
  sisteText: null,
  sisteParams: null,
  rows: [],
};

db.isConfigured = () => state.configured;

db.query = async (text, params) => {
  state.sisteText = text;
  state.sisteParams = params;
  return { rows: state.rows };
};

const router = require('../../routes/customers');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/customers', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function get(srv, sti) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}/api/customers${sti}`);
  let data = null;
  try { data = await r.json(); } catch { /* tomt */ }
  return { status: r.status, data };
}

const ANSATT = { id: 1, rolle: 'ansatt', navn: 'Ansatt' };
const KUNDE = { id: 2, rolle: 'kunde', navn: 'Kunde' };

describe('routes/customers — /search parametrisering + tilgang', () => {
  beforeEach(() => {
    state.configured = true;
    state.sisteText = null;
    state.sisteParams = null;
    state.rows = [{ id: 7, navn: 'Ola Nordmann', epost: 'ola@x.no', rolle: 'kunde', opprettet: null }];
  });

  it('sender soeketekst som parameter, ALDRI inn i SQL-teksten (ingen injection)', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      // Klassisk injection-forsoek: ville droppet tabellen hvis interpolert.
      const ondsinnet = "x'; DROP TABLE users; --";
      const r = await get(srv, '/search?q=' + encodeURIComponent(ondsinnet));
      expect(r.status).toBe(200);

      // SQL-teksten skal vaere statisk: ingen del av brukerinput finnes i den.
      expect(state.sisteText).not.toContain('DROP TABLE');
      expect(state.sisteText).not.toContain(ondsinnet);
      expect(state.sisteText).toMatch(/\$1/);

      // Verdien skal ligge i params, wildcard-pakket, med metategn escapet.
      expect(Array.isArray(state.sisteParams)).toBe(true);
      expect(state.sisteParams[0]).toContain(ondsinnet);
      expect(state.sisteParams[0].startsWith('%')).toBe(true);
      expect(state.sisteParams[0].endsWith('%')).toBe(true);
    } finally { srv.close(); }
  });

  it('escaper LIKE-metategn (% _) saa de tolkes bokstavelig', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const r = await get(srv, '/search?q=' + encodeURIComponent('50%_a'));
      expect(r.status).toBe(200);
      // % og _ i input skal vaere escapet med backslash i parameteren.
      expect(state.sisteParams[0]).toContain('50\\%\\_a');
    } finally { srv.close(); }
  });

  it('tom q gir 400 og kjoerer ingen query', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const r = await get(srv, '/search?q=' + encodeURIComponent('   '));
      expect(r.status).toBe(400);
      expect(state.sisteText).toBeNull();
    } finally { srv.close(); }
  });

  it('kunde-rolle faar 403 (krever ansatt/admin)', async () => {
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await get(srv, '/search?q=ola');
      expect(r.status).toBe(403);
    } finally { srv.close(); }
  });

  it('uten innlogging faar 401', async () => {
    const srv = await lytt(lagApp(null));
    try {
      const r = await get(srv, '/search?q=ola');
      expect(r.status).toBe(401);
    } finally { srv.close(); }
  });
});
