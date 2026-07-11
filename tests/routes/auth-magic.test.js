// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester GET /api/auth/magic/:token — magisk innlogging via engangs-token:
//  - gyldig token -> 302 /min-side + JWT-cookie satt + token konsumert (engangs)
//  - utloept/ukjent token -> 302 /konto, ingen cookie, token IKKE konsumert
//  - engangs: andre bruk av samme token -> ugyldig (302 /konto)
// CJS-monster: vi muterer db-singletonen (samme ref som routes/auth.js holder).
const express = require('express');

const db = require('../../db');
const { COOKIE, userFromToken } = require('../../lib/auth');

// Stateful token-/bruker-"database" for realistisk engangs-semantikk.
const store = { tokens: new Map(), users: new Map(), deletes: [] };

db.isConfigured = () => true;

db.withTransaction = async (fn) => {
  const client = {
    query: async (text, params) => {
      if (/FROM reset_tokens WHERE token = \$1 FOR UPDATE/i.test(text)) {
        const rad = store.tokens.get(params[0]);
        return { rows: rad ? [rad] : [] };
      }
      if (/FROM users WHERE id = \$1/i.test(text)) {
        const u = store.users.get(params[0]);
        return { rows: u ? [u] : [] };
      }
      if (/DELETE FROM reset_tokens WHERE token = \$1/i.test(text)) {
        store.deletes.push(params[0]);
        store.tokens.delete(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  return fn(client);
};

const router = require('../../routes/auth');

function lagApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
}

// redirect: 'manual' -> vi kan inspisere 302 + Location + Set-Cookie.
async function hentMagic(srv, token) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/magic/${token}`, {
    method: 'GET',
    redirect: 'manual',
  });
  return {
    status: r.status,
    location: r.headers.get('location'),
    setCookie: r.headers.get('set-cookie'),
  };
}

const BRUKER = { id: 5, navn: 'Kari', epost: 'kari@x.no', rolle: 'kunde' };

function reset() {
  store.tokens.clear();
  store.users.clear();
  store.deletes.length = 0;
  store.users.set(5, { ...BRUKER });
}

describe('GET /api/auth/magic/:token', () => {
  beforeEach(reset);

  it('gyldig token: 302 /min-side, JWT-cookie satt, token konsumert', async () => {
    const utloper = new Date(Date.now() + 24 * 3600 * 1000); // +1 dag
    store.tokens.set('gyldig-token', { token: 'gyldig-token', user_id: 5, utloper });
    const srv = await lytt(lagApp());
    try {
      const r = await hentMagic(srv, 'gyldig-token');
      expect(r.status).toBe(302);
      expect(r.location).toBe('/min-side');
      // Cookie satt med samme navn som /login (havstund_token).
      expect(r.setCookie).toBeTruthy();
      expect(r.setCookie).toContain(`${COOKIE}=`);
      expect(r.setCookie).toMatch(/httponly/i);
      expect(r.setCookie).toMatch(/samesite=lax/i);
      // Token-innhold matcher brukeren (samme signToken-mekanisme som /login).
      const m = new RegExp(`${COOKIE}=([^;]+)`).exec(r.setCookie);
      const dekodet = userFromToken(decodeURIComponent(m[1]));
      expect(dekodet.id).toBe(5);
      expect(dekodet.rolle).toBe('kunde');
      // ENGANGS: token slettet.
      expect(store.deletes).toContain('gyldig-token');
      expect(store.tokens.has('gyldig-token')).toBe(false);
    } finally { srv.close(); }
  });

  it('utloept token: 302 /konto, ingen cookie, token IKKE konsumert', async () => {
    const utloper = new Date(Date.now() - 1000); // fortid
    store.tokens.set('utloept', { token: 'utloept', user_id: 5, utloper });
    const srv = await lytt(lagApp());
    try {
      const r = await hentMagic(srv, 'utloept');
      expect(r.status).toBe(302);
      expect(r.location).toMatch(/^\/konto/);
      expect(r.setCookie).toBeFalsy();
      // Utloept token skal ikke slettes (ingen konsumering skjedde).
      expect(store.deletes).not.toContain('utloept');
    } finally { srv.close(); }
  });

  it('ukjent token: 302 /konto, ingen cookie', async () => {
    const srv = await lytt(lagApp());
    try {
      const r = await hentMagic(srv, 'finnes-ikke');
      expect(r.status).toBe(302);
      expect(r.location).toMatch(/^\/konto/);
      expect(r.setCookie).toBeFalsy();
    } finally { srv.close(); }
  });

  it('engangs: andre bruk av samme token er ugyldig (302 /konto, ingen cookie)', async () => {
    const utloper = new Date(Date.now() + 24 * 3600 * 1000);
    store.tokens.set('engangs', { token: 'engangs', user_id: 5, utloper });
    const srv = await lytt(lagApp());
    try {
      const forste = await hentMagic(srv, 'engangs');
      expect(forste.status).toBe(302);
      expect(forste.location).toBe('/min-side');
      expect(forste.setCookie).toBeTruthy();

      const andre = await hentMagic(srv, 'engangs');
      expect(andre.status).toBe(302);
      expect(andre.location).toMatch(/^\/konto/);
      expect(andre.setCookie).toBeFalsy();
    } finally { srv.close(); }
  });
});
