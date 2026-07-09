// describe/it/expect er globale (vitest.config.js -> globals: true).
// F10 — CSV-injection: felt som starter med =, +, -, @, TAB eller CR skal
// prefikses med apostrof FØR quoting, så Excel/Sheets ikke tolker dem som formel.
// Samme CJS-mønster som export.test.js: vi muterer db-singletonen.
const db = require('../../db');

const state = { bookings: [] };

db.isConfigured = () => true;
db.query = async (text /* , params */) => {
  if (/FROM bookings b/i.test(text) && /GROUP BY/i.test(text)) return { rows: [] };
  if (/FROM bookings b/i.test(text)) return { rows: state.bookings };
  return { rows: [] };
};

const express = require('express');
const router = require('../../routes/export');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/export', router);
  return app;
}
function lytt(app) {
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
}
async function get(srv, sti) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`);
  return { status: r.status, text: await r.text() };
}

const ANSATT = { id: 1, rolle: 'ansatt', navn: 'Ola' };

describe('F10 — CSV-injection i /api/export/bookings', () => {
  it('prefikser farlige felt (=,+,-,@) med apostrof, lar vanlige felt være', async () => {
    state.bookings = [
      {
        id: 1, dato: '2026-06-25', tid: '10:00', aktivitet: 'Kajakk',
        navn: '=cmd|/c calc', epost: '+47 900', tlf: '-500',
        antall: '@SUM(A1)', belop: 1200, status: 'bekreftet', opprettet: '2026-06-20T08:00:00Z',
      },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await get(srv, '/api/export/bookings?format=csv');
      expect(res.status).toBe(200);
      const linjer = res.text.replace(/^﻿/, '').split('\r\n');
      const felt = linjer[1].split(',');
      // felt: id,dato,tid,aktivitet,navn,epost,tlf,antall,...
      expect(felt[4]).toBe("'=cmd|/c calc");   // navn: farlig -> prefikset
      expect(felt[5]).toBe("'+47 900");         // epost: farlig -> prefikset
      expect(felt[6]).toBe('-500');             // tlf: rent negativt tall -> IKKE prefikset (forblir tall)
      expect(felt[7]).toBe("'@SUM(A1)");        // antall: farlig -> prefikset
      // Vanlige felt uendret.
      expect(felt[3]).toBe('Kajakk');
      expect(felt[1]).toBe('2026-06-25');
    } finally { srv.close(); }
  });

  it('felt med komma quotes fortsatt (quoting-oppførsel uendret), og komma-felt som IKKE er farlig prefikses ikke', async () => {
    state.bookings = [
      {
        id: 2, dato: '2026-06-26', tid: '11:00', aktivitet: 'Fisketur, hel dag',
        navn: 'Kari "Skipper" Nes', epost: 'kari@x.no', tlf: '99887766',
        antall: 2, belop: 900, status: 'forespurt', opprettet: '2026-06-21T08:00:00Z',
      },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await get(srv, '/api/export/bookings?format=csv');
      const rad = res.text.replace(/^﻿/, '').split('\r\n')[1];
      expect(rad).toContain('"Fisketur, hel dag"');       // komma -> quotet
      expect(rad).toContain('"Kari ""Skipper"" Nes"');    // fnutt -> doblet + quotet
      expect(rad).not.toContain("'Fisketur");             // ikke prefikset (starter ikke farlig)
    } finally { srv.close(); }
  });
});

// Tall-unntak: et felt som I SIN HELHET er et velformet tall (valgfritt minus,
// heltall/desimal med komma eller punktum) skal IKKE prefikses — Excel parser
// -500 og -1234,50 som TALL. Å prefikse dem gjorde negative beløp til tekst og
// brøt SUM-formler i regnearket (stille regresjon). Skillet mot farlige
// minus-uttrykk (-1+1, -A1) må stå svart på hvitt, det tapes lett i refaktor.
describe('F10 — tall-unntak: velformede tall prefikses IKKE (negative beløp forblir tall)', () => {
  it('lar rene tall stå uprefikset: -500 (heltall), -1234.50 (punktum), -1234,50 (komma)', async () => {
    state.bookings = [
      {
        id: 1, dato: '2026-06-25', tid: '10:00', aktivitet: 'Kajakk',
        navn: 'Ola', epost: 'o@x.no', tlf: '-500',
        antall: '-1234.50', belop: '-1234,50', status: 'bekreftet',
        opprettet: '2026-06-20T08:00:00Z',
      },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await get(srv, '/api/export/bookings?format=csv');
      expect(res.status).toBe(200);
      const rad = res.text.replace(/^﻿/, '').split('\r\n')[1];
      const felt = rad.split(',');
      // tlf=-500: negativt heltall -> uprefikset, ingen komma -> bart tall.
      expect(felt[6]).toBe('-500');
      expect(felt[6]).not.toBe("'-500");
      // antall=-1234.50: desimal med punktum -> uprefikset, ingen komma -> bart.
      expect(felt[7]).toBe('-1234.50');
      // belop=-1234,50: desimal med komma -> uprefikset MEN komma trigger quoting,
      // så det blir ETT quotet felt "-1234,50" (ikke splittet, ikke apostrof-prefikset).
      expect(rad).toContain('"-1234,50"');
      expect(rad).not.toContain("'-1234,50"); // dekker både bar apostrof og "'-1234,50"
    } finally { srv.close(); }
  });

  it('prefikser fortsatt farlige minus-uttrykk: -1+1, -A1, -cmd', async () => {
    state.bookings = [
      {
        id: 2, dato: '2026-06-26', tid: '11:00', aktivitet: 'Kajakk',
        navn: '-1+1', epost: '-A1', tlf: '-cmd',
        antall: 3, belop: 900, status: 'bekreftet', opprettet: '2026-06-21T08:00:00Z',
      },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await get(srv, '/api/export/bookings?format=csv');
      const rad = res.text.replace(/^﻿/, '').split('\r\n')[1];
      const felt = rad.split(',');
      expect(felt[4]).toBe("'-1+1");   // minus + uttrykk -> ikke tall -> prefikset
      expect(felt[5]).toBe("'-A1");    // minus + cellereferanse -> prefikset
      expect(felt[6]).toBe("'-cmd");   // minus + tekst -> prefikset
    } finally { srv.close(); }
  });

  it('prefikser fortsatt =SUM, +1 (bar pluss), @foo, telefon, TAB-start og CR-start', async () => {
    state.bookings = [
      {
        id: 3, dato: '2026-06-27', tid: '12:00', aktivitet: 'Kajakk',
        navn: '=SUM(A1)', epost: '+1', tlf: '@foo',
        antall: '+47 900 12 345', belop: '\tfoo', status: '\rbar',
        opprettet: '2026-06-22T08:00:00Z',
      },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await get(srv, '/api/export/bookings?format=csv');
      const rad = res.text.replace(/^﻿/, '').split('\r\n')[1];
      const felt = rad.split(',');
      expect(felt[4]).toBe("'=SUM(A1)");        // formel -> prefikset
      expect(felt[5]).toBe("'+1");              // ledende + -> prefikset (ikke unntatt)
      expect(felt[6]).toBe("'@foo");            // @ -> prefikset
      expect(felt[7]).toBe("'+47 900 12 345");  // telefon: + + mellomrom -> ikke tall -> prefikset
      expect(felt[8]).toBe("'\tfoo");           // TAB-start -> prefikset
      expect(felt[9]).toBe("\"'\rbar\"");       // CR-start -> prefikset, så quotet pga \r
    } finally { srv.close(); }
  });
});
