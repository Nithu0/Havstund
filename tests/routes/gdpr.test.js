// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester /api/gdpr: rolle-gating (kun admin) + at POST /anonymize sender
// riktig SQL-form (anonymized_at=now(), nullstilt PII, behold aggregat).
// CJS-monster: vi muterer db-singletonen (samme ref som routes/gdpr.js holder).
const express = require('express');

const db = require('../../db');

// Logger alle SQL-kall + styrer svar pa db.one basert pa SQL-teksten.
const calls = [];
const state = { bruker: { id: 7, anonymized_at: null }, failOn: null };

db.isConfigured = () => true;
db.one = async (text, params) => {
  calls.push({ fn: 'one', text, params });
  if (/FROM users WHERE id=\$1/i.test(text)) return state.bruker;
  return null;
};
db.query = async (text, params) => {
  calls.push({ fn: 'query', text, params });
  return { rows: [] };
};
// Anonymiseringen kjorer naa i EN transaksjon -> mock withTransaction slik at
// client.query logges likt. En simulert feil propagerer som en ekte tx ville
// rullet tilbake, saa ingen UPDATE committes uavhengig av de andre.
db.withTransaction = async (fn) => {
  const client = {
    query: async (text, params) => {
      calls.push({ fn: 'query', text, params });
      if (state.failOn && state.failOn.test(text)) throw new Error('simulert DB-feil');
      return { rows: [] };
    },
  };
  return fn(client);
};

const router = require('../../routes/gdpr');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/gdpr', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function post(srv, sti) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, { method: 'POST' });
  let body = null;
  try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Sjef' };

describe('POST /api/gdpr/anonymize/:customerId', () => {
  beforeEach(() => {
    calls.length = 0;
    state.bruker = { id: 7, anonymized_at: null };
    state.failOn = null;
  });

  it('sender riktig anonymiserings-SQL (users + bookings) og svarer ok', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await post(srv, '/api/gdpr/anonymize/7');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, anonymized: 7 });

      const updates = calls.filter((c) => c.fn === 'query' && /^\s*UPDATE/i.test(c.text));
      expect(updates).toHaveLength(3);

      const usersSql = updates.find((c) => /UPDATE users/i.test(c.text));
      expect(usersSql).toBeTruthy();
      expect(usersSql.text).toMatch(/anonymized_at\s*=\s*now\(\)/i);
      expect(usersSql.text).toMatch(/navn\s*=\s*'\[slettet\]'/i);
      expect(usersSql.text).toMatch(/epost\s*=/i);
      // users har ingen tlf-kolonne -> ma IKKE refereres her.
      expect(usersSql.text).not.toMatch(/tlf/i);
      expect(usersSql.params).toEqual([7]);

      const bookingsSql = updates.find((c) => /UPDATE bookings/i.test(c.text));
      expect(bookingsSql).toBeTruthy();
      expect(bookingsSql.text).toMatch(/navn\s*=\s*'\[slettet\]'/i);
      expect(bookingsSql.text).toMatch(/tlf\s*=\s*NULL/i);
      // Aggregat (belop/antall/status) ror vi IKKE.
      expect(bookingsSql.text).not.toMatch(/belop/i);
      expect(bookingsSql.text).not.toMatch(/antall/i);
      expect(bookingsSql.params).toEqual([7]);

      const chatSql = updates.find((c) => /UPDATE chat_threads/i.test(c.text));
      expect(chatSql).toBeTruthy();
      expect(chatSql.text).toMatch(/navn\s*=\s*'\[slettet\]'/i);
      expect(chatSql.text).toMatch(/epost\s*=\s*NULL/i);
      expect(chatSql.params).toEqual([7]);
    } finally { srv.close(); }
  });

  it('ruller tilbake (500) og naar aldri chat_threads nar bookings-UPDATE feiler', async () => {
    state.failOn = /UPDATE bookings/i;
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await post(srv, '/api/gdpr/anonymize/7');
      expect(res.status).toBe(500);
      // bookings feiler -> resten av transaksjonen avbrytes (ekte ROLLBACK er
      // DB-nivaa). chat_threads-UPDATE skal derfor aldri ha kjort.
      const chatSql = calls.find((c) => /UPDATE chat_threads/i.test(c.text || ''));
      expect(chatSql).toBeUndefined();
    } finally { srv.close(); }
  });

  it('409 nar kunden allerede er anonymisert (ingen UPDATE)', async () => {
    state.bruker = { id: 7, anonymized_at: '2026-06-01T00:00:00Z' };
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await post(srv, '/api/gdpr/anonymize/7');
      expect(res.status).toBe(409);
      const updates = calls.filter((c) => /^\s*UPDATE/i.test(c.text || ''));
      expect(updates).toHaveLength(0);
    } finally { srv.close(); }
  });

  it('404 nar kunden ikke finnes', async () => {
    state.bruker = null;
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await post(srv, '/api/gdpr/anonymize/7');
      expect(res.status).toBe(404);
    } finally { srv.close(); }
  });

  it('400 ved ugyldig kunde-id', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await post(srv, '/api/gdpr/anonymize/abc');
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('403 for ansatt-rolle (kun admin)', async () => {
    const srv = await lytt(lagApp({ id: 2, rolle: 'ansatt', navn: 'Ola' }));
    try {
      const res = await post(srv, '/api/gdpr/anonymize/7');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });

  it('401 nar ikke innlogget', async () => {
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await post(srv, '/api/gdpr/anonymize/7');
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });
});
