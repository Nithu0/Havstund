// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester POST /api/auth/register: happy-path 201, 409 ved eksisterende e-post
// (forhaandssjekk) OG 409 (ikke 500) ved unik-brudd 23505 fra en samtidig
// registrering (race). CJS-monster: vi muterer db-singletonen (samme ref som
// routes/auth.js holder via require('../db')).
const express = require('express');

const db = require('../../db');

const state = {
  epostFinnes: false,   // svar paa forhaands-SELECT
  insertThrows: null,   // feil som INSERT INTO users skal kaste (f.eks. 23505)
};

db.one = async (text, params) => {
  if (/SELECT id FROM users WHERE epost/i.test(text)) {
    return state.epostFinnes ? { id: 99 } : null;
  }
  if (/INSERT INTO users/i.test(text)) {
    if (state.insertThrows) throw state.insertThrows;
    return { id: 5, navn: params[0], epost: params[1], rolle: 'kunde' };
  }
  return null;
};

const router = require('../../routes/auth');

function lagApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function post(srv, body) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await r.json(); } catch { /* tomt */ }
  return { status: r.status, data };
}

const GYLDIG = { navn: 'Ola Nordmann', epost: 'ola@havstund.no', passord: 'passord123' };

describe('POST /api/auth/register', () => {
  beforeEach(() => {
    state.epostFinnes = false;
    state.insertThrows = null;
  });

  it('oppretter kunde og svarer 201', async () => {
    const srv = await lytt(lagApp());
    try {
      const r = await post(srv, GYLDIG);
      expect(r.status).toBe(201);
      expect(r.data.user).toMatchObject({ epost: 'ola@havstund.no', rolle: 'kunde' });
    } finally { srv.close(); }
  });

  it('409 naar e-posten finnes (forhaandssjekk)', async () => {
    state.epostFinnes = true;
    const srv = await lytt(lagApp());
    try {
      const r = await post(srv, GYLDIG);
      expect(r.status).toBe(409);
    } finally { srv.close(); }
  });

  it('409 (ikke 500) ved unik-brudd 23505 fra samtidig registrering (race)', async () => {
    // Forhaandssjekken passerer, men INSERT taper racen -> Postgres 23505.
    const e = new Error('duplicate key value violates unique constraint');
    e.code = '23505';
    state.insertThrows = e;
    const srv = await lytt(lagApp());
    try {
      const r = await post(srv, GYLDIG);
      expect(r.status).toBe(409);
      expect(r.data.error).toMatch(/allerede registrert/i);
    } finally { srv.close(); }
  });

  it('400 ved ugyldig e-post', async () => {
    const srv = await lytt(lagApp());
    try {
      const r = await post(srv, { navn: 'Ola', epost: 'ikke-epost', passord: 'passord123' });
      expect(r.status).toBe(400);
    } finally { srv.close(); }
  });
});
