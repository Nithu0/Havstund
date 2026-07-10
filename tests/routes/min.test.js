// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// Bolge 98, steg 4 — /api/min/* (ansattens «Min side», lonns-sti).
//
// Denne suiten BEVISER sikkerhetsmodellen (design §7, asymmetri-testene):
//   * ansatt_id kommer ALDRI fra klient — den utledes fra req.ansatt.id.
//   * status settes ALLTID server-side ('utkast' ved POST) — aldri fra body.
//   * en annens rad -> 404 (lekk aldri eksistens); egen rad i feil tilstand -> 409.
//   * GET /lonn viser kun EGEN sats/sum.
//   * hentAnsatt: en bruker uten ansatt-rad naar ikke /api/min/*.
//
// CJS-monster (jf. regnskap-admin-gate.test.js): vi muterer db-singletonen —
// samme ref som routes/min.js + lib/ansatt.js holder. requireRole OG hentAnsatt
// er EKTE; req.user injiseres av en test-middleware slik at hele kjeden testes.
//
// pg-mem/FOR UPDATE: PATCH/DELETE bruker db.withTransaction + SELECT ... FOR
// UPDATE for aa serialisere samtidige endringer paa samme rad. Her mockes
// withTransaction med en fake-client, saa den EKTE samtidigheten (radlaas under
// to parallelle requests) er IKKE drevet av denne suiten — pg-mem stotter uansett
// ikke FOR UPDATE-laasing meningsfullt (single-connection, ingen ekte laaser).
// Det som ER bevist her: tilstands-/eierskaps-grenene (404/409/200) og at
// ansatt_id/status aldri tas fra klient.
const express = require('express');

const db = require('../../db');

// Sentral, muterbar tilstand. ansatteByUser driver hentAnsatt-oppslaget.
const ANSATT_A = { id: 100, user_id: 2, navn: 'Ola', timelonn_ore: 20000, aktiv: true };
const ANSATT_B = { id: 200, user_id: 3, navn: 'Kari', timelonn_ore: 99999, aktiv: true };

const state = {
  ansatteByUser: {},
  timer: [],       // { id, ansatt_id, status }
  insertParams: null,
  sendInnParams: null,
  lonnParams: null,
  patchParams: null,
  deleteKalt: false,
};

function nullstill() {
  state.ansatteByUser = { 2: ANSATT_A, 3: ANSATT_B };
  state.timer = [];
  state.insertParams = null;
  state.sendInnParams = null;
  state.lonnParams = null;
  state.patchParams = null;
  state.deleteKalt = false;
}

db.isConfigured = () => true;

db.one = async (text, params) => {
  // hentAnsatt-oppslag: SELECT * FROM ansatte WHERE user_id = $1
  if (/FROM ansatte\s+WHERE user_id/i.test(text)) {
    return state.ansatteByUser[params[0]] || null;
  }
  // POST /timer
  if (/INSERT INTO timeforinger/i.test(text)) {
    state.insertParams = params; // [ansatt_id, dato, timer, aktivitet, notat, status, opprettet_av]
    return {
      id: 500, ansatt_id: params[0], dato: params[1], timer: params[2],
      aktivitet: params[3], notat: params[4], status: params[5],
    };
  }
  // GET /lonn (sum egne tellende timer)
  if (/SUM\(timer\)/i.test(text)) {
    state.lonnParams = params; // [ansatt_id, maaned]
    return { sum_timer: 12.5 };
  }
  return null;
};

db.query = async (text, params) => {
  if (/INSERT INTO audit_log/i.test(text)) return { rows: [] };
  // POST /timer/send-inn (UPDATE ... status='sendt_inn' ... RETURNING id)
  if (/UPDATE timeforinger[\s\S]*sendt_inn/i.test(text)) {
    state.sendInnParams = params; // [user_id, ansatt_id, maaned]
    return { rows: [{ id: 11 }, { id: 12 }] };
  }
  // GET /timer (egne foringer)
  if (/SELECT[\s\S]*FROM timeforinger/i.test(text)) {
    const ansattId = params[0];
    return { rows: state.timer.filter((r) => r.ansatt_id === ansattId) };
  }
  if (/FROM business_hours/i.test(text)) {
    return { rows: [{ ukedag: 0, apner: '09:00', stenger: '17:00', stengt: false }] };
  }
  if (/FROM closed_dates/i.test(text)) {
    return { rows: [{ dato: '2026-07-17', grunn: 'Ferie' }] };
  }
  return { rows: [] };
};

// PATCH/DELETE: withTransaction med en fake-client. SELECT ... FOR UPDATE slaar
// opp i state.timer paa (id, ansatt_id) — akkurat som eierskaps-filteret i SQL.
db.withTransaction = async (fn) => {
  const client = {
    query: async (text, params) => {
      if (/SELECT[\s\S]*FROM timeforinger[\s\S]*FOR UPDATE/i.test(text)) {
        const [id, ansattId] = params;
        const rad = state.timer.find((r) => r.id === id && r.ansatt_id === ansattId);
        return { rows: rad ? [{ id: rad.id, status: rad.status }] : [] };
      }
      if (/UPDATE timeforinger/i.test(text)) {
        state.patchParams = params;
        return { rows: [{ id: params[params.length - 2], status: 'utkast' }] };
      }
      if (/DELETE FROM timeforinger/i.test(text)) {
        state.deleteKalt = true;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
  return fn(client);
};

const router = require('../../routes/min');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/min', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function reqJson(srv, method, sti, body) {
  const { port } = srv.address();
  const opts = { method };
  if (body !== undefined) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, opts);
  let b = null;
  try { b = await r.json(); } catch { b = null; }
  return { status: r.status, body: b };
}

// Bruker A (id 2) -> ansatt 100. Bruker B (id 3) -> ansatt 200.
const BRUKER_A = { id: 2, rolle: 'ansatt', navn: 'Ola' };
const KUNDE = { id: 9, rolle: 'kunde', navn: 'Fremmed' };
const UTEN_ANSATT = { id: 42, rolle: 'ansatt', navn: 'Ukoblet' };

// ===================== ASYMMETRI-TESTENE (design §7) =====================

describe('min/* — sikkerhetsmodell (asymmetri)', () => {
  // §7.1: ansatt_id i body IGNORERES; raden havner paa avsenderen.
  it('POST /timer med annens ansatt_id i body -> feltet ignoreres, raden blir avsenderens', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'POST', '/api/min/timer', {
        ansatt_id: 200, dato: '2026-07-10', timer: 5,
      });
      expect(res.status).toBe(201);
      // INSERT-param[0] = ansatt_id = req.ansatt.id (100), IKKE body-verdien 200.
      expect(state.insertParams[0]).toBe(100);
      expect(res.body.timeforing.ansatt_id).toBe(100);
    } finally { srv.close(); }
  });

  // §7.5: status ALLTID 'utkast' — selv om body sier annet.
  it('POST /timer med status i body -> lagres som utkast', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'POST', '/api/min/timer', {
        dato: '2026-07-10', timer: 3, status: 'godkjent',
      });
      expect(res.status).toBe(201);
      // INSERT-param[5] = status = 'utkast' (konstant, ikke fra body).
      expect(state.insertParams[5]).toBe('utkast');
      expect(res.body.timeforing.status).toBe('utkast');
    } finally { srv.close(); }
  });

  // §7.2: PATCH paa en ANNENS rad -> 404 (ikke 403 — lekk aldri eksistens).
  it('PATCH /timer/:id paa annens rad -> 404', async () => {
    nullstill();
    state.timer = [{ id: 777, ansatt_id: 200, status: 'utkast' }]; // tilhorer B
    const srv = await lytt(lagApp(BRUKER_A)); // A prover
    try {
      const res = await reqJson(srv, 'PATCH', '/api/min/timer/777', { timer: 8 });
      expect(res.status).toBe(404);
    } finally { srv.close(); }
  });

  // §7.3: PATCH paa EGEN rad med status='godkjent' -> 409.
  it('PATCH /timer/:id paa egen godkjent rad -> 409', async () => {
    nullstill();
    state.timer = [{ id: 300, ansatt_id: 100, status: 'godkjent' }];
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'PATCH', '/api/min/timer/300', { timer: 8 });
      expect(res.status).toBe(409);
    } finally { srv.close(); }
  });

  // §7.4: UPDATE/DELETE mot status='laast' -> 409 UANSETT.
  it('PATCH /timer/:id paa egen laast rad -> 409', async () => {
    nullstill();
    state.timer = [{ id: 400, ansatt_id: 100, status: 'laast' }];
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'PATCH', '/api/min/timer/400', { timer: 8 });
      expect(res.status).toBe(409);
    } finally { srv.close(); }
  });

  it('DELETE /timer/:id paa egen laast rad -> 409 (og ingen DELETE utfort)', async () => {
    nullstill();
    state.timer = [{ id: 400, ansatt_id: 100, status: 'laast' }];
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'DELETE', '/api/min/timer/400');
      expect(res.status).toBe(409);
      expect(state.deleteKalt).toBe(false);
    } finally { srv.close(); }
  });

  // §7.6: GET /lonn viser KUN egen sats/sum.
  it('GET /lonn -> egen sats (20000), ikke en annens (99999)', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'GET', '/api/min/lonn?maaned=2026-07');
      expect(res.status).toBe(200);
      expect(res.body.ansatt_id).toBe(100);
      expect(res.body.timelonn_ore).toBe(20000); // A sin sats, ikke B (99999)
      // sum-spoerringen ble filtrert paa EGEN ansatt_id.
      expect(state.lonnParams[0]).toBe(100);
      // brutto = 12.5 * 20000 = 250000
      expect(res.body.brutto_ore).toBe(250000);
    } finally { srv.close(); }
  });

  // §7.7: hentAnsatt — bruker uten ansatt-rad naar ikke /api/min/*.
  it('bruker uten ansatt-rad -> 403 paa /api/min/timer', async () => {
    nullstill(); // UTEN_ANSATT (id 42) finnes ikke i ansatteByUser
    const srv = await lytt(lagApp(UTEN_ANSATT));
    try {
      const res = await reqJson(srv, 'GET', '/api/min/timer?maaned=2026-07');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });
});

// ===================== ROLLE-GATE + LYKKELIG STI =====================

describe('min/* — rolle-gate og normalflyt', () => {
  it('kunde-rolle -> 403 (requireRole foran hentAnsatt)', async () => {
    nullstill();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const res = await reqJson(srv, 'GET', '/api/min/timer?maaned=2026-07');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });

  it('uinnlogget -> 401', async () => {
    nullstill();
    const srv = await lytt(lagApp(null));
    try {
      const res = await reqJson(srv, 'GET', '/api/min/timer?maaned=2026-07');
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });

  it('POST /timer med ugyldig dato -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'POST', '/api/min/timer', { dato: '2026-02-30', timer: 5 });
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('POST /timer med ugyldig timetall (0) -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'POST', '/api/min/timer', { dato: '2026-07-10', timer: 0 });
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('GET /timer -> kun egne rader', async () => {
    nullstill();
    state.timer = [
      { id: 1, ansatt_id: 100, status: 'utkast' },
      { id: 2, ansatt_id: 200, status: 'utkast' },
    ];
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'GET', '/api/min/timer?maaned=2026-07');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].ansatt_id).toBe(100);
    } finally { srv.close(); }
  });

  it('PATCH /timer/:id paa egen utkast -> 200, endret_av satt', async () => {
    nullstill();
    state.timer = [{ id: 50, ansatt_id: 100, status: 'utkast' }];
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'PATCH', '/api/min/timer/50', { timer: 7 });
      expect(res.status).toBe(200);
      // endret_av = req.user.id (2) ligger i UPDATE-parametrene.
      expect(state.patchParams).toContain(2);
    } finally { srv.close(); }
  });

  it('PATCH /timer/:id uten felt -> 400', async () => {
    nullstill();
    state.timer = [{ id: 50, ansatt_id: 100, status: 'utkast' }];
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'PATCH', '/api/min/timer/50', {});
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('DELETE /timer/:id paa egen utkast -> 200', async () => {
    nullstill();
    state.timer = [{ id: 60, ansatt_id: 100, status: 'utkast' }];
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'DELETE', '/api/min/timer/60');
      expect(res.status).toBe(200);
      expect(state.deleteKalt).toBe(true);
    } finally { srv.close(); }
  });

  it('DELETE /timer/:id paa annens rad -> 404', async () => {
    nullstill();
    state.timer = [{ id: 60, ansatt_id: 200, status: 'utkast' }];
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'DELETE', '/api/min/timer/60');
      expect(res.status).toBe(404);
      expect(state.deleteKalt).toBe(false);
    } finally { srv.close(); }
  });

  it('POST /timer/send-inn -> filtrerer paa egen ansatt_id, returnerer antall', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'POST', '/api/min/timer/send-inn', { maaned: '2026-07' });
      expect(res.status).toBe(200);
      expect(res.body.oppdatert).toBe(2);
      // params: [user_id(2), ansatt_id(100), maaned]
      expect(state.sendInnParams[1]).toBe(100);
      expect(state.sendInnParams[2]).toBe('2026-07');
    } finally { srv.close(); }
  });

  it('POST /timer/send-inn uten maaned -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'POST', '/api/min/timer/send-inn', {});
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });

  it('GET /kalender -> egne foringer + apningstider + stengte dager', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'GET', '/api/min/kalender?maaned=2026-07');
      expect(res.status).toBe(200);
      expect(res.body.maaned).toBe('2026-07');
      expect(Array.isArray(res.body.apningstider)).toBe(true);
      expect(Array.isArray(res.body.stengte_dager)).toBe(true);
      expect(Array.isArray(res.body.foringer)).toBe(true);
    } finally { srv.close(); }
  });

  it('GET /lonn uten maaned -> 400', async () => {
    nullstill();
    const srv = await lytt(lagApp(BRUKER_A));
    try {
      const res = await reqJson(srv, 'GET', '/api/min/lonn');
      expect(res.status).toBe(400);
    } finally { srv.close(); }
  });
});
