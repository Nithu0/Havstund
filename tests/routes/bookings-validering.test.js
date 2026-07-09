// describe/it/expect er globale (vitest.config.js -> globals: true)
// Tester /api/bookings validering + status:
//  - F11: for lange felt -> 400 {error,code:validering,feil:validering}
//  - F11: ugyldig e-post / dato -> 400 (samme superset-svarform)
//  - S3:  PATCH -> 'ingen_oppmoete' -> 200 og status lagret
//  - S3:  PATCH tullestatus -> 400
//  - F26: e-postfeil velter IKKE PATCH (status er committet -> fortsatt 200)
// CJS-monster (jf. bookings.test.js): vi muterer db-singletonen direkte.
const express = require('express');

const db = require('../../db');
const email = require('../../lib/email');
const discord = require('../../lib/discord');

// Delt state per case.
const state = {
  akt: { id: 1, pris: 500, navn: 'Havpadling', kapasitet: 8, mva_sats: 25 },
  sum: 0,
  meldinger: [],
  patchStatus: null,        // status sendt til UPDATE bookings SET status
  epostKall: [],            // fangede sendStatusEpost-kall
  epostSvar: { ok: false, simulert: true }, // hva sendStatusEpost returnerer
};

// E-post/discord skal aldri kjore ekte i test.
email.sendStatusEpost = async (til, navn, info, nyStatus) => {
  state.epostKall.push({ til, navn, info, nyStatus });
  return state.epostSvar;
};
email.sendBookingMottatt = async () => ({ ok: false, simulert: true });
discord.bookingVarsel = () => {};

db.isConfigured = () => true;

db.one = async (text, params) => {
  if (/FROM activities WHERE id/i.test(text) && /pris/.test(text)) return state.akt;
  if (/FROM closed_dates/i.test(text)) return null;
  if (/FROM business_hours/i.test(text)) return null;
  if (/UPDATE bookings SET status/i.test(text)) {
    state.patchStatus = params[0];
    return {
      id: params[1], status: params[0], epost: 'kari@x.no', navn: 'Kari',
      dato: '2026-07-01', tid: '12:00', bruker_id: 9,
    };
  }
  return null;
};

db.query = async (text, params) => {
  if (/INSERT INTO customer_messages/i.test(text)) { state.meldinger.push(params); return { rows: [] }; }
  return { rows: [] };
};

// Kapasitet + booking-INSERT + regnskap-INSERT kjorer i withTransaction (jf.
// bookings.test.js). Vi stubber med en fake client for happy-path (201).
db.withTransaction = async (fn) => {
  const client = {
    query: async (text, params) => {
      if (/FROM activities WHERE id .* FOR UPDATE/i.test(text)) return { rows: [{ id: state.akt.id }] };
      if (/FROM availability/i.test(text)) return { rows: [] };
      if (/COALESCE\(SUM\(antall\)/i.test(text)) return { rows: [{ sum: state.sum }] };
      if (/SELECT id FROM regnskap_poster WHERE booking_id/i.test(text)) return { rows: [] };
      if (/INSERT INTO regnskap_poster/i.test(text)) return { rows: [] };
      if (/INSERT INTO bookings/i.test(text)) {
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

function patch(srv, sti, kropp) {
  return reqJson(srv, sti, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(kropp),
  });
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Sjef' };
const KUNDE = { id: 9, rolle: 'kunde', navn: 'Kari' };
const HVERDAG = '2026-07-07';

function reset() {
  state.sum = 0;
  state.meldinger = [];
  state.patchStatus = null;
  state.epostKall = [];
  state.epostSvar = { ok: false, simulert: true };
}

describe('POST /api/bookings — F11 input-validering', () => {
  it('avviser for langt navn med 400 {error,code:validering,feil:validering}', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', {
        activity_id: 1, navn: 'x'.repeat(201), epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('validering');
      expect(r.body.feil).toBe('validering'); // superset som 409-ene
      expect(typeof r.body.error).toBe('string');
    } finally { srv.close(); }
  });

  it('avviser for lang telefon (400)', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', {
        activity_id: 1, navn: 'Kari', epost: 'k@x.no', tlf: '9'.repeat(41), dato: HVERDAG, tid: '12:00', antall: 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.feil).toBe('validering');
    } finally { srv.close(); }
  });

  it('avviser for lang melding (400)', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', {
        activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1, melding: 'a'.repeat(4001),
      });
      expect(r.status).toBe(400);
      expect(r.body.feil).toBe('validering');
    } finally { srv.close(); }
  });

  it('avviser ugyldig e-post (400)', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', {
        activity_id: 1, navn: 'Kari', epost: 'ikke-en-epost', dato: HVERDAG, tid: '12:00', antall: 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('validering');
    } finally { srv.close(); }
  });

  it('avviser ugyldig dato-format (400)', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', {
        activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: '07.07.2026', tid: '12:00', antall: 1,
      });
      expect(r.status).toBe(400);
      expect(r.body.feil).toBe('validering');
    } finally { srv.close(); }
  });

  it('avviser ikke-eksisterende dato (2026-02-30 -> 400)', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', {
        activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: '2026-02-30', tid: '12:00', antall: 1,
      });
      expect(r.status).toBe(400);
    } finally { srv.close(); }
  });

  it('slipper gjennom gyldige felt (201)', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', {
        activity_id: 1, navn: 'Kari', epost: 'k@x.no', dato: HVERDAG, tid: '12:00', antall: 1, melding: 'Hei',
      });
      expect(r.status).toBe(201);
    } finally { srv.close(); }
  });
});

describe('PATCH /api/bookings/:id — S3 no-show-status', () => {
  it('godtar ingen_oppmoete: 200 og status lagret', async () => {
    reset();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await patch(srv, '/api/bookings/5', { status: 'ingen_oppmoete' });
      expect(r.status).toBe(200);
      expect(state.patchStatus).toBe('ingen_oppmoete'); // status faktisk skrevet til DB
      expect(r.body.booking.status).toBe('ingen_oppmoete');
      // Ingen pengehandling: ingen refusjon/regnskapspost berort her (kun status + evt. kundemelding).
    } finally { srv.close(); }
  });

  it('avviser tullestatus med 400', async () => {
    reset();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await patch(srv, '/api/bookings/5', { status: 'tull' });
      expect(r.status).toBe(400);
      expect(state.patchStatus).toBeNull(); // ingen UPDATE forsokt
    } finally { srv.close(); }
  });
});

describe('PATCH /api/bookings/:id — F26 svelget e-postfeil', () => {
  it('en feilet status-e-post velter IKKE statusendringen (fortsatt 200)', async () => {
    reset();
    state.epostSvar = { ok: false, error: 'smtp nede' }; // e-post feiler
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await patch(srv, '/api/bookings/5', { status: 'bekreftet' });
      expect(r.status).toBe(200);
      expect(state.patchStatus).toBe('bekreftet');
      expect(state.epostKall).toHaveLength(1); // e-post ble faktisk forsokt (await-et)
    } finally { srv.close(); }
  });
});
