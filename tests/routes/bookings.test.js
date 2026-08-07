// describe/it/expect er globale (vitest.config.js -> globals: true)
// Tester /api/bookings Fase 2 + 3:
//  - POST -> 409 {error,code:'fullt',feil:'fullt'} ved overbooking (superset)
//  - POST -> 409 {error,code:'stengt',feil:'stengt'} ved stengt dag (closed_dates)
//  - GET /agenda -> filtrerer dato >= og krever rolle
//  - POST regnskapspost faar aktivitetens mva_sats (per-akt MVA)
//  - POST /:id/refusjon -> negativ regnskapspost
// CJS-monster (jf. hours.test.js): vi muterer db-singletonen direkte.
// vi.mock fanger ikke require() her.
const express = require('express');

const db = require('../../db');
const email = require('../../lib/email');
const discord = require('../../lib/discord');

// E-post/discord skal aldri kjore i test â€” gjor dem til no-op.
const sendteMottatt = [];
email.sendStatusEpost = async () => ({ ok: false, simulert: true });
email.sendBookingMottatt = async (til, navn, info, aktNavn) => { sendteMottatt.push({ til, navn, info, aktNavn }); return { ok: false, simulert: true }; };
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
  // Fase 4 refusjon:
  refusjonSum: 0,         // SUM(belop_ore) allerede refundert paa bookingen
  refusjonDup: false,     // idempotens-forhaandssjekk treffer en eksisterende rad
  refusjoner: [],         // fangede refusjoner-INSERT-params
  gavekortRader: [],      // fangede gavekort-INSERT-params
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
      // Param-rekkefølge etter forenklingen 2026-08-07: bruker_id er ikke lenger
      // en bundet param (INSERT-en skriver NULL direkte), så alt etter
      // activity_id forskjøv seg ett hakk ned.
      id: 99, activity_id: params[0], bruker_id: null, navn: params[1],
      epost: params[2], tlf: params[3], dato: params[4], tid: params[5],
      antall: params[6], belop: params[7], melding: params[8], status: 'forespurt',
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
      // Fase 4 refusjon: booking-laas, idempotens-, sum-, gavekort- og refusjon-SQL.
      if (/SELECT \* FROM bookings WHERE id .* FOR UPDATE/i.test(text)) {
        return { rows: state.refundBooking ? [state.refundBooking] : [] };
      }
      if (/SELECT id FROM refusjoner WHERE idempotens_nokkel/i.test(text)) {
        return { rows: state.refusjonDup ? [{ id: 77 }] : [] };
      }
      if (/COALESCE\(SUM\(belop_ore\)[\s\S]*FROM refusjoner/i.test(text)) {
        return { rows: [{ sum: state.refusjonSum }] };
      }
      if (/INSERT INTO gavekort/i.test(text)) {
        state.gavekortRader.push(params);
        return { rows: [{ id: 42 }] };
      }
      if (/INSERT INTO refusjoner/i.test(text)) {
        state.refusjoner.push(params);
        return { rows: [{ id: 5 }] };
      }
      if (/SELECT navn, mva_sats FROM activities/i.test(text)) {
        return { rows: [{ navn: state.akt.navn, mva_sats: state.akt.mva_sats }] };
      }
      if (/UPDATE bookings\s+SET refund_amount_ore/i.test(text)) {
        return { rows: [{ ...state.refundBooking, refund_amount_ore: params[0], refund_reason: params[1] }] };
      }
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
            // Se kommentaren ved db.one-attrappen: bruker_id er ikke lenger en
            // bundet param, så alt etter activity_id forskjøv seg ett hakk ned.
            id: 99, activity_id: params[0], bruker_id: null, navn: params[1],
            epost: params[2], tlf: params[3], dato: params[4], tid: params[5],
            antall: params[6], belop: params[7], melding: params[8], status: 'forespurt',
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
  state.refusjonSum = 0; state.refusjonDup = false; state.refusjoner = []; state.gavekortRader = [];
  state.refundBooking = { id: 5, activity_id: 1, navn: 'Kari', belop: 500, bruker_id: 9 };
  sendteMottatt.length = 0;
}

// En gyldig fremtidig hverdag (tirsdag 2026-07-07) for caser som ikke tester stengt.
const HVERDAG = '2026-07-07';

describe('POST /api/bookings â€” kapasitet (#3)', () => {
  it('avviser overbooking med 409 {error,code:fullt,feil:fullt}', async () => {
    reset();
    state.sum = 8; // allerede fullt (kapasitet 8)
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1 });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('fullt');
      expect(r.body.feil).toBe('fullt'); // superset bevart under migrering
      expect(typeof r.body.error).toBe('string');
    } finally { srv.close(); }
  });

  it('avviser stengt dag med 409 {error,code:stengt,feil:stengt}', async () => {
    reset();
    state.closed = { dato: HVERDAG };
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 2 });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('stengt');
      expect(r.body.feil).toBe('stengt'); // superset bevart under migrering
      expect(typeof r.body.error).toBe('string');
    } finally { srv.close(); }
  });

  it('slipper gjennom naar det er plass, og INSERT gaar paa tx-klienten', async () => {
    reset();
    state.sum = 0;
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1 });
      expect(r.status).toBe(201);
      // INSERT bookings skjedde via withTransaction-klienten (tx-lasen holder).
      // Det er selve overbookingsvernet: uten samme klient slipper to samtidige
      // POST forbi kapasitetssjekken.
      expect(state.txClientUsed).toBe(true);
      expect(state.txInsertParams).not.toBeNull();
      expect(state.txInsertParams[0]).toBe(1); // activity_id
    } finally { srv.close(); }
  });
});

describe('POST /api/bookings - mottatt-kvittering (S1A)', () => {
  it('sender mottatt-kvittering ETTER commit med aktivitetens navn', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 2 });
      expect(r.status).toBe(201);
      expect(sendteMottatt).toHaveLength(1);
      expect(sendteMottatt[0].til).toBe('k@x.no');
      expect(sendteMottatt[0].navn).toBe('Kari');
      expect(sendteMottatt[0].aktNavn).toBe('Havpadling');
      expect(sendteMottatt[0].info.id).toBe(99);
      expect(sendteMottatt[0].info.dato).toBe(HVERDAG);
    } finally { srv.close(); }
  });

  it('sender IKKE kvittering naar det er fullt (409)', async () => {
    reset();
    state.sum = 8; // fullt (kapasitet 8)
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', { activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1 });
      expect(r.status).toBe(409);
      expect(sendteMottatt).toHaveLength(0);
    } finally { srv.close(); }
  });
});

