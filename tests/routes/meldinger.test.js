// describe/it/expect er globale (vitest.config.js -> globals: true)
// F27 — POST /api/meldinger: ansatt/admin-svar varsler kunden på e-post
// (fire-and-forget), kunde-melding gjør det IKKE, og en e-postfeil velter
// aldri svaret. CJS-monster (jf. bookings.test.js): vi muterer singletonene.
const express = require('express');

const db = require('../../db');
const email = require('../../lib/email');
const discord = require('../../lib/discord');

// Fanger sendNyMelding-kall; e-post/discord skal aldri kjøre ekte i test.
const sendteVarsler = [];
let sendNyMeldingSvar = { ok: true, messageId: '<varsel@havstund>' };
email.sendNyMelding = async (til, opts) => { sendteVarsler.push({ til, opts }); return sendNyMeldingSvar; };
discord.kundeMeldingVarsel = () => {};

const state = {
  kunde: { id: 9, navn: 'Kari', epost: 'kari@x.no' }, // SELECT ... FROM users
  meldingId: 501,
  insertParams: null, // params til INSERT INTO customer_messages
};

db.isConfigured = () => true;

db.one = async (text, params) => {
  if (/FROM users WHERE id/i.test(text)) return state.kunde;
  if (/INSERT INTO customer_messages/i.test(text)) {
    state.insertParams = params;
    // avsender er hardkodet i SQL-en (admin/kunde), ikke en param.
    const avsender = /'admin'/.test(text) ? 'admin' : 'kunde';
    return {
      id: state.meldingId,
      bruker_id: params[0],
      avsender,
      tekst: params[1],
      pris: avsender === 'admin' ? (params[2] != null ? params[2] : null) : null,
      lest: false,
      opprettet: '2026-07-10T10:00:00Z',
    };
  }
  return null;
};

db.query = async () => ({ rows: [] });

const router = require('../../routes/meldinger');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/meldinger', router);
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
  state.kunde = { id: 9, navn: 'Kari', epost: 'kari@x.no' };
  state.meldingId = 501;
  state.insertParams = null;
  sendteVarsler.length = 0;
  sendNyMeldingSvar = { ok: true, messageId: '<varsel@havstund>' };
}

describe('POST /api/meldinger — F27 kunde-varsel', () => {
  it('ansatt/admin-svar varsler kunden på kundens e-post', async () => {
    reset();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/api/meldinger?bruker_id=9', { tekst: 'Hei, her er svaret' });
      expect(r.status).toBe(201);
      expect(sendteVarsler).toHaveLength(1);
      expect(sendteVarsler[0].til).toBe('kari@x.no');
      expect(sendteVarsler[0].opts.navn).toBe('Kari');
      expect(sendteVarsler[0].opts.harTilbud).toBe(false);
      expect(sendteVarsler[0].opts.pris).toBeNull();
    } finally { srv.close(); }
  });

  it('svar med pris markerer tilbud i varselet', async () => {
    reset();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/api/meldinger?bruker_id=9', { tekst: 'Tilbud', pris: 1500 });
      expect(r.status).toBe(201);
      expect(sendteVarsler).toHaveLength(1);
      expect(sendteVarsler[0].opts.harTilbud).toBe(true);
      expect(sendteVarsler[0].opts.pris).toBe(1500);
    } finally { srv.close(); }
  });

  it('KUNDE som sender melding gir INGEN e-post til kunden', async () => {
    reset();
    const srv = await lytt(lagApp(KUNDE));
    try {
      const r = await post(srv, '/api/meldinger', { tekst: 'Hei, jeg lurer på noe' });
      expect(r.status).toBe(201);
      expect(sendteVarsler).toHaveLength(0);
    } finally { srv.close(); }
  });

  it('ingen e-post når kunden mangler adresse', async () => {
    reset();
    state.kunde = { id: 9, navn: 'Kari', epost: null };
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/api/meldinger?bruker_id=9', { tekst: 'Svar uten adresse' });
      expect(r.status).toBe(201);
      expect(sendteVarsler).toHaveLength(0);
    } finally { srv.close(); }
  });

  it('fire-and-forget: e-postfeil velter ikke svaret (fortsatt 201)', async () => {
    reset();
    sendNyMeldingSvar = { ok: false, error: 'SMTP nede' };
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await post(srv, '/api/meldinger?bruker_id=9', { tekst: 'Svar tross feil' });
      expect(r.status).toBe(201);
      expect(r.body.melding.id).toBe(501);
      expect(sendteVarsler).toHaveLength(1); // forsøkt, men ok:false
    } finally { srv.close(); }
  });
});
