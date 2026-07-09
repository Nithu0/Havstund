// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// Tester «lukk dagen»-flyten (Fase 5) i routes/regnskap.js:
//   POST /api/regnskap/dagsoppgjor/:dato  (admin-only, append-only)
//   GET  /api/regnskap/dagsoppgjor?maaned=YYYY-MM
//
// CJS-monster (jf. regnskap-pakke.test.js): vi muterer db-singletonen — samme
// ref som routes/regnskap.js (og lib/audit.js) holder. requireRole er EKTE;
// req.user injiseres av en test-middleware slik at rolle-gaten testes paa ekte.
//
// ── AERLIG om hva mocken IKKE beviser (som pg-mem-testene dokumenterer sine
//    grenser) ──────────────────────────────────────────────────────────────────
//   * SUM(ABS(...)) og to_char() er DB-native funksjoner — pg-mem stotter dem
//     ikke, saa en ekte-SQL-test er ikke mulig i denne repoen. Mocken REGNER
//     derfor referanse-summen (Sigma abs(brutto)) i JS, akkurat slik ekte
//     Postgres SUM(ABS(...)) ville gjort, og beviser at ruta lagrer NOYAKTIG den
//     summen. I tillegg fanger vi den SQL-en ruta sender og bekrefter at den
//     bruker ABS(brutto_ore)/ABS(mva_ore) — det er den reelle koblingen til
//     generatorens konvensjon (lib/regnskapspakke.js invariant 2).
//   * UNIQUE(dato)/ON CONFLICT og withTransaction/FOR UPDATE-serialisering er
//     DB-native — mocken SIMULERER konflikten via et Set og driver fn(client)
//     synkront. Selve laasesemantikken kjorer kun mot ekte Postgres.
const express = require('express');

const db = require('../../db');

const state = { poster: [], dagsoppgjor: [], lukkede: new Set(), sql: [] };

db.isConfigured = () => true;

// Sigma abs(...) over dagens poster — REFERANSEN ekte SUM(ABS(...)) ville gitt.
function summerDag(dato) {
  let brutto = 0, mva = 0, antall = 0;
  for (const p of state.poster) {
    if (p.dato === dato) {
      brutto += Math.abs(p.brutto_ore);
      mva += Math.abs(p.mva_ore);
      antall += 1;
    }
  }
  return { brutto_ore: brutto, mva_ore: mva, antall_bilag: antall };
}

// Klient inne i withTransaction (aggregat-SELECT + INSERT dagsoppgjor).
async function klientQuery(text, params) {
  state.sql.push(text);
  if (/FROM regnskap_poster/i.test(text)) {
    return { rows: [summerDag(params[0])], rowCount: 1 };
  }
  if (/INSERT INTO dagsoppgjor/i.test(text)) {
    const [dato, lukketAv, brutto, mva, antall] = params;
    if (state.lukkede.has(dato)) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
    state.lukkede.add(dato);
    const rad = {
      dato, brutto_ore: brutto, mva_ore: mva, antall_bilag: antall,
      lukket_av: lukketAv, lukket_tid: '2026-07-05T10:00:00.000Z',
    };
    state.dagsoppgjor.push(rad);
    return { rows: [rad], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

db.withTransaction = async (fn) => fn({ query: klientQuery });

// db.query brukes av GET-ruta og av writeAudit (fire-and-forget).
db.query = async (text, params) => {
  if (/INSERT INTO audit_log/i.test(text)) return { rows: [] };
  if (/FROM dagsoppgjor/i.test(text)) {
    const maaned = params && params[0];
    return { rows: state.dagsoppgjor.filter((d) => String(d.dato).slice(0, 7) === maaned) };
  }
  return { rows: [] };
};

const router = require('../../routes/regnskap');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/regnskap', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function reqJson(srv, method, sti) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, { method });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Sjefen' };
const ANSATT = { id: 2, rolle: 'ansatt', navn: 'Ola' };

function nullstill() {
  state.poster = [];
  state.dagsoppgjor = [];
  state.lukkede = new Set();
  state.sql = [];
}

describe('POST /api/regnskap/dagsoppgjor/:dato (lukk dagen)', () => {
  it('admin -> 201 og lagrer dagens ABS-summer', async () => {
    nullstill();
    state.poster = [
      { dato: '2026-07-05', brutto_ore: 12500, mva_ore: 2500 },
      { dato: '2026-07-05', brutto_ore: 10000, mva_ore: 2000 },
      { dato: '2026-07-04', brutto_ore: 9999, mva_ore: 0 }, // annen dag — telles ikke
    ];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/dagsoppgjor/2026-07-05');
      expect(res.status).toBe(201);
      expect(res.body.brutto_ore).toBe(22500);
      expect(res.body.mva_ore).toBe(4500);
      expect(res.body.antall_bilag).toBe(2);
      expect(res.body.lukket_av).toBe('Sjefen');
      expect(res.body.lukket_tid).not.toBeNull();
      // Ruta MAA bruke ABS-konvensjonen (koblingen til generatoren).
      const aggSql = state.sql.find((t) => /FROM regnskap_poster/i.test(t));
      expect(aggSql).toMatch(/SUM\(ABS\(brutto_ore\)\)/i);
      expect(aggSql).toMatch(/SUM\(ABS\(mva_ore\)\)/i);
    } finally { srv.close(); }
  });

  it('KONSISTENS: refusjon (negativ) telles positivt -> brutto_ore == Sigma abs(brutto)', async () => {
    nullstill();
    // Samme dag: to salg + en refusjon lagret NEGATIVT (slik regnskap_poster gjor).
    state.poster = [
      { dato: '2026-07-06', brutto_ore: 12500, mva_ore: 2500 },
      { dato: '2026-07-06', brutto_ore: 10000, mva_ore: 2000 },
      { dato: '2026-07-06', brutto_ore: -2500, mva_ore: -500 }, // refusjon
    ];
    // Det generatoren ville brukt: summen av ABSOLUTTVERDIER.
    const forventetBrutto = 12500 + 10000 + Math.abs(-2500); // 25000
    const forventetMva = 2500 + 2000 + Math.abs(-500);       // 5000
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/dagsoppgjor/2026-07-06');
      expect(res.status).toBe(201);
      expect(res.body.brutto_ore).toBe(forventetBrutto);
      expect(res.body.mva_ore).toBe(forventetMva);
      expect(res.body.antall_bilag).toBe(3);
      // Fortegnet er ALDRI semantikk her — refusjonen la til, trakk ikke fra.
      expect(res.body.brutto_ore).toBeGreaterThan(12500 + 10000);
    } finally { srv.close(); }
  });

  it('dag uten bilag -> 201 med nuller (en stille dag kan lukkes)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/dagsoppgjor/2026-07-07');
      expect(res.status).toBe(201);
      expect(res.body.brutto_ore).toBe(0);
      expect(res.body.mva_ore).toBe(0);
      expect(res.body.antall_bilag).toBe(0);
    } finally { srv.close(); }
  });

  it('samme dato to ganger -> 2. gang 409 (append-only)', async () => {
    nullstill();
    state.poster = [{ dato: '2026-07-08', brutto_ore: 5000, mva_ore: 1000 }];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const forste = await reqJson(srv, 'POST', '/api/regnskap/dagsoppgjor/2026-07-08');
      expect(forste.status).toBe(201);
      const andre = await reqJson(srv, 'POST', '/api/regnskap/dagsoppgjor/2026-07-08');
      expect(andre.status).toBe(409);
      expect(andre.body.error).toMatch(/allerede lukket/i);
    } finally { srv.close(); }
  });

  it('ansatt -> 403 (route-nivaa requireRole admin)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/dagsoppgjor/2026-07-05');
      expect(res.status).toBe(403);
      // Ingen lukking skal ha skjedd.
      expect(state.lukkede.size).toBe(0);
    } finally { srv.close(); }
  });

  it('ugyldig dato-format -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/dagsoppgjor/2026-7-5');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/YYYY-MM-DD/);
    } finally { srv.close(); }
  });

  it('umulig kalenderdag (2026-02-30) -> 400 (streng validering)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/dagsoppgjor/2026-02-30');
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });
});

describe('GET /api/regnskap/dagsoppgjor?maaned=YYYY-MM', () => {
  it('lister lukkede dager for maneden', async () => {
    nullstill();
    state.dagsoppgjor = [
      { dato: '2026-07-05', brutto_ore: 22500, mva_ore: 4500, antall_bilag: 2, lukket_av: 'Sjefen', lukket_tid: 'x' },
      { dato: '2026-07-06', brutto_ore: 25000, mva_ore: 5000, antall_bilag: 3, lukket_av: 'Sjefen', lukket_tid: 'x' },
      { dato: '2026-06-30', brutto_ore: 100, mva_ore: 0, antall_bilag: 1, lukket_av: 'Sjefen', lukket_tid: 'x' },
    ];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'GET', '/api/regnskap/dagsoppgjor?maaned=2026-07');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body.map((d) => d.dato)).toEqual(['2026-07-05', '2026-07-06']);
    } finally { srv.close(); }
  });

  it('ansatt kan lese lukkestatus (ruterens ansatt+admin) -> 200', async () => {
    nullstill();
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await reqJson(srv, 'GET', '/api/regnskap/dagsoppgjor?maaned=2026-07');
      expect(res.status).toBe(200);
    } finally { srv.close(); }
  });

  it('ugyldig maaned -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'GET', '/api/regnskap/dagsoppgjor?maaned=2026-7');
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });
});
