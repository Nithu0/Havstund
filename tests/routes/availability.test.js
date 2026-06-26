// describe/it/expect er globale (vitest.config.js -> globals: true)
// Tester /api/availability:
//  - GET /: list slots, filtrering pa activity_id/dato, 400 pa ugyldige filtre.
//  - PUT /: requireRole('ansatt','admin') -> 401/403 gating,
//    validering (manglende felt, ugyldig dato, slots ikke liste),
//    happy-path: sletter eksisterende + setter inn nye slots.
// CJS-monster (jf. insights.test.js): vi muterer db-singletonen — samme ref
// som routes/availability.js holder (vi.mock fanger ikke require() her).
const express = require('express');

const db = require('../../db');

// Fanger SQL-kall slik at vi kan verifisere DELETE-foer-INSERT og params.
const state = { slots: [], kall: [] };

db.isConfigured = () => true;

// Felles SQL-mock: brukes av bade db.query/db.one (GET) og client.query (PUT).
// INSERT ... RETURNING ekko inn raden med en syntetisk id.
function kjorSql(text, params) {
  state.kall.push({ text, params });
  if (/^\s*SELECT/i.test(text)) return { rows: state.slots };
  if (/INSERT/i.test(text)) {
    return {
      rows: [{
        id: state.kall.length,
        activity_id: params[0],
        dato: params[1],
        tid: params[2],
        kapasitet: params[3],
      }],
    };
  }
  // DELETE o.l. — rader vi ikke bryr oss om
  return { rows: [] };
}

db.query = async (text, params) => kjorSql(text, params);
db.one = async (text, params) => {
  const { rows } = kjorSql(text, params);
  return rows[0] || null;
};

// Standard-transaksjon: kjorer fn med en client som logger til state.kall.
// Enkelttester kan overstyre db.withTransaction for a simulere ROLLBACK.
async function withTransactionMock(fn) {
  const client = { query: async (text, params) => kjorSql(text, params) };
  return fn(client);
}
db.withTransaction = withTransactionMock;

const router = require('../../routes/availability');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/availability', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function reqJson(srv, sti, opts) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, opts);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

const ANSATT = { id: 1, rolle: 'ansatt', navn: 'Ola' };
const KUNDE = { id: 9, rolle: 'kunde', navn: 'Per' };

beforeEach(() => {
  state.slots = [];
  state.kall = [];
  db.withTransaction = withTransactionMock;
});

describe('GET /api/availability', () => {
  it('returnerer slots (offentlig, ingen innlogging)', async () => {
    state.slots = [
      { id: 1, activity_id: 2, dato: '2026-07-01', tid: '10:00', kapasitet: 8 },
      { id: 2, activity_id: 2, dato: '2026-07-01', tid: '14:00', kapasitet: 6 },
    ];
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await reqJson(srv, '/api/availability');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      // ingen filtre -> ingen params
      const sel = state.kall.find((k) => /SELECT/i.test(k.text));
      expect(sel.params).toEqual([]);
    } finally { srv.close(); }
  });

  it('filtrerer pa activity_id og dato (sendes som params)', async () => {
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await reqJson(srv, '/api/availability?activity_id=2&dato=2026-07-01');
      expect(res.status).toBe(200);
      const sel = state.kall.find((k) => /SELECT/i.test(k.text));
      expect(sel.params).toEqual([2, '2026-07-01']);
      expect(/activity_id = \$1/.test(sel.text)).toBe(true);
      expect(/dato = \$2/.test(sel.text)).toBe(true);
    } finally { srv.close(); }
  });

  it('400 pa ugyldig dato-filter', async () => {
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await reqJson(srv, '/api/availability?dato=01.07.2026');
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('400 pa ugyldig activity_id-filter', async () => {
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await reqJson(srv, '/api/availability?activity_id=abc');
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });
});

describe('PUT /api/availability', () => {
  function put(body, user) {
    return [
      '/api/availability',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      user,
    ];
  }

  it('401 nar ikke innlogget', async () => {
    const srv = await lytt(lagApp(undefined));
    try {
      const [sti, opts] = put({ activity_id: 1, dato: '2026-07-01', slots: [] });
      const res = await reqJson(srv, sti, opts);
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });

  it('403 for kunde-rolle', async () => {
    const srv = await lytt(lagApp(KUNDE));
    try {
      const [sti, opts] = put({ activity_id: 1, dato: '2026-07-01', slots: [] });
      const res = await reqJson(srv, sti, opts);
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });

  it('400 nar activity_id mangler', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const [sti, opts] = put({ dato: '2026-07-01', slots: [] });
      const res = await reqJson(srv, sti, opts);
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('400 nar dato er ugyldig', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const [sti, opts] = put({ activity_id: 1, dato: 'imorgen', slots: [] });
      const res = await reqJson(srv, sti, opts);
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('400 nar slots ikke er en liste', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const [sti, opts] = put({ activity_id: 1, dato: '2026-07-01', slots: 'nei' });
      const res = await reqJson(srv, sti, opts);
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('400 nar en slot mangler tid', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const [sti, opts] = put({ activity_id: 1, dato: '2026-07-01', slots: [{ kapasitet: 5 }] });
      const res = await reqJson(srv, sti, opts);
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('happy-path: sletter eksisterende og setter inn nye slots', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const [sti, opts] = put({
        activity_id: 2,
        dato: '2026-07-01',
        slots: [{ tid: '10:00', kapasitet: 8 }, { tid: '14:00' }],
      });
      const res = await reqJson(srv, sti, opts);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      // forste kall skal vaere DELETE for (activity_id, dato)
      const del = state.kall.find((k) => /DELETE/i.test(k.text));
      expect(del).toBeTruthy();
      expect(del.params).toEqual([2, '2026-07-01']);
      // to INSERT-kall; manglende kapasitet defaulter til 8
      const ins = state.kall.filter((k) => /INSERT/i.test(k.text));
      expect(ins).toHaveLength(2);
      expect(ins[0].params).toEqual([2, '2026-07-01', '10:00', 8]);
      expect(ins[1].params).toEqual([2, '2026-07-01', '14:00', 8]);
    } finally { srv.close(); }
  });

  it('atomisk: DELETE + alle INSERT gar i EN withTransaction', async () => {
    const fnCalls = [];
    db.withTransaction = async (fn) => {
      fnCalls.push(fn);
      return withTransactionMock(fn);
    };
    const srv = await lytt(lagApp(ANSATT));
    try {
      const [sti, opts] = put({
        activity_id: 3,
        dato: '2026-08-01',
        slots: [{ tid: '09:00', kapasitet: 4 }, { tid: '11:00', kapasitet: 4 }],
      });
      const res = await reqJson(srv, sti, opts);
      expect(res.status).toBe(200);
      // hele slett-og-sett kjorer via EN transaksjon
      expect(fnCalls).toHaveLength(1);
      // og bade DELETE og INSERT skjedde inne i den
      expect(state.kall.some((k) => /DELETE/i.test(k.text))).toBe(true);
      expect(state.kall.filter((k) => /INSERT/i.test(k.text))).toHaveLength(2);
    } finally { srv.close(); }
  });

  it('atomisk rollback: en feilende INSERT ruller tilbake hele PUT (ingen delvis lagring)', async () => {
    // Simuler en client der den 2. INSERT kaster (f.eks. unik-konflikt).
    // withTransaction skal re-kaste -> ruten svarer 500, og det er ingen
    // delvis commit (DELETE alene "lagres" ikke).
    let insertCount = 0;
    db.withTransaction = async (fn) => {
      const client = {
        query: async (text, params) => {
          state.kall.push({ text, params });
          if (/INSERT/i.test(text)) {
            insertCount += 1;
            if (insertCount === 2) throw new Error('INSERT feilet (simulert)');
            return { rows: [{ id: 1 }] };
          }
          return { rows: [] };
        },
      };
      // Ekte withTransaction re-kaster ved feil (etter ROLLBACK). Mock gjor det samme.
      return fn(client);
    };
    const srv = await lytt(lagApp(ANSATT));
    try {
      const [sti, opts] = put({
        activity_id: 4,
        dato: '2026-09-01',
        slots: [{ tid: '10:00' }, { tid: '12:00' }, { tid: '14:00' }],
      });
      const res = await reqJson(srv, sti, opts);
      // feilen propagerer til catch -> 500
      expect(res.status).toBe(500);
      // DELETE + 2 INSERT-forsok ble pabegynt, men 3. INSERT ble aldri naadd
      expect(insertCount).toBe(2);
      expect(state.kall.filter((k) => /INSERT/i.test(k.text))).toHaveLength(2);
    } finally { srv.close(); }
  });
});
