// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// Fase 6 — allowlist: agent-rollen skal slippe gjennom POST /api/regnskap/poster
// (bekreftet skriving av en regnskapspost fra AI-hjernen). Vi tester middleware-
// laget direkte (agentRuteTillatt + agentGate) — ruta selv finnes i
// routes/regnskap.js og eies av et annet lag; her bevises KUN autorisasjonen.
const { agentRuteTillatt, agentGate, AGENT_ALLOWLIST } = require('../../lib/agent-auth');

function req(method, originalUrl, extra = {}) {
  return { method, originalUrl, ...extra };
}
function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('Fase 6 — allowlist for POST /api/regnskap/poster', () => {
  it('POST /api/regnskap/poster er allowlistet', () => {
    expect(agentRuteTillatt(req('POST', '/api/regnskap/poster'))).toBe(true);
  });

  it('POST /api/regnskap/poster/ (trailing slash) er allowlistet', () => {
    expect(agentRuteTillatt(req('POST', '/api/regnskap/poster/'))).toBe(true);
  });

  it('POST /api/regnskap/poster med query-streng er allowlistet', () => {
    expect(agentRuteTillatt(req('POST', '/api/regnskap/poster?kilde=agent'))).toBe(true);
  });

  it('følger samme mønster som timer: entry finnes i AGENT_ALLOWLIST', () => {
    const finnes = AGENT_ALLOWLIST.some(
      (r) => r.method === 'POST' && r.re.test('/api/regnskap/poster'),
    );
    expect(finnes).toBe(true);
  });

  it('GET /api/regnskap/poster er IKKE allowlistet (kun POST ble lagt til)', () => {
    expect(agentRuteTillatt(req('GET', '/api/regnskap/poster'))).toBe(false);
  });

  it('DELETE /api/regnskap/poster/1 er IKKE allowlistet', () => {
    expect(agentRuteTillatt(req('DELETE', '/api/regnskap/poster/1'))).toBe(false);
  });

  it('agentGate slipper en agent-request på POST /poster gjennom (ingen 403)', () => {
    const r = req('POST', '/api/regnskap/poster', { isAgent: true });
    const res = fakeRes();
    let nesteKalt = false;
    agentGate(r, res, () => { nesteKalt = true; });
    expect(nesteKalt).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('agentGate blokkerer en agent-request på en ikke-allowlistet regnskap-rute (403)', () => {
    const r = req('DELETE', '/api/regnskap/poster/1', { isAgent: true });
    const res = fakeRes();
    let nesteKalt = false;
    agentGate(r, res, () => { nesteKalt = true; });
    expect(nesteKalt).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});
