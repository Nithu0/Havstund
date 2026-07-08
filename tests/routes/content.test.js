// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester /api/content (offentlig, kun-lese speil av CMS-tabellen):
//  - HARD whitelist: 404 på ukjent nøkkel (før DB engang røres),
//  - kjente nøkler normaliseres til tospråklig {no,en},
//  - JSON-verdi {no,en} bevares; ren tekst speiles til begge språk,
//  - manglende rad -> tom {no,en} (forsiden faller tilbake til HTML).
// CJS-mønster (jf. insights.test.js): vi muterer db-singletonen — samme ref
// som routes/content.js holder.
const express = require('express');

const db = require('../../db');

// Styrer hva db.query/db.one returnerer per kall. rows = innhold i "tabellen".
const state = { rows: [] };

db.isConfigured = () => true;
db.query = async () => ({ rows: state.rows.slice() });
db.one = async (_text, params) => {
  const nokkel = params && params[0];
  return state.rows.find((r) => r.nokkel === nokkel) || null;
};

const router = require('../../routes/content');

function lagApp() {
  const app = express();
  app.use('/api/content', router);
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
  return { status: r.status, body, cache: r.headers.get('cache-control') };
}

describe('GET /api/content/:nokkel — HARD whitelist', () => {
  it('404 på ukjent nøkkel (også når nøkkelen finnes i tabellen)', async () => {
    // "kontakt.epost" finnes i CMS men er IKKE whitelistet -> skal ikke lekke.
    state.rows = [{ nokkel: 'kontakt.epost', verdi: 'post@havstund.no' }];
    const srv = await lytt(lagApp());
    try {
      const ukjent = await getJson(srv, '/api/content/kontakt.epost');
      expect(ukjent.status).toBe(404);
      const rando = await getJson(srv, '/api/content/finnes-ikke');
      expect(rando.status).toBe(404);
    } finally { srv.close(); }
  });

  it('200 + tospråklig {no,en} for whitelistet JSON-verdi', async () => {
    state.rows = [
      { nokkel: 'hero_sitat', verdi: JSON.stringify({ no: 'Et øyeblikk med havet', en: 'A moment with the sea' }) },
    ];
    const srv = await lytt(lagApp());
    try {
      const res = await getJson(srv, '/api/content/hero_sitat');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        nokkel: 'hero_sitat',
        verdi: { no: 'Et øyeblikk med havet', en: 'A moment with the sea' },
      });
      expect(res.cache).toMatch(/max-age=60/);
    } finally { srv.close(); }
  });

  it('ren tekst speiles til begge språk', async () => {
    state.rows = [{ nokkel: 'kampanje_banner', verdi: 'Sommeråpent!' }];
    const srv = await lytt(lagApp());
    try {
      const res = await getJson(srv, '/api/content/kampanje_banner');
      expect(res.status).toBe(200);
      expect(res.body.verdi).toEqual({ no: 'Sommeråpent!', en: 'Sommeråpent!' });
    } finally { srv.close(); }
  });

  it('manglende rad -> tom {no,en} (HTML-fallback på forsiden)', async () => {
    state.rows = [];
    const srv = await lytt(lagApp());
    try {
      const res = await getJson(srv, '/api/content/nyheter');
      expect(res.status).toBe(200);
      expect(res.body.verdi).toEqual({ no: '', en: '' });
    } finally { srv.close(); }
  });
});

describe('GET /api/content — samlet, kun whitelistede nøkler', () => {
  it('returnerer alle tre whitelistede nøkler og ingen andre', async () => {
    state.rows = [
      { nokkel: 'nyheter', verdi: JSON.stringify({ no: 'Nytt kurs', en: 'New course' }) },
      { nokkel: 'kontakt.epost', verdi: 'post@havstund.no' }, // ikke-whitelistet
    ];
    const srv = await lytt(lagApp());
    try {
      const res = await getJson(srv, '/api/content');
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['hero_sitat', 'kampanje_banner', 'nyheter']);
      expect(res.body.nyheter).toEqual({ no: 'Nytt kurs', en: 'New course' });
      expect(res.body).not.toHaveProperty('kontakt.epost');
      expect(res.cache).toMatch(/max-age=60/);
    } finally { srv.close(); }
  });
});
