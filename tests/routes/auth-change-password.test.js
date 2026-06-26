// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
// Tester Fase 2 #1: POST /api/auth/change-password.
// vi.mock fanger ikke CJS require() i dette oppsettet, saa vi muterer db-singletonen
// (samme objekt-referanse som routes/auth.js holder via require('../db')).
const express = require('express');

// --- In-memory db-stubb pa den ekte db-singletonen ---
const db = require('../../db');
const state = {
  hash: null,        // gjeldende passord_hash for bruker 1
  brukerFinnes: true, // simuler at brukeren finnes
};
const updateCalls = [];

db.one = async (text /* , params */) => {
  if (/SELECT passord_hash FROM users/i.test(text)) {
    return state.brukerFinnes ? { passord_hash: state.hash } : null;
  }
  return null;
};
db.query = async (text, params) => {
  if (/UPDATE users SET passord_hash/i.test(text)) {
    updateCalls.push(params);
    state.hash = params[0]; // [hash, id]
  }
  return { rows: [] };
};

const router = require('../../routes/auth');
const { hashPassword, verifyPassword } = require('../../lib/auth');

// Bygger en app som injiserer en innlogget bruker (id=1) for change-password.
function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/auth', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function post(srv, body, withUser = true) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await r.json(); } catch { /* tomt svar */ }
  return { status: r.status, data };
}

describe('POST /api/auth/change-password', () => {
  beforeEach(async () => {
    updateCalls.length = 0;
    state.brukerFinnes = true;
    state.hash = await hashPassword('gammeltPass1');
  });

  it('403 + ingen UPDATE naar gammelt passord er feil', async () => {
    const srv = await lytt(lagApp({ id: 1, rolle: 'admin', navn: 'Admin' }));
    try {
      const res = await post(srv, { gammelt: 'feilFeilFeil', nytt: 'nyttPassord1' });
      expect(res.status).toBe(403);
      expect(updateCalls.length).toBe(0);
    } finally { srv.close(); }
  });

  it('gyldig gammelt + gyldig nytt -> 200 og passord_hash endres til nytt', async () => {
    const srv = await lytt(lagApp({ id: 1, rolle: 'admin', navn: 'Admin' }));
    try {
      const forHash = state.hash;
      const res = await post(srv, { gammelt: 'gammeltPass1', nytt: 'heltNyttPass2' });
      expect(res.status).toBe(200);
      expect(res.data).toEqual({ ok: true });
      // Hash ble faktisk oppdatert i db-laget
      expect(updateCalls.length).toBe(1);
      expect(state.hash).not.toBe(forHash);
      // Den nye hashen verifiserer mot det nye passordet (og ikke det gamle)
      expect(await verifyPassword('heltNyttPass2', state.hash)).toBe(true);
      expect(await verifyPassword('gammeltPass1', state.hash)).toBe(false);
    } finally { srv.close(); }
  });

  it('400 naar nytt passord er for kort (under MIN_PASSORD_LENGTH=8)', async () => {
    const srv = await lytt(lagApp({ id: 1, rolle: 'admin', navn: 'Admin' }));
    try {
      const res = await post(srv, { gammelt: 'gammeltPass1', nytt: 'kort' });
      expect(res.status).toBe(400);
      expect(updateCalls.length).toBe(0);
    } finally { srv.close(); }
  });

  it('401 naar ikke innlogget (requireAuth blokkerer)', async () => {
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await post(srv, { gammelt: 'gammeltPass1', nytt: 'heltNyttPass2' });
      expect(res.status).toBe(401);
      expect(updateCalls.length).toBe(0);
    } finally { srv.close(); }
  });
});
