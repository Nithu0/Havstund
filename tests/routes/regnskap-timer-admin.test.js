// describe/it/expect er globale (vitest.config.js -> globals: true).
//
// Tester admin-timeforing PAA VEGNE AV ansatte (bolge 98 steg 6) i
// routes/regnskap.js:
//   GET    /api/regnskap/timer?ansatt_id=&maaned=&status=
//   POST   /api/regnskap/timer                 (ansatt_id PAAKREVD, status='sendt_inn')
//   PATCH  /api/regnskap/timer/:id             (ikke-laast -> ok, laast -> 409)
//   DELETE /api/regnskap/timer/:id             (kun 'utkast' -> ok, annet -> 409)
//   POST   /api/regnskap/timer/:id/godkjenn    (sendt_inn -> godkjent)
//   POST   /api/regnskap/timer/:id/avvis       (sendt_inn -> avvist, begrunnelse PAAKREVD)
//   POST   /api/regnskap/timer/laas?maaned=    (godkjent -> laast)
//   POST   /api/regnskap/timer/:id/korriger    (ENESTE vei inn i en laast rad)
//
// CJS-monster (jf. regnskap-dagsoppgjor.test.js + audit-wiring.test.js): vi
// muterer db- og audit-singletonene FOER routeren kreves inn. audit.writeAudit
// byttes til en spion — samme objekt-ref som routeren destrukturerer ved load.
//
// ── AERLIG om hva mocken IKKE beviser (som pg-mem-testene dokumenterer sine
//    grenser) ──────────────────────────────────────────────────────────────────
//   * to_char()/JOIN/FOR UPDATE er DB-native. pg-mem stotter dem ikke, saa en
//     ekte-SQL-test er ikke mulig her. Mocken holder timeforinger i en JS-array
//     og TOLKER SQL-en (INSERT/SELECT...FOR UPDATE/UPDATE/DELETE) mot den. Det
//     beviser status-maskinen (tilstandsovergangene + hvilke som er lovlige) og
//     at ruta sender riktig SQL — IKKE selve rad-laasen.
//   * withTransaction/FOR UPDATE-serialisering (to samtidige admin-handlinger paa
//     samme rad) kan kun bevises mot ekte Postgres. Mocken kjorer fn(client)
//     synkront og reproduserer derfor ikke et ekte race. Ruta ER skrevet med
//     SELECT ... FOR UPDATE inne i withTransaction nettopp for den semantikken;
//     testen verifiserer tilstands-logikken, ikke laasen.
const express = require('express');

const db = require('../../db');
const audit = require('../../lib/audit');

// --- Spion paa lib/audit.writeAudit (samme ref routeren destrukturerer) --------
const auditCalls = [];
const origAudit = audit.writeAudit;
audit.writeAudit = async (actor, handling, detaljer) => {
  auditCalls.push({ actor, handling, detaljer });
  return { ok: true };
};

// --- In-memory timeforinger med status-maskin ---------------------------------
const state = { timer: [] };
let nextId = 1;

const NOW = '2026-07-10T10:00:00.000Z';

function nyRad(fields) {
  const rad = {
    id: nextId++, ansatt_id: null, dato: null, timer: null, aktivitet: null,
    notat: null, status: 'utkast', godkjent_av: null, godkjent_tid: null,
    begrunnelse: null, laast_tid: null, korrigerer_id: null, opprettet_av: null,
    endret_av: null, endret_tid: null, opprettet: '2026-07-10T00:00:00.000Z',
    ...fields,
  };
  state.timer.push(rad);
  return rad;
}
function finn(id) { return state.timer.find((r) => r.id === Number(id)); }

// Ett felles SQL-tolkende punkt som db.one, db.query og klient-query deler.
function handle(text, params) {
  const t = text;

  // INSERT INTO timeforinger — to varianter: POST /timer og korriger. Skill paa
  // KOLONNE-lista (foer forste ')'), IKKE paa RETURNING — TIMER_KOLONNER inneholder
  // ogsaa 'korrigerer_id', saa et raatt /korrigerer_id/-treff ville feilklassifisert
  // den enkle INSERT-en.
  if (/INSERT INTO timeforinger/i.test(t)) {
    if (/INSERT INTO timeforinger[^)]*korrigerer_id/i.test(t)) {
      const [ansatt_id, dato, timer, aktivitet, notat, korrigerer_id, opprettet_av, begrunnelse] = params;
      const rad = nyRad({
        ansatt_id, dato, timer, aktivitet, notat,
        status: 'sendt_inn', korrigerer_id, opprettet_av, begrunnelse,
      });
      return { rows: [rad], rowCount: 1 };
    }
    const [ansatt_id, dato, timer, aktivitet, notat, opprettet_av] = params;
    const rad = nyRad({ ansatt_id, dato, timer, aktivitet, notat, status: 'sendt_inn', opprettet_av });
    return { rows: [rad], rowCount: 1 };
  }

  // SELECT ... FOR UPDATE (enkeltrad, id = $1).
  if (/FROM timeforinger/i.test(t) && /FOR UPDATE/i.test(t)) {
    const rad = finn(params[0]);
    return { rows: rad ? [rad] : [], rowCount: rad ? 1 : 0 };
  }

  // laas: UPDATE ... status='laast' ... WHERE status='godkjent' AND to_char(...) = $1
  if (/UPDATE timeforinger/i.test(t) && /status = 'laast'/i.test(t)) {
    const maaned = params[0];
    const ids = [];
    for (const r of state.timer) {
      if (r.status === 'godkjent' && String(r.dato).slice(0, 7) === maaned) {
        r.status = 'laast';
        r.laast_tid = NOW;
        ids.push({ id: r.id });
      }
    }
    return { rows: ids, rowCount: ids.length };
  }

  // Generisk UPDATE (patch/godkjenn/avvis): tolk SET-klausulen mot raden.
  if (/UPDATE timeforinger/i.test(t)) {
    const setDel = t.slice(t.search(/SET/i) + 3, t.search(/WHERE/i));
    const whereM = /WHERE id = \$(\d+)/i.exec(t);
    const id = params[Number(whereM[1]) - 1];
    const rad = finn(id);
    if (!rad) return { rows: [], rowCount: 0 };
    let m;
    const reParam = /(\w+)\s*=\s*\$(\d+)/g;      // col = $n
    while ((m = reParam.exec(setDel))) { rad[m[1]] = params[Number(m[2]) - 1]; }
    const reLit = /(\w+)\s*=\s*'([^']*)'/g;       // col = 'literal' (status)
    while ((m = reLit.exec(setDel))) { rad[m[1]] = m[2]; }
    const reNow = /(\w+)\s*=\s*now\(\)/gi;        // col = now()
    while ((m = reNow.exec(setDel))) { rad[m[1]] = NOW; }
    return { rows: [rad], rowCount: 1 };
  }

  // DELETE (id = $1).
  if (/DELETE FROM timeforinger/i.test(t)) {
    const id = Number(params[0]);
    const i = state.timer.findIndex((r) => r.id === id);
    if (i >= 0) state.timer.splice(i, 1);
    return { rows: [], rowCount: i >= 0 ? 1 : 0 };
  }

  // GET-lista (JOIN ansatte). Mocken reproduserer IKKE SQL-filtrene (to_char etc.)
  // — den returnerer alle rader med et syntetisk ansatt_navn.
  if (/FROM timeforinger t JOIN ansatte/i.test(t)) {
    const rows = state.timer.map((r) => ({ ...r, ansatt_navn: 'Ansatt ' + r.ansatt_id }));
    return { rows, rowCount: rows.length };
  }

  // audit_log naas ikke naar writeAudit er spionert; defensiv no-op.
  if (/INSERT INTO audit_log/i.test(t)) return { rows: [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
}

db.isConfigured = () => true;
db.query = async (text, params) => handle(text, params);
db.one = async (text, params) => handle(text, params).rows[0] || null;
db.withTransaction = async (fn) => fn({ query: async (text, params) => handle(text, params) });

const router = require('../../routes/regnskap');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/regnskap', router);
  return app;
}
function lytt(app) {
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
}
async function reqJson(srv, method, sti, body) {
  const { port } = srv.address();
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, opts);
  let b = null;
  try { b = await r.json(); } catch { b = null; }
  return { status: r.status, body: b };
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Sjefen' };
const ANSATT = { id: 2, rolle: 'ansatt', navn: 'Ola' };

function nullstill() {
  state.timer = [];
  nextId = 1;
  auditCalls.length = 0;
}
function harAudit(handling) {
  return auditCalls.some((c) => c.handling === handling);
}

afterAll(() => { audit.writeAudit = origAudit; });

describe('POST /api/regnskap/timer — ansatt_id PAAKREVD + status=sendt_inn', () => {
  it('UTEN ansatt_id -> 400 (aldri implisitt)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/timer', { dato: '2026-07-05', timer: 4 });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/ansatt_id/i);
      expect(state.timer).toHaveLength(0);
    } finally { srv.close(); }
  });

  it('med ansatt_id -> 201, status=sendt_inn (IKKE godkjent), opprettet_av=admin, writeAudit kalt', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/timer', {
        ansatt_id: 5, dato: '2026-07-05', timer: 6, aktivitet: 'Kajakk',
      });
      expect(res.status).toBe(201);
      expect(res.body.timeforing.status).toBe('sendt_inn');
      expect(res.body.timeforing.ansatt_id).toBe(5);
      expect(res.body.timeforing.opprettet_av).toBe(ADMIN.id);
      expect(harAudit('regnskap.timer.opprett')).toBe(true);
    } finally { srv.close(); }
  });

  it('klienten kan IKKE lofte foringen til godkjent via body.status', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/timer', {
        ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'godkjent', opprettet_av: 999,
      });
      expect(res.status).toBe(201);
      expect(res.body.timeforing.status).toBe('sendt_inn'); // body.status ignorert
      expect(res.body.timeforing.opprettet_av).toBe(ADMIN.id); // body.opprettet_av ignorert
    } finally { srv.close(); }
  });

  it('ugyldig dato -> 400, ugyldig timetall -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const d = await reqJson(srv, 'POST', '/api/regnskap/timer', { ansatt_id: 5, dato: '2026-7-5', timer: 4 });
      expect(d.status).toBe(400);
      const tt = await reqJson(srv, 'POST', '/api/regnskap/timer', { ansatt_id: 5, dato: '2026-07-05', timer: 0 });
      expect(tt.status).toBe(400);
    } finally { srv.close(); }
  });

  it('ansatt-rolle -> 403 (ruteren er admin-only)', async () => {
    nullstill();
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/timer', { ansatt_id: 5, dato: '2026-07-05', timer: 4 });
      expect(res.status).toBe(403);
      expect(state.timer).toHaveLength(0);
    } finally { srv.close(); }
  });
});

describe('POST /api/regnskap/timer/:id/godkjenn', () => {
  it('sendt_inn -> godkjent (godkjent_av/godkjent_tid), writeAudit kalt', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'sendt_inn' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', `/api/regnskap/timer/${rad.id}/godkjenn`);
      expect(res.status).toBe(200);
      expect(res.body.timeforing.status).toBe('godkjent');
      expect(res.body.timeforing.godkjent_av).toBe(ADMIN.id);
      expect(res.body.timeforing.godkjent_tid).not.toBeNull();
      expect(harAudit('regnskap.timer.godkjenn')).toBe(true);
    } finally { srv.close(); }
  });

  it('feil tilstand (utkast) -> 409', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'utkast' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', `/api/regnskap/timer/${rad.id}/godkjenn`);
      expect(res.status).toBe(409);
      expect(finn(rad.id).status).toBe('utkast');
    } finally { srv.close(); }
  });

  it('ikke funnet -> 404', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/timer/999/godkjenn');
      expect(res.status).toBe(404);
    } finally { srv.close(); }
  });
});

describe('POST /api/regnskap/timer/:id/avvis', () => {
  it('uten begrunnelse -> 400', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'sendt_inn' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', `/api/regnskap/timer/${rad.id}/avvis`, {});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/begrunnelse/i);
      expect(finn(rad.id).status).toBe('sendt_inn');
    } finally { srv.close(); }
  });

  it('med begrunnelse: sendt_inn -> avvist + begrunnelse, writeAudit kalt', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'sendt_inn' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', `/api/regnskap/timer/${rad.id}/avvis`, { begrunnelse: 'Feil dato' });
      expect(res.status).toBe(200);
      expect(res.body.timeforing.status).toBe('avvist');
      expect(res.body.timeforing.begrunnelse).toBe('Feil dato');
      expect(harAudit('regnskap.timer.avvis')).toBe(true);
    } finally { srv.close(); }
  });

  it('feil tilstand (godkjent) -> 409', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'godkjent' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', `/api/regnskap/timer/${rad.id}/avvis`, { begrunnelse: 'x' });
      expect(res.status).toBe(409);
    } finally { srv.close(); }
  });
});

describe('PATCH /api/regnskap/timer/:id — laast-immutabilitet', () => {
  it('ikke-laast (sendt_inn) redigeres -> 200, endret_av satt, writeAudit kalt', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'sendt_inn' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'PATCH', `/api/regnskap/timer/${rad.id}`, { timer: 8 });
      expect(res.status).toBe(200);
      expect(res.body.timeforing.timer).toBe(8);
      expect(res.body.timeforing.endret_av).toBe(ADMIN.id);
      expect(harAudit('regnskap.timer.rediger')).toBe(true);
    } finally { srv.close(); }
  });

  it('mot status=laast -> 409 (raden er urorlig)', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'laast', laast_tid: NOW });
    const srv = await lytt(lagApp(ADMIN));
    try {
      // timer=8 er GYLDIG (passerer validering) — saa 409 kommer fra laast-sjekken,
      // ikke fra en 400 paa timetallet.
      const res = await reqJson(srv, 'PATCH', `/api/regnskap/timer/${rad.id}`, { timer: 8 });
      expect(res.status).toBe(409);
      expect(finn(rad.id).timer).toBe(6); // uendret
    } finally { srv.close(); }
  });
});

describe('DELETE /api/regnskap/timer/:id — kun utkast', () => {
  it('utkast slettes -> 200, writeAudit kalt', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'utkast' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'DELETE', `/api/regnskap/timer/${rad.id}`);
      expect(res.status).toBe(200);
      expect(finn(rad.id)).toBeUndefined();
      expect(harAudit('regnskap.timer.slett')).toBe(true);
    } finally { srv.close(); }
  });

  it('mot status=laast -> 409 (bevares)', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'laast', laast_tid: NOW });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'DELETE', `/api/regnskap/timer/${rad.id}`);
      expect(res.status).toBe(409);
      expect(finn(rad.id)).toBeTruthy();
    } finally { srv.close(); }
  });

  it('mot status=godkjent -> 409', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'godkjent' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'DELETE', `/api/regnskap/timer/${rad.id}`);
      expect(res.status).toBe(409);
    } finally { srv.close(); }
  });
});

describe('POST /api/regnskap/timer/laas?maaned=YYYY-MM', () => {
  it('godkjent -> laast for maaneden (bare den maaneden, bare godkjente)', async () => {
    nullstill();
    const g1 = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'godkjent' });
    const s1 = nyRad({ ansatt_id: 5, dato: '2026-07-06', timer: 6, status: 'sendt_inn' });
    const g2 = nyRad({ ansatt_id: 6, dato: '2026-06-30', timer: 6, status: 'godkjent' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/timer/laas?maaned=2026-07');
      expect(res.status).toBe(200);
      expect(res.body.laast).toBe(1);
      expect(finn(g1.id).status).toBe('laast');
      expect(finn(g1.id).laast_tid).not.toBeNull();
      expect(finn(s1.id).status).toBe('sendt_inn');  // ikke godkjent -> uroert
      expect(finn(g2.id).status).toBe('godkjent');   // annen maaned -> uroert
      expect(harAudit('regnskap.timer.laas')).toBe(true);
    } finally { srv.close(); }
  });

  it('ugyldig maaned -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/timer/laas?maaned=2026-7');
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });
});

describe('POST /api/regnskap/timer/:id/korriger — eneste vei inn i en laast rad', () => {
  it('paa laast: NY rad m/ korrigerer_id + NEGATIVE timer, original UROERT, writeAudit kalt', async () => {
    nullstill();
    const orig = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'laast', laast_tid: NOW, aktivitet: 'Kajakk' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', `/api/regnskap/timer/${orig.id}/korriger`, { timer: -2, begrunnelse: 'Trekk fra' });
      expect(res.status).toBe(201);
      const ny = res.body.timeforing;
      expect(ny.id).not.toBe(orig.id);
      expect(ny.korrigerer_id).toBe(orig.id);
      expect(ny.timer).toBe(-2);
      expect(ny.status).toBe('sendt_inn');
      expect(ny.ansatt_id).toBe(5);
      expect(ny.opprettet_av).toBe(ADMIN.id);
      // Originalen er UROERT: fortsatt laast, timer uendret.
      expect(finn(orig.id).status).toBe('laast');
      expect(finn(orig.id).timer).toBe(6);
      expect(state.timer).toHaveLength(2);
      expect(harAudit('regnskap.timer.korriger')).toBe(true);
    } finally { srv.close(); }
  });

  it('paa en IKKE-laast rad (sendt_inn) -> 409 (rediger direkte i stedet)', async () => {
    nullstill();
    const rad = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'sendt_inn' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', `/api/regnskap/timer/${rad.id}/korriger`, { timer: -2 });
      expect(res.status).toBe(409);
      expect(state.timer).toHaveLength(1); // ingen ny rad
    } finally { srv.close(); }
  });

  it('ugyldig korreksjonstimer (0) -> 400', async () => {
    nullstill();
    const orig = nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'laast', laast_tid: NOW });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', `/api/regnskap/timer/${orig.id}/korriger`, { timer: 0 });
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('ikke funnet -> 404', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'POST', '/api/regnskap/timer/999/korriger', { timer: -2 });
      expect(res.status).toBe(404);
    } finally { srv.close(); }
  });
});

describe('GET /api/regnskap/timer', () => {
  it('lister foringer (200, array)', async () => {
    nullstill();
    nyRad({ ansatt_id: 5, dato: '2026-07-05', timer: 6, status: 'sendt_inn' });
    nyRad({ ansatt_id: 6, dato: '2026-07-06', timer: 4, status: 'godkjent' });
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await reqJson(srv, 'GET', '/api/regnskap/timer?maaned=2026-07');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
    } finally { srv.close(); }
  });

  it('ansatt-rolle -> 403', async () => {
    nullstill();
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await reqJson(srv, 'GET', '/api/regnskap/timer?maaned=2026-07');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });
});
