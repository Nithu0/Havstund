// describe/it/expect er globale (vitest.config.js -> globals: true)
// Tester GET /api/regnskap/pakke/:maaned (Fase 3b leverings-ruta):
//  - ugyldig :maaned-format -> 400
//  - rolle-gating: ansatt -> 403, admin -> 200 (route-nivaa requireRole('admin'))
//  - happy-path -> 200 med { pakke, manifest }, manifest.sha256 finnes
//  - REGNSKAP_PAKKE_SECRET satt -> signert=true + signatur; usatt -> signert=false, null
//  - generator kaster (ubalansert rad) -> 422, ikke 500
//  - tom maned -> 200 med tom pakke
// CJS-monster (jf. insights.test.js/export.test.js): vi muterer db-singletonen —
// samme ref som routes/regnskap.js (og lib/audit.js) holder. requireRole er ekte;
// req.user injiseres av en test-middleware slik at rolle-gaten testes pa ekte.
const express = require('express');

const db = require('../../db');

// Styrer hva db.query returnerer, valgt paa SQL-teksten (tabellnavn).
const state = { poster: [], timeforinger: [], ansatte: [], dagsoppgjor: [] };

db.isConfigured = () => true;
db.query = async (text) => {
  if (/INSERT INTO audit_log/i.test(text)) return { rows: [] };
  if (/FROM regnskap_poster/i.test(text)) return { rows: state.poster };
  if (/FROM timeforinger/i.test(text)) return { rows: state.timeforinger };
  if (/FROM ansatte/i.test(text)) return { rows: state.ansatte };
  if (/FROM dagsoppgjor/i.test(text)) return { rows: state.dagsoppgjor };
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

async function getJson(srv, sti) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`);
  let body = null;
  try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
}

const ADMIN = { id: 1, rolle: 'admin', navn: 'Sjefen' };
const ANSATT = { id: 2, rolle: 'ansatt', navn: 'Ola' };

// En balansert inntektspost: brutto 12500, sats 25 -> netto 10000, mva 2500.
function balansertPost() {
  return {
    id: 1, type: 'inntekt', dato: '2026-05-10', beskrivelse: 'Kajakktur',
    konto: 3000, mva_sats: 25, netto_ore: 10000, mva_ore: 2500, brutto_ore: 12500,
    betalingsmetode: 'kort', kilde: 'manuell', booking_id: null,
  };
}

function nullstill() {
  state.poster = [];
  state.timeforinger = [];
  state.ansatte = [];
  state.dagsoppgjor = [];
  delete process.env.REGNSKAP_PAKKE_SECRET;
}

describe('GET /api/regnskap/pakke/:maaned', () => {
  it('400 ved ugyldig maaned-format', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await getJson(srv, '/api/regnskap/pakke/2026-5');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/YYYY-MM/);
    } finally { srv.close(); }
  });

  it('403 for ansatt-rolle (route-nivaa requireRole admin blokkerer)', async () => {
    nullstill();
    state.poster = [balansertPost()];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await getJson(srv, '/api/regnskap/pakke/2026-05');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });

  it('200 for admin: svar har pakke + manifest, manifest har sha256', async () => {
    nullstill();
    state.poster = [balansertPost()];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await getJson(srv, '/api/regnskap/pakke/2026-05');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('pakke');
      expect(res.body).toHaveProperty('manifest');
      expect(res.body.pakke.periode).toBe('2026-05');
      expect(res.body.pakke.kontrollsum.antall_bilag).toBe(1);
      expect(res.body.pakke.kontrollsum.brutto_ore).toBe(12500);
      expect(typeof res.body.manifest.sha256).toBe('string');
      expect(res.body.manifest.sha256).toHaveLength(64);
    } finally { srv.close(); }
  });

  it('sha256 i manifest matcher JSON.stringify(pakke) fra svaret (kanonisk)', async () => {
    nullstill();
    state.poster = [balansertPost()];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await getJson(srv, '/api/regnskap/pakke/2026-05');
      const crypto = require('crypto');
      const forventet = crypto.createHash('sha256')
        .update(JSON.stringify(res.body.pakke), 'utf8').digest('hex');
      expect(res.body.manifest.sha256).toBe(forventet);
    } finally { srv.close(); }
  });

  it('REGNSKAP_PAKKE_SECRET satt -> signert=true + signatur finnes', async () => {
    nullstill();
    process.env.REGNSKAP_PAKKE_SECRET = 'hemmelig-noekkel-for-test';
    state.poster = [balansertPost()];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await getJson(srv, '/api/regnskap/pakke/2026-05');
      expect(res.status).toBe(200);
      expect(res.body.manifest.signert).toBe(true);
      expect(typeof res.body.manifest.signatur).toBe('string');
      expect(res.body.manifest.signatur).toHaveLength(64);

      // Signaturen skal matche HMAC over samme kanoniske streng.
      const crypto = require('crypto');
      const forventet = crypto.createHmac('sha256', 'hemmelig-noekkel-for-test')
        .update(JSON.stringify(res.body.pakke), 'utf8').digest('hex');
      expect(res.body.manifest.signatur).toBe(forventet);
    } finally {
      delete process.env.REGNSKAP_PAKKE_SECRET;
      srv.close();
    }
  });

  it('REGNSKAP_PAKKE_SECRET usatt -> signert=false, signatur=null, ingen 500', async () => {
    nullstill();
    state.poster = [balansertPost()];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await getJson(srv, '/api/regnskap/pakke/2026-05');
      expect(res.status).toBe(200);
      expect(res.body.manifest.signert).toBe(false);
      expect(res.body.manifest.signatur).toBe(null);
    } finally { srv.close(); }
  });

  it('generator kaster (ubalansert rad) -> 422, ikke 500', async () => {
    nullstill();
    // brutto 50000 men netto+mva = 40000 -> invariant 1 brytes -> kast.
    state.poster = [{
      id: 7, type: 'inntekt', dato: '2026-05-03', beskrivelse: 'Skjev post',
      konto: 3000, mva_sats: 25, netto_ore: 30000, mva_ore: 10000, brutto_ore: 50000,
      betalingsmetode: 'kort', kilde: 'manuell', booking_id: null,
    }];
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await getJson(srv, '/api/regnskap/pakke/2026-05');
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/balanserer|persondata/i);
    } finally { srv.close(); }
  });

  it('tom maned -> 200 med tom pakke', async () => {
    nullstill();
    const srv = await lytt(lagApp(ADMIN));
    try {
      const res = await getJson(srv, '/api/regnskap/pakke/2026-05');
      expect(res.status).toBe(200);
      expect(res.body.pakke.bilag).toEqual([]);
      expect(res.body.pakke.kontrollsum.antall_bilag).toBe(0);
      expect(res.body.pakke.kontrollsum.brutto_ore).toBe(0);
    } finally { srv.close(); }
  });
});
