// describe/it/expect/vi er globale (vitest.config.js -> globals: true).
// vi.mock fanger ikke CJS require() her, saa vi muterer db-singletonen
// (samme objekt-referanse som routes/staff.js holder via require('../db')).
const express = require('express');
const speakeasy = require('speakeasy');

const db = require('../../db');

// In-memory tilstand for db-stubben.
const state = {
  configured: true,
  user: null,        // gjeldende users-rad for id=1
  inserts: [],       // INSERT INTO reset_tokens-kall
  updates: [],       // UPDATE users-kall
  epostFinnes: false,
};

db.isConfigured = () => state.configured;

db.one = async (text, params) => {
  if (/SELECT id FROM users WHERE epost/i.test(text)) {
    return state.epostFinnes ? { id: 99 } : null;
  }
  if (/INSERT INTO users/i.test(text)) {
    return {
      id: 5, navn: params[0], epost: params[1], rolle: params[3], totp_enabled: false,
    };
  }
  if (/SELECT totp_secret FROM users/i.test(text)) {
    return { totp_secret: state.user ? state.user.totp_secret : null };
  }
  if (/UPDATE users SET rolle/i.test(text)) {
    if (!state.user || !['ansatt', 'admin'].includes(state.user.rolle)) return null;
    state.user.rolle = 'kunde';
    return { ...state.user };
  }
  return null;
};

db.query = async (text, params) => {
  if (/INSERT INTO reset_tokens/i.test(text)) {
    state.inserts.push(params);
    return { rows: [] };
  }
  if (/UPDATE users SET totp_secret/i.test(text)) {
    state.updates.push(params);
    if (state.user) state.user.totp_secret = params[0];
    return { rows: [] };
  }
  if (/UPDATE users SET totp_enabled=true/i.test(text)) {
    state.updates.push(params);
    if (state.user) state.user.totp_enabled = true;
    return { rows: [] };
  }
  return { rows: [] };
};

const router = require('../../routes/staff');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/staff', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function post(srv, sti, body) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}/api/staff${sti}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await r.json(); } catch { /* tomt */ }
  return { status: r.status, data };
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Admin' };

describe('routes/staff — 2FA verify roundtrip', () => {
  beforeEach(() => {
    state.inserts.length = 0;
    state.updates.length = 0;
    state.epostFinnes = false;
    state.configured = true;
    state.user = {
      id: 1, navn: 'Admin', rolle: 'admin', totp_secret: null, totp_enabled: false,
    };
  });

  it('setup lagrer secret, og en gyldig TOTP-kode aktiverer 2FA (roundtrip)', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const setup = await post(srv, '/2fa/setup', {});
      expect(setup.status).toBe(200);
      expect(typeof setup.data.secret).toBe('string');
      expect(setup.data.qr).toMatch(/^data:image\/png;base64,/);
      // Secret ble lagret paa brukeren.
      expect(state.user.totp_secret).toBe(setup.data.secret);
      expect(state.user.totp_enabled).toBe(false);

      // Generer en gyldig kode fra samme secret og verifiser.
      const kode = speakeasy.totp({ secret: setup.data.secret, encoding: 'base32' });
      const verify = await post(srv, '/2fa/verify', { kode });
      expect(verify.status).toBe(200);
      expect(verify.data).toEqual({ ok: true, totp_enabled: true });
      expect(state.user.totp_enabled).toBe(true);
    } finally { srv.close(); }
  });

  it('feil engangskode gir 403 og aktiverer ikke 2FA', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      await post(srv, '/2fa/setup', {});
      const verify = await post(srv, '/2fa/verify', { kode: '000000' });
      expect(verify.status).toBe(403);
      expect(state.user.totp_enabled).toBe(false);
    } finally { srv.close(); }
  });

  it('verify uten oppsett gir 400', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const verify = await post(srv, '/2fa/verify', { kode: '123456' });
      expect(verify.status).toBe(400);
    } finally { srv.close(); }
  });
});

describe('routes/staff — invite + deactivate', () => {
  beforeEach(() => {
    state.inserts.length = 0;
    state.updates.length = 0;
    state.epostFinnes = false;
    state.configured = true;
    state.user = { id: 5, navn: 'Ny', rolle: 'ansatt', totp_secret: null, totp_enabled: false };
  });

  it('invite oppretter bruker og engangs-token i reset_tokens', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/invite', { epost: 'ny@havstund.no', rolle: 'ansatt' });
      expect(r.status).toBe(201);
      expect(r.data.user.rolle).toBe('ansatt');
      expect(typeof r.data.token).toBe('string');
      // Token ble lagret med riktig user_id.
      expect(state.inserts.length).toBe(1);
      expect(state.inserts[0][1]).toBe(5);
    } finally { srv.close(); }
  });

  it('invite med ugyldig rolle gir 400', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/invite', { epost: 'ny@havstund.no', rolle: 'kunde' });
      expect(r.status).toBe(400);
      expect(state.inserts.length).toBe(0);
    } finally { srv.close(); }
  });

  it('invite paa eksisterende e-post gir 409', async () => {
    state.epostFinnes = true;
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/invite', { epost: 'finnes@havstund.no', rolle: 'ansatt' });
      expect(r.status).toBe(409);
    } finally { srv.close(); }
  });

  it('deactivate degraderer ansatt til kunde', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/5/deactivate', {});
      expect(r.status).toBe(200);
      expect(r.data.user.rolle).toBe('kunde');
    } finally { srv.close(); }
  });

  it('deactivate kan ikke ramme deg selv (400)', async () => {
    const srv = await lytt(lagApp({ id: 5, rolle: 'admin', navn: 'Selv' }));
    try {
      const r = await post(srv, '/5/deactivate', {});
      expect(r.status).toBe(400);
    } finally { srv.close(); }
  });
});
