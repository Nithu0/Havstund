// describe/it/expect er globale (vitest.config.js -> globals: true)
// F27 — "du har fått et svar/tilbud"-varsel: branded layout, innholdslost
// (ingen meldingstekst i e-post), og fire-and-forget-kontrakt (kaster aldri).
const email = require('../../lib/email');

const NOKLER = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'POST_FROM', 'POST_BASE_URL'];

describe('lib/email - byggNyMeldingMelding', () => {
  const lagretBase = {};
  beforeEach(() => { lagretBase.v = process.env.POST_BASE_URL; delete process.env.POST_BASE_URL; });
  afterEach(() => {
    if (lagretBase.v === undefined) delete process.env.POST_BASE_URL;
    else process.env.POST_BASE_URL = lagretBase.v;
  });

  it('svar uten tilbud: hilser med navn og ber kunden logge inn (ingen meldingstekst)', () => {
    const m = email.byggNyMeldingMelding({ navn: 'Kari' });
    expect(m.emne.toLowerCase()).toContain('svar');
    expect(m.tekst).toContain('Hei Kari');
    expect(m.tekst).toContain('Min side');
    expect(m.tekst).not.toContain('Foreslått pris');
  });

  it('med tilbud/pris: emne og tekst nevner tilbud + prisen', () => {
    const m = email.byggNyMeldingMelding({ navn: 'Kari', harTilbud: true, pris: 1500 });
    expect(m.emne.toLowerCase()).toContain('tilbud');
    expect(m.tekst).toContain('tilbud');
    expect(m.tekst).toContain('1500');
  });

  it('pris uten eksplisitt harTilbud regnes også som tilbud', () => {
    const m = email.byggNyMeldingMelding({ navn: 'Kari', pris: 999 });
    expect(m.emne.toLowerCase()).toContain('tilbud');
    expect(m.tekst).toContain('999');
  });

  it('HTML bruker branded layout med absolutt logo-URL (Gmail-trygt, ingen <style>)', () => {
    const m = email.byggNyMeldingMelding({ navn: 'Kari' });
    expect(m.html).toContain('https://havstund.no/bilder/wordmark.png');
    expect(m.html).toContain('alt="Havstund"');
    expect(m.html).not.toContain('<style');
    expect(m.html).toContain('style=');
  });
});

describe('lib/email - sendNyMelding (mock transport)', () => {
  const nodemailer = require('nodemailer');
  const ekteCreateTransport = nodemailer.createTransport;
  const lagret = {};
  let sisteSendMail;

  beforeEach(() => {
    for (const k of NOKLER) { lagret[k] = process.env[k]; delete process.env[k]; }
    sisteSendMail = null;
    nodemailer.createTransport = () => ({
      sendMail: async (opts) => { sisteSendMail = opts; return { messageId: '<varsel@havstund>' }; },
    });
  });
  afterEach(() => {
    nodemailer.createTransport = ekteCreateTransport;
    for (const k of NOKLER) {
      if (lagret[k] === undefined) delete process.env[k];
      else process.env[k] = lagret[k];
    }
  });

  it('setter to + from + replyTo + subject med branded HTML', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    process.env.POST_REPLY_TO = 'svar@havstund.no';
    const res = await email.sendNyMelding('kunde@havstund.no', { navn: 'Ola', harTilbud: true, pris: 1200 });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('<varsel@havstund>');
    expect(sisteSendMail).not.toBeNull();
    expect(sisteSendMail.to).toBe('kunde@havstund.no');
    expect(sisteSendMail.from).toBe('post@havstund.no');
    expect(sisteSendMail.replyTo).toBe('svar@havstund.no');
    expect(sisteSendMail.html).toContain('alt="Havstund"');
    delete process.env.POST_REPLY_TO;
  });

  it('fire-and-forget: ikke konfigurert -> ingen kast, ingen sendMail', async () => {
    expect(email.isConfigured()).toBe(false);
    const res = await email.sendNyMelding('kunde@havstund.no', { navn: 'Ola' });
    expect(res).toMatchObject({ ok: false, simulert: true });
    expect(sisteSendMail).toBeNull();
  });

  it('tom mottakeradresse -> { ok:false }, ingen kast', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    const res = await email.sendNyMelding('', { navn: 'Ola' });
    expect(res.ok).toBe(false);
    expect(sisteSendMail).toBeNull();
  });
});
