// describe/it/expect er globale (vitest.config.js -> globals: true).
// vi.mock fanger ikke CJS require(), saa vi muterer singletonene direkte:
//   - db (require('../../db'))   -> in-memory stubb
//   - audit (require('../../lib/audit')) -> spion paa writeAudit
// Bekrefter at writeAudit kalles fire-and-forget paa minst to handlinger
// (login i routes/auth.js og CMS-endring i routes/admin.js).
const express = require('express');

const db = require('../../db');
const audit = require('../../lib/audit');
const { hashPassword } = require('../../lib/auth');

// --- Spion paa lib/audit.writeAudit (samme objekt-ref som rutene holder) ---
const auditCalls = [];
const orig = audit.writeAudit;
audit.writeAudit = async (actor, handling, detaljer) => {
  auditCalls.push({ actor, handling, detaljer });
  return { ok: true };
};

// --- In-memory db-stubb paa db-singletonen ---
const state = { loginHash: null };

db.isConfigured = () => true;

db.one = async (text, params) => {
  // auth.js login: hent bruker m/ passord_hash
  if (/SELECT id, navn, epost, rolle, passord_hash FROM users/i.test(text)) {
    return {
      id: 7, navn: 'Test', epost: params[0], rolle: 'admin', passord_hash: state.loginHash,
    };
  }
  // admin.js content-PUT upsert
  if (/INSERT INTO content/i.test(text)) {
    return { nokkel: params[0], verdi: params[1], oppdatert: new Date().toISOString() };
  }
  return null;
};

db.query = async () => ({ rows: [] });

const authRouter = require('../../routes/auth');
const adminRouter = require('../../routes/admin');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  if (user) app.use((req, _res, next) => { req.user = user; next(); });
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);
  return app;
}

function lytt(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve(srv));
  });
}

async function req(srv, sti, method, body) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await r.json(); } catch { /* tomt */ }
  return { status: r.status, data };
}

const ADMIN = { id: 7, rolle: 'admin', navn: 'Test' };

describe('audit-wiring — writeAudit kalles fire-and-forget', () => {
  beforeEach(async () => {
    auditCalls.length = 0;
    state.loginHash = await hashPassword('riktigPass1');
  });

  afterAll(() => { audit.writeAudit = orig; });

  it('vellykket login skriver audit "login"', async () => {
    const srv = await lytt(lagApp(null));
    try {
      const r = await req(srv, '/api/auth/login', 'POST', {
        epost: 'sjef@havstund.no', passord: 'riktigPass1',
      });
      expect(r.status).toBe(200);
      const login = auditCalls.find((c) => c.handling === 'login');
      expect(login).toBeTruthy();
      expect(login.actor.id).toBe(7);
    } finally { srv.close(); }
  });

  it('CMS-endring (content PUT) skriver audit "cms:endret" med nokkel', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      const r = await req(srv, '/api/admin/content/forside_tittel', 'PUT', { verdi: 'Hei' });
      expect(r.status).toBe(200);
      const cms = auditCalls.find((c) => c.handling === 'cms:endret');
      expect(cms).toBeTruthy();
      expect(cms.detaljer.nokkel).toBe('forside_tittel');
    } finally { srv.close(); }
  });

  it('til sammen er minst to ulike handlinger revisjonssporet', async () => {
    const srv = await lytt(lagApp(ADMIN));
    try {
      await req(srv, '/api/auth/login', 'POST', {
        epost: 'sjef@havstund.no', passord: 'riktigPass1',
      });
      await req(srv, '/api/admin/content/forside_tittel', 'PUT', { verdi: 'Hei' });
      const handlinger = new Set(auditCalls.map((c) => c.handling));
      expect(handlinger.size).toBeGreaterThanOrEqual(2);
    } finally { srv.close(); }
  });
});
