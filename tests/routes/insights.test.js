// describe/it/expect er globale (vitest.config.js -> globals: true)
// Tester /api/insights:
//  - activity-stats: aggregat per aktivitet, NULL-aktivitet -> "(ukjent aktivitet)",
//    omsetning kun for bekreftet/fullfort (status-filter sendes som $1-param).
//  - customer-metrics: CLV per kunde (sum belop).
//  - rolle-gating (requireRole): 401 uten innlogging, 403 for kunde.
// CJS-monster (jf. export.test.js): vi muterer db-singletonen — samme ref som
// routes/insights.js holder.
const express = require('express');

const db = require('../../db');

// Styrer hva db.query returnerer per kall basert pa SQL-teksten.
// Fanger ogsa siste params slik at vi kan verifisere at status-filteret sendes.
const state = { activity: [], customers: [], sisteParams: null };

db.isConfigured = () => true;
db.query = async (text, params) => {
  state.sisteParams = params;
  if (/FROM bookings b/i.test(text) && /lower\(b\.epost\)/i.test(text)) {
    return { rows: state.customers };
  }
  if (/FROM bookings b/i.test(text) && /GROUP BY a\.id/i.test(text)) {
    return { rows: state.activity };
  }
  return { rows: [] };
};

const router = require('../../routes/insights');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/insights', router);
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

const ANSATT = { id: 1, rolle: 'ansatt', navn: 'Ola' };

describe('GET /api/insights/activity-stats', () => {
  it('returnerer aggregat per aktivitet; NULL-aktivitet blir "(ukjent aktivitet)"', async () => {
    state.activity = [
      { activity_id: 1, aktivitet: 'Kajakk', antall_bookinger: 3, antall_personer: 7, omsetning: '4900' },
      { activity_id: null, aktivitet: null, antall_bookinger: 1, antall_personer: 1, omsetning: '500' },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await getJson(srv, '/api/insights/activity-stats');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toEqual({
        activity_id: 1, aktivitet: 'Kajakk',
        antall_bookinger: 3, antall_personer: 7, omsetning: 4900,
      });
      // NULL-aktivitet faller tilbake til etikett, omsetning blir Number
      expect(res.body[1].aktivitet).toBe('(ukjent aktivitet)');
      expect(res.body[1].omsetning).toBe(500);
      // status-filter sendes som forste param (kun bekreftet/fullfort teller)
      expect(state.sisteParams).toEqual([['bekreftet', 'fullfort']]);
    } finally { srv.close(); }
  });

  it('401 nar ikke innlogget', async () => {
    const srv = await lytt(lagApp(undefined));
    try {
      const res = await getJson(srv, '/api/insights/activity-stats');
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });

  it('403 for kunde-rolle (requireRole blokkerer)', async () => {
    const srv = await lytt(lagApp({ id: 9, rolle: 'kunde', navn: 'Per' }));
    try {
      const res = await getJson(srv, '/api/insights/activity-stats');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });
});

describe('GET /api/insights/customer-metrics', () => {
  it('returnerer CLV per kunde (sum belop) som Number', async () => {
    state.customers = [
      { epost: 'kari@x.no', navn: 'Kari', antall_bookinger: 2, clv: '3200',
        forste_booking: '2026-01-01T00:00:00Z', siste_booking: '2026-06-01T00:00:00Z' },
      { epost: 'per@x.no', navn: 'Per', antall_bookinger: 1, clv: '800',
        forste_booking: '2026-05-01T00:00:00Z', siste_booking: '2026-05-01T00:00:00Z' },
    ];
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await getJson(srv, '/api/insights/customer-metrics');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ epost: 'kari@x.no', navn: 'Kari', antall_bookinger: 2, clv: 3200 });
      expect(typeof res.body[0].clv).toBe('number');
      expect(state.sisteParams).toEqual([['bekreftet', 'fullfort']]);
    } finally { srv.close(); }
  });

  it('403 for kunde-rolle', async () => {
    const srv = await lytt(lagApp({ id: 9, rolle: 'kunde', navn: 'Per' }));
    try {
      const res = await getJson(srv, '/api/insights/customer-metrics');
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });
});
