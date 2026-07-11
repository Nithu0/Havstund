// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester at en booking UTEN innlogging oppretter/knytter en passordloes konto,
// lager et engangs-token i reset_tokens, og (naar e-post er simulert) eksponerer
// innloggingslenken i svaret — uten e-post-enumerering.
// CJS-monster (jf. bookings.test.js): vi muterer db-singletonen direkte.
const express = require('express');

const db = require('../../db');
const email = require('../../lib/email');
const discord = require('../../lib/discord');

// Fanget utsending av innloggingslenke. simulertMode styrer om e-posten
// "degraderer" (SMTP mangler) eller "sendes" (ok:true).
const lenkeKall = [];
let simulertMode = true;
email.sendInnloggingslenke = async (til, opts) => {
  lenkeKall.push({ til, opts });
  return simulertMode
    ? { ok: false, simulert: true, grunn: 'SMTP ikke konfigurert' }
    : { ok: true, messageId: 'msg-1' };
};
// Mottatt-kvittering + discord skal aldri kjore i test.
email.sendBookingMottatt = async () => ({ ok: false, simulert: true });
discord.bookingVarsel = () => {};

const state = {
  akt: { id: 1, pris: 500, navn: 'Havpadling', kapasitet: 8, mva_sats: 25 },
  sum: 0,
  epostFinnes: false,      // finnes brukeren fra foer?
  eksisterendeId: 77,      // id naar brukeren finnes
  nyId: 123,               // id naar brukeren opprettes
  brukerInserts: [],       // INSERT INTO users-params (tx)
  tokenInserts: [],        // INSERT INTO reset_tokens-params (tx)
  bookingParams: null,     // INSERT INTO bookings-params (tx)
};

db.isConfigured = () => true;

// Utenfor tx: aktivitet-pris, stengt-dag, aapningstider.
db.one = async (text) => {
  if (/FROM activities WHERE id/i.test(text) && /pris/.test(text)) return state.akt;
  if (/FROM closed_dates/i.test(text)) return null;
  if (/FROM business_hours/i.test(text)) return null;
  return null;
};
db.query = async () => ({ rows: [] });

db.withTransaction = async (fn) => {
  const client = {
    query: async (text, params) => {
      if (/FROM activities WHERE id .* FOR UPDATE/i.test(text)) return { rows: [{ id: state.akt.id }] };
      if (/FROM availability/i.test(text)) return { rows: [] };
      if (/COALESCE\(SUM\(antall\)/i.test(text)) return { rows: [{ sum: state.sum }] };
      if (/FROM users WHERE LOWER\(epost\)/i.test(text)) {
        return { rows: state.epostFinnes ? [{ id: state.eksisterendeId }] : [] };
      }
      if (/INSERT INTO users/i.test(text)) {
        state.brukerInserts.push(params);
        return { rows: [{ id: state.nyId }] };
      }
      if (/INSERT INTO reset_tokens/i.test(text)) {
        state.tokenInserts.push(params);
        return { rows: [] };
      }
      if (/SELECT id FROM regnskap_poster WHERE booking_id/i.test(text)) return { rows: [] };
      if (/INSERT INTO regnskap_poster/i.test(text)) return { rows: [] };
      if (/INSERT INTO bookings/i.test(text)) {
        state.bookingParams = params;
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

async function post(srv, sti, kropp) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(kropp),
  });
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

const HVERDAG = '2026-07-07'; // tirsdag, aapen

function reset() {
  state.sum = 0;
  state.epostFinnes = false;
  state.brukerInserts = [];
  state.tokenInserts = [];
  state.bookingParams = null;
  lenkeKall.length = 0;
  simulertMode = true;
}

const GJEST = { activity_id: 1, navn: 'Kari Gjest', epost: 'Kari@x.no', dato: HVERDAG, tid: '12:00', antall: 1 };

describe('POST /api/bookings — gjest oppretter konto + magisk lenke', () => {
  it('ny e-post: oppretter passordloes kunde, knytter booking, lager token, eksponerer lenke (simulert)', async () => {
    reset();
    const srv = await lytt(lagApp(null));
    try {
      const r = await post(srv, '/api/bookings', GJEST);
      expect(r.status).toBe(201);
      // Ny konto opprettet.
      expect(state.brukerInserts).toHaveLength(1);
      // passord_hash (param index 2) er en ikke-tom plassholder (64 hex-tegn).
      expect(state.brukerInserts[0][2]).toMatch(/^[0-9a-f]{64}$/);
      // rolle er ikke satt via param — den er hardkodet 'kunde' i SQL. Navn/epost:
      expect(state.brukerInserts[0][0]).toBe('Kari Gjest');
      expect(state.brukerInserts[0][1]).toBe('Kari@x.no');
      // Booking knyttet til den nye brukeren (ikke NULL).
      expect(state.bookingParams[1]).toBe(state.nyId);
      // Token lagret med riktig user_id + 32-byte hex (64 tegn) + fremtidig utloep.
      expect(state.tokenInserts).toHaveLength(1);
      expect(state.tokenInserts[0][0]).toMatch(/^[0-9a-f]{64}$/); // token
      expect(state.tokenInserts[0][1]).toBe(state.nyId);           // user_id
      expect(new Date(state.tokenInserts[0][2]).getTime()).toBeGreaterThan(Date.now());
      // Lenke sendt til kundens e-post.
      expect(lenkeKall).toHaveLength(1);
      expect(lenkeKall[0].til).toBe('Kari@x.no');
      expect(lenkeKall[0].opts.lenke).toBe(`/api/auth/magic/${state.tokenInserts[0][0]}`);
      // DEMO-TRYGT: e-post simulert -> lenken eksponeres i svaret.
      expect(r.body.innloggingslenke).toBe(lenkeKall[0].opts.lenke);
    } finally { srv.close(); }
  });

  it('eksisterende e-post: ingen dobbel bruker, token laget, svar likt (ingen enumerering)', async () => {
    reset();
    state.epostFinnes = true;
    const srv = await lytt(lagApp(null));
    try {
      const r = await post(srv, '/api/bookings', GJEST);
      expect(r.status).toBe(201);
      // Ingen ny bruker opprettet.
      expect(state.brukerInserts).toHaveLength(0);
      // Booking knyttet til den EKSISTERENDE brukeren.
      expect(state.bookingParams[1]).toBe(state.eksisterendeId);
      // Token likevel laget (svaret skal se likt ut som ny-konto-tilfellet).
      expect(state.tokenInserts).toHaveLength(1);
      expect(state.tokenInserts[0][1]).toBe(state.eksisterendeId);
      // Svaret har SAMME form som ny-konto: 201 + booking + innloggingslenke.
      // Ingen felt som roeper om kontoen fantes fra foer.
      expect(r.body.innloggingslenke).toBe(`/api/auth/magic/${state.tokenInserts[0][0]}`);
      expect(Object.keys(r.body).sort()).toEqual(['booking', 'innloggingslenke']);
    } finally { srv.close(); }
  });

  it('ekte utsending (ok:true): lenken eksponeres IKKE i svaret', async () => {
    reset();
    simulertMode = false; // SMTP konfigurert -> e-post sendes faktisk
    const srv = await lytt(lagApp(null));
    try {
      const r = await post(srv, '/api/bookings', GJEST);
      expect(r.status).toBe(201);
      // Token + konto ble laget som normalt.
      expect(state.tokenInserts).toHaveLength(1);
      expect(lenkeKall).toHaveLength(1);
      // ...men lenken lekker ALDRI i svaret i normal drift.
      expect(r.body.innloggingslenke).toBeUndefined();
      expect(Object.keys(r.body)).toEqual(['booking']);
    } finally { srv.close(); }
  });

  it('innlogget booker: ingen ny konto/token, ingen lenke sendt (uendret oppfoersel)', async () => {
    reset();
    const KUNDE = { id: 9, rolle: 'kunde', navn: 'Innlogget' };
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/bookings', GJEST);
      expect(r.status).toBe(201);
      expect(state.brukerInserts).toHaveLength(0);
      expect(state.tokenInserts).toHaveLength(0);
      expect(lenkeKall).toHaveLength(0);
      // Booking knyttet til den innloggede brukeren.
      expect(state.bookingParams[1]).toBe(9);
      expect(r.body.innloggingslenke).toBeUndefined();
    } finally { srv.close(); }
  });
});
