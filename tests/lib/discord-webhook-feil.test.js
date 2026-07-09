// describe/it/expect/vi er globale (vitest.config.js -> globals: true).
// F25 — lib/discord skal ikke svelge webhook-feil i stillhet:
//  - ikke-ok svar (400 osv.) logges via lib/logger med status + body-utdrag,
//  - 429 gir ÉN retry som respekterer retry_after fra Discord-svaret,
//  - en Discord-feil skal ALDRI velte kallet som utløste den (fire-and-forget).
// MERK: env settes FØR require, og vi resetModules IKKE — slik peker discord sin
// logger-referanse på samme instans som vi spionerer på her.
process.env.DISCORD_WEBHOOK_GENERAL = 'https://discord.test/webhook';
const { logger } = require('../../lib/logger');
const discord = require('../../lib/discord');

const B = { id: 1, navn: 'Ola', tlf: '123', epost: 'ola@test.no', dato: '2026-07-01', antall: 2, melding: 'Hei' };

function svar(opts) {
  return {
    ok: opts.ok,
    status: opts.status,
    text: async () => opts.body || '',
    clone: () => ({ json: async () => opts.json || {} }),
  };
}

describe('F25 — discord webhook-feilhåndtering', () => {
  const ekteFetch = global.fetch;
  let warnSpy;

  beforeEach(() => { warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {}); });
  afterEach(() => { global.fetch = ekteFetch; warnSpy.mockRestore(); });

  it('logger status + body-utdrag når svaret ikke er ok (400)', async () => {
    let kall = 0;
    global.fetch = async () => { kall++; return svar({ ok: false, status: 400, body: 'Embed for long' }); };
    await expect(discord.bookingVarsel(B, 'Fisketur')).resolves.toBeUndefined();
    expect(kall).toBe(1); // 400 er ikke 429 -> ingen retry
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const arg = warnSpy.mock.calls[0][0];
    expect(arg.status).toBe(400);
    expect(arg.body).toContain('Embed for long');
  });

  it('gjør ÉN retry ved 429 og respekterer retry_after', async () => {
    let kall = 0;
    global.fetch = async () => {
      kall++;
      if (kall === 1) return svar({ ok: false, status: 429, json: { retry_after: 0.05 } });
      return svar({ ok: true, status: 204 });
    };
    const start = Date.now();
    await expect(discord.bookingVarsel(B, 'Fisketur')).resolves.toBeUndefined();
    const brukt = Date.now() - start;
    expect(kall).toBe(2);                     // nøyaktig én retry
    expect(brukt).toBeGreaterThanOrEqual(40); // ventet ~retry_after (50ms)
    expect(warnSpy).not.toHaveBeenCalled();   // andre forsøk var ok
  });

  it('en kastende fetch velter IKKE kalleren (fire-and-forget)', async () => {
    global.fetch = async () => { throw new Error('nettverk nede'); };
    await expect(discord.bookingVarsel(B, 'Fisketur')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][1]).toMatch(/Discord-varsling feilet/);
  });
});
