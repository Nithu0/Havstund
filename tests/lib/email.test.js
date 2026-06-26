// describe/it/expect er globale (vitest.config.js -> globals: true)
const email = require('../../lib/email');

describe('lib/email', () => {
  // Rydd SMTP-env før hver test så vi tester deterministisk.
  const lagret = {};
  const NOKLER = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'POST_FROM'];

  beforeEach(() => {
    for (const k of NOKLER) { lagret[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of NOKLER) {
      if (lagret[k] === undefined) delete process.env[k];
      else process.env[k] = lagret[k];
    }
  });

  it('isConfigured er false uten SMTP-env', () => {
    expect(email.isConfigured()).toBe(false);
  });

  it('isConfigured er true når host/user/pass er satt', () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    expect(email.isConfigured()).toBe(true);
  });

  it('sendStatusEpost resolver uten kast når ikke konfigurert (simulert)', async () => {
    const res = await email.sendStatusEpost('kunde@test.no', 'Ola', { id: 1 }, 'bekreftet');
    expect(res).toMatchObject({ ok: false, simulert: true });
  });

  it('byggMelding lager emne + tekst med status og navn', () => {
    const m = email.byggMelding('Kari', { id: 7, aktivitet: 'Fisketur', dato: '2026-07-01' }, 'bekreftet');
    expect(m.emne).toContain('bekreftet');
    expect(m.tekst).toContain('Hei Kari');
    expect(m.tekst).toContain('Fisketur');
    expect(m.tekst).toContain('7');
  });
});
