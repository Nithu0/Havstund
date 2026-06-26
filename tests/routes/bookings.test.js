// describe/it/expect er globale (vitest.config.js -> globals: true)
// Tester /api/bookings Fase 2 + 3:
//  - POST -> 409 {feil:'fullt'} ved overbooking
//  - POST -> 409 {feil:'stengt'} ved stengt dag (closed_dates)
//  - GET /agenda -> filtrerer dato >= og krever rolle
//  - POST regnskapspost faar aktivitetens mva_sats (per-akt MVA)
//  - POST /:id/refusjon -> negativ regnskapspost
// CJS-monster (jf. hours.test.js): vi muterer db-singletonen direkte.
// vi.mock fanger ikke require() her.
const express = require('express');

const db = require('../../db');
const email = require('../../lib/email');
const discord = require('../../lib/discord');

// E-post/discord skal aldri kjore i test — gjor dem til no-op.
email.sendStatusEpost = async () => ({ ok: false, simulert: true });
discord.bookingVarsel = () => {};

// Delt state som testene setter per case.
const state = {
  akt: { id: 1, pris: 500, navn: 'Havpadling', kapasitet: 8, mva_sats: 25 },
  closed: null,          // closed_dates-rad eller null
  bh: null,              // business_hours-rad eller null
  avail: null,           // availability-rad eller null
  sum: 0,                // SUM(antall) opptatt
  regnskap: [],          // fangede regnskap_poster-INSERT-params
  meldinger: [],         // fangede customer_messages-INSERT-params
  refundBooking: { id: 5, activity_id: 1, navn: 'Kari', belop: 500, bruker_id: 9 },
  agendaRows: [],
  txInsertParams: null,   // params til INSERT INTO bookings via tx-klienten
  txClientUsed: false,    // ble INSERT kjort via withTransaction-klienten?
  regnskapViaTx: false,   // ble regnskap-INSERT kjort via tx-klienten? (A5)
  regnskapFeiler: false,  // simuler at regnskap-INSERT kaster (A5 rollback)
  regnskapFinnes: false,  // idempotens: regnskapspost finnes allerede
};

db.isConfigured = () => true;

db.one = async (text, params) => {
  if (/FROM activities WHERE id/i.test(text) && /pris/.test(text)) return state.akt;
  if (/FROM activities WHERE id/i.test(text)) return { navn: state.akt.navn, mva_sats: state.akt.mva_sats };
  if (/FROM closed_dates/i.test(text)) return state.closed;
  if (/FROM business_hours/i.test(text)) return state.bh;
  if (/FROM availability/i.test(text)) return state.avail;
  if (/COALESCE\(SUM\(antall\)/i.test(text)) return { sum: state.sum };
  if (/SELECT id FROM regnskap_poster WHERE booking_id/i.test(text)) return null;
  if (/INSERT INTO bookings/i.test(text)) {
    return {
      id: 99, activity_id: params[0], bruker_id: params[1], navn: params[2],
      epost: params[3], tlf: params[4], dato: params[5], tid: params[6],
      antall: params[7], belop: params[8], status: 'forespurt',
    };
  }
  if (/SELECT \* FROM bookings WHERE id/i.test(text)) return state.refundBooking;
  if (/UPDATE bookings\s+SET refund_amount_ore/i.test(text)) {
    return { ...state.refundBooking, refund_amount_ore: params[0], refund_reason: params[1] };
  }
  if (/UPDATE bookings SET status/i.test(text)) {
    return { id: params[1], status: params[0], epost: 'kari@x.no', navn: 'Kari', dato: '2026-07-01', tid: '12:00', bruker_id: 9 };
  }
  return null;
};

db.query = async (text, params) => {
  if (/INSERT INTO regnskap_poster/i.test(text)) { state.regnskap.push(params); return { rows: [] }; }
  if (/INSERT INTO customer_messages/i.test(text)) { state.meldinger.push(params); return { rows: [] }; }
  if (/FROM bookings[\s\S]*WHERE b\.dato >=/i.test(text)) return { rows: state.agendaRows };
  return { rows: [] };
};

// Kapasitetssjekk + booking-INSERT + regnskap-INSERT (A5) kjorer naa ALLE i
// db.withTransaction paa SAMME klient. Vi stubber withTransaction til aa kalle
// fn med en fake client, og speiler ROLLBACK-semantikken: hvis fn kaster,
// re-kaster vi (booking + regnskapspost ruller tilbake sammen).
db.withTransaction = async (fn) => {
  const client = {
    query: async (text, params) => {
      if (/FROM activities WHERE id .* FOR UPDATE/i.test(text)) return { rows: [{ id: state.akt.id }] };
      if (/FROM availability/i.test(text)) return { rows: state.avail ? [state.avail] : [] };
      if (/COALESCE\(SUM\(antall\)/i.test(text)) return { rows: [{ sum: state.sum }] };
      if (/SELECT id FROM regnskap_poster WHERE booking_id/i.test(text)) {
        // Idempotens-lookup paa tx-klienten.
        return { rows: state.regnskapFinnes ? [{ id: 1 }] : [] };
      }
      if (/INSERT INTO regnskap_poster/i.test(text)) {
        // A5: regnskap-INSERT skjer naa via tx-klienten, ikke db.query.
        state.regnskapViaTx = true;
        if (state.regnskapFeiler) throw new Error('regnskap-INSERT feilet (simulert)');
        state.regnskap.push(params);
        return { rows: [] };
      }
      if (/INSERT INTO bookings/i.test(text)) {
        state.txClientUsed = true;
        state.txInsertParams = params;
        return {
          rows: [{
            id: 99, activity_id: params[0], bruker_id: params[1], navn: params[2],
            epost: params[3], tlf: params[4], dato: params[5], tid: params[6],
            antall: params[7], belop: params[8], status: 'forespurt',
          }],
        };
      }
      return { rows: [] };
    },
  };
  // Speil withTransaction: feiler fn, re-kast (ekte impl ROLLBACK-er da).
  return fn(client);
};

const router = require('../../routes/bookings');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/bookings', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
}

async function reqJson(srv, sti, opts) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, opts);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

function post(srv, sti, kropp) {
  return reqJson(srv, sti, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(kropp),
  });
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Sjef' };
const KUNDE = { id: 9, rolle: 'kunde', navn: 'Kari' };

function reset() {
  state.akt = { id: 1, pris: 500, navn: 'Havpadling', kapasitet: 8, mva_sats: 25 };
  state.closed = null; state.bh = null; state.avail = null; state.sum = 0;
  state.regnskap = []; state.meldinger = []; state.agendaRows = [];
  state.txInsertParams = null; state.txClientUsed = false;
  state.regnskapViaTx = false; state.regnskapFeiler = false; state.regnskapFinnes = false;
  state.refundBooking = { id: 5, activity_id: 1, navn: 'Kari', belop: 500, bruker_id: 9 };
}

// En gyldig fremtidig hverdag (tirsdag 2026-07-07) for caser som ikke tester stengt.
const HVERDAG = '2026-07-07';

describe('POST /api/bookings — kapasitet (#3)', () => {
  it('avviser overbooking med 409 {feil:fullt}', async () => {
    reset();
    state.sum = 8; // allerede fullt (kapasitet 8)
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1 });
      expect(r.status).toBe(409);
      expect(r.body.feil).toBe('fullt');
    } finally { srv.close(); }
  });

  it('avviser stengt dag med 409 {feil:stengt}', async () => {
    reset();
    state.closed = { dato: HVERDAG };
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 2 });
      expect(r.status).toBe(409);
      expect(r.body.feil).toBe('stengt');
    } finally { srv.close(); }
  });

  it('slipper gjennom naar det er plass, og bruker aktivitetens mva_sats (#PER-AKT MVA)', async () => {
    reset();
    state.akt.mva_sats = 12; // ikke-standard sats
    state.sum = 0;
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1 });
      expect(r.status).toBe(201);
      // INSERT bookings skjedde via withTransaction-klienten (tx-lasen holder).
      expect(state.txClientUsed).toBe(true);
      expect(state.txInsertParams).not.toBeNull();
      expect(state.txInsertParams[0]).toBe(1); // activity_id
      expect(state.regnskap).toHaveLength(1);
      // A5: regnskap-INSERT skjer naa paa SAMME tx-klient som booking-INSERT.
      expect(state.regnskapViaTx).toBe(true);
      // mva_sats er 5. param i INSERT (0-indeks 4)
      expect(state.regnskap[0][4]).toBe(12);
    } finally { srv.close(); }
  });
});

describe('POST /api/bookings — atomisitet booking+regnskap (A5)', () => {
  it('regnskap-INSERT ruller booking tilbake hvis den feiler (ingen 201)', async () => {
    reset();
    state.regnskapFeiler = true; // simuler at regnskap-INSERT kaster i tx
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1 });
      // Tx kaster -> withTransaction ROLLBACK -> route fanger -> 500.
      expect(r.status).toBe(500);
      // Booking-INSERT ble forsokt paa tx-klienten, men ingen regnskapspost lagret
      // (rullet tilbake sammen): ingen booking uten regnskapspost.
      expect(state.txClientUsed).toBe(true);
      expect(state.regnskapViaTx).toBe(true);
      expect(state.regnskap).toHaveLength(0);
    } finally { srv.close(); }
  });

  it('idempotens bevart: hopper over regnskap-INSERT hvis posten finnes (paa tx-klient)', async () => {
    reset();
    state.regnskapFinnes = true; // idempotens-lookup paa tx-klient returnerer en rad
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1 });
      expect(r.status).toBe(201);
      expect(state.txClientUsed).toBe(true);
      // Ingen ny regnskapspost (idempotent).
      expect(state.regnskap).toHaveLength(0);
    } finally { srv.close(); }
  });
});

describe('GET /api/bookings/agenda (#5)', () => {
  it('returnerer rader for rolle og filtrerer paa dato', async () => {
    reset();
    state.agendaRows = [{ id: 1, dato: '2026-07-08', tid: '10:00' }];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await reqJson(srv, '/api/bookings/agenda?dato=2026-07-01');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body).toHaveLength(1);
    } finally { srv.close(); }
  });

  it('krever rolle: 403 for kunde', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      expect((await reqJson(srv, '/api/bookings/agenda')).status).toBe(403);
    } finally { srv.close(); }
  });
});

describe('POST /api/bookings/:id/refusjon (#REFUSJON)', () => {
  it('lager en negativ (reverserende) regnskapspost', async () => {
    reset();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/api/bookings/5/refusjon', { grunn: 'Avlyst tur' });
      expect(r.status).toBe(200);
      expect(state.regnskap).toHaveLength(1);
      // refusjon-INSERT params: [navn, beskr, mvaKode, mva_sats, -netto, -mva, -brutto, id]
      // brutto_ore = index 6 og skal vaere negativ
      expect(state.regnskap[0][6]).toBeLessThan(0);
    } finally { srv.close(); }
  });
});
