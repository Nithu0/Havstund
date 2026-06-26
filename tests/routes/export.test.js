// describe/it/expect er globale (vitest.config.js -> globals: true)
// Tester /api/export: CSV-serialisering (escaping av komma/fnutt/linjeskift),
// rolle-gating (requireRole), og omsetning-aggregat (LEFT JOIN -> NULL-aktivitet).
// CJS-mønster: vi muterer db-singletonen (samme ref som routes/export.js holder).
const express = require('express');

const db = require('../../db');

// Styrer hva db.query returnerer per kall basert pa SQL-teksten.
const state = { bookings: [], omsetning: [] };

db.isConfigured = () => true;
db.query = async (text /* , params */) => {
  if (/FROM bookings b/i.test(text) && /GROUP BY/i.test(text)) {
    return { rows: state.omsetning };
  }
  if (/FROM bookings b/i.test(text)) {
    return { rows: state.bookings };
  }
  return { rows: [] };
};

const router = require('../../routes/export');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/export', router);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function get(srv, sti) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`);
  const text = await r.text();
  return { status: r.status, ct: r.headers.get('content-type'), cd: r.headers.get('content-disposition'), text };
}

const ANSATT = { id: 1, rolle: 'ansatt', navn: 'Ola' };

describe('GET /api/export/bookings', () => {
  it('CSV-serialisering escaper komma og fnutter', async () => {
    state.bookings = [
      {
        id: 1, dato: '2026-06-25', tid: '10:00', aktivitet: 'Fisketur, hel dag',
        navn: 'Kari "Skipper" Nes', epost: 'kari@x.no', tlf: '99887766',
        antall: 2, belop: 1200, status: 'bekreftet', opprettet: '2026-06-20T08:00:00Z',
      },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await get(srv, '/api/export/bookings?format=csv');
      expect(res.status).toBe(200);
      expect(res.ct).toMatch(/text\/csv/);
      expect(res.cd).toMatch(/attachment; filename="bookinger\.csv"/);

      const linjer = res.text.replace(/^﻿/, '').split('\r\n');
      expect(linjer[0]).toBe('id,dato,tid,aktivitet,navn,epost,tlf,antall,belop,status,opprettet');
      // Felt med komma pakkes i fnutter; felt med fnutt far doblede fnutter.
      expect(linjer[1]).toContain('"Fisketur, hel dag"');
      expect(linjer[1]).toContain('"Kari ""Skipper"" Nes"');
    } finally { srv.close(); }
  });

  it('403 for kunde-rolle (requireRole blokkerer)', async () => {
    const srv = await lytt(lagApp({ id: 9, rolle: 'kunde', navn: 'Per' }));
    try {
      const res = await get(srv, '/api/export/bookings?format=csv');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });

  it('401 nar ikke innlogget', async () => {
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await get(srv, '/api/export/bookings?format=csv');
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });
});

describe('GET /api/export/omsetning', () => {
  it('CSV per aktivitet; NULL-aktivitet blir "(ukjent aktivitet)"', async () => {
    state.omsetning = [
      { aktivitet: 'Kajakk', antall_bookinger: 3, antall_personer: 7, omsetning: 4900 },
      { aktivitet: null, antall_bookinger: 1, antall_personer: 1, omsetning: 500 },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await get(srv, '/api/export/omsetning?format=csv');
      expect(res.status).toBe(200);
      expect(res.cd).toMatch(/omsetning\.csv/);
      const linjer = res.text.replace(/^﻿/, '').split('\r\n');
      expect(linjer[0]).toBe('aktivitet,antall_bookinger,antall_personer,omsetning');
      expect(linjer[1]).toBe('Kajakk,3,7,4900');
      expect(linjer[2]).toBe('(ukjent aktivitet),1,1,500');
    } finally { srv.close(); }
  });
});
