// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
//
// Av/på-bevis for AI-brain-shimen (DESIGN §3/§9):
//  - BRAIN_ENABLED=false -> ingen rute registreres (rutebord upåvirket)
//  - BRAIN_ENABLED=true  -> /api/brain/ask:
//       anon            -> 401
//       ikke-admin      -> 403
//       admin uten flag -> 403
//       utvalgt admin   -> 200 (proxy treffer brain; vi stubber fetch)
//
// CJS-mønster (jf. hours.test.js): vi muterer db-singletonen som shimen ser via
// require(). Vi monterer shimen på en fersk express-app per scenario.
const express = require('express');
const http = require('http');

const db = require('../../db');

// Stub db.one for utvalgt-sjekken (SELECT ai_agent_enabled ...).
db.isConfigured = () => true;
let aiEnabledFor = {}; // { [userId]: boolean }
db.one = async (text, params) => {
  if (/ai_agent_enabled/i.test(text)) {
    const id = params && params[0];
    return { ai_agent_enabled: !!aiEnabledFor[id] };
  }
  return null;
};

function lagApp(user, brainEnabled) {
  process.env.BRAIN_ENABLED = brainEnabled ? 'true' : 'false';
  process.env.BRAIN_URL = 'http://brain.test';
  process.env.BRAIN_OPERATOR_TOKEN = 'optoken';

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });

  // Frisk require av shimen så BRAIN_ENABLED leses på nytt per scenario.
  delete require.cache[require.resolve('../../integrations/brain-shim')];
  const shim = require('../../integrations/brain-shim');
  shim(app);

  // Markør-rute etterpå: hvis shimen registrerte /api/brain/ask, treffer den
  // FØR denne. Hvis ikke (av), faller alt til markøren = bevis på "ingen rute".
  app.post('/api/brain/ask', (_req, res) => res.status(599).json({ markor: true }));
  return app;
}

function lytt(app) {
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}
async function post(srv, sti, body) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let b = null; try { b = await r.json(); } catch { b = null; }
  return { status: r.status, body: b };
}

const ANON = null;
const KUNDE = { id: 2, rolle: 'kunde', navn: 'Kari' };
const ADMIN_FLAG = { id: 10, rolle: 'admin', navn: 'Sjef' };
const ADMIN_UTEN = { id: 11, rolle: 'admin', navn: 'Annen' };

let origFetch;
beforeEach(() => {
  aiEnabledFor = { 10: true, 11: false };
  origFetch = global.fetch;
});
afterEach(() => {
  global.fetch = origFetch;
  delete process.env.BRAIN_ENABLED;
  delete process.env.BRAIN_URL;
  delete process.env.BRAIN_OPERATOR_TOKEN;
});

describe('BRAIN_ENABLED=false — ingen rute registreres', () => {
  it('/api/brain/ask faller til markør (599) — shimen registrerte ingenting', async () => {
    const srv = await lytt(lagApp(ADMIN_FLAG, false));
    try {
      const res = await post(srv, '/api/brain/ask', { text: 'hei' });
      expect(res.status).toBe(599); // markøren, ikke shimen
      expect(res.body && res.body.markor).toBe(true);
    } finally { srv.close(); }
  });
});

describe('BRAIN_ENABLED=true — gating', () => {
  it('anon -> 401', async () => {
    const srv = await lytt(lagApp(ANON, true));
    try {
      const res = await post(srv, '/api/brain/ask', { text: 'hei' });
      expect(res.status).toBe(401);
    } finally { srv.close(); }
  });

  it('ikke-admin (kunde) -> 403', async () => {
    const srv = await lytt(lagApp(KUNDE, true));
    try {
      const res = await post(srv, '/api/brain/ask', { text: 'hei' });
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });

  it('admin UTEN ai_agent_enabled -> 403', async () => {
    const srv = await lytt(lagApp(ADMIN_UTEN, true));
    try {
      const res = await post(srv, '/api/brain/ask', { text: 'hei' });
      expect(res.status).toBe(403);
    } finally { srv.close(); }
  });

  it('utvalgt admin -> 200 (proxy til brain stubbet)', async () => {
    global.fetch = async () =>
      new Response(JSON.stringify({ kind: 'final', text: 'Hei!', conversationId: 'c1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const srv = await lytt(lagApp(ADMIN_FLAG, true));
    try {
      const res = await post(srv, '/api/brain/ask', { text: 'hei' });
      expect(res.status).toBe(200);
      expect(res.body.text).toBe('Hei!');
    } finally { srv.close(); }
  });
});
