// describe/it/expect er globale (vitest.config.js -> globals: true)
// Magisk innloggingslenke: branded layout, klikkbar knapp + ren URL, escaping
// av lenken inn i href, og fire-and-forget-kontrakt (kaster aldri).
const email = require('../../lib/email');

const NOKLER = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'POST_FROM', 'POST_BASE_URL'];

describe('lib/email - byggInnloggingslenkeMelding', () => {
  const lagretBase = {};
  beforeEach(() => { lagretBase.v = process.env.POST_BASE_URL; delete process.env.POST_BASE_URL; });
  afterEach(() => {
    if (lagretBase.v === undefined) delete process.env.POST_BASE_URL;
    else process.env.POST_BASE_URL = lagretBase.v;
  });

  it('bygger emne + ren tekst med hilsen og selve lenken', () => {
    const m = email.byggInnloggingslenkeMelding({ navn: 'Kari', lenke: 'https://havstund.no/api/auth/magic/abc123' });
    expect(m.emne.toLowerCase()).toContain('logg inn');
    expect(m.tekst).toContain('Hei Kari');
    expect(m.tekst).toContain('https://havstund.no/api/auth/magic/abc123');
  });

  it('HTML: branded layout, klikkbar knapp + synlig URL', () => {
    const m = email.byggInnloggingslenkeMelding({ navn: 'Kari', lenke: 'https://havstund.no/api/auth/magic/abc123' });
    expect(m.html).toContain('alt="Havstund"');       // branded layout
    expect(m.html).not.toContain('<style');           // inline CSS (Gmail-trygt)
    expect(m.html).toContain('href="https://havstund.no/api/auth/magic/abc123"');
    expect(m.html).toContain('Logg inn');             // knapp-tekst
  });

  it('escaper lenken inn i href (ingen attributt-injeksjon)', () => {
    const m = email.byggInnloggingslenkeMelding({ navn: 'X', lenke: 'https://x.no/a?b=1&c="><script>' });
    // & -> &amp;, " -> &quot? escapeHtml haandterer & < > (ikke "), saa vi sjekker
    // at raa </script> / < ikke overlever inn i HTML-et.
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&amp;');
    expect(m.html).toContain('&lt;');
  });

  it('uten navn: noeytral hilsen', () => {
    const m = email.byggInnloggingslenkeMelding({ lenke: '/api/auth/magic/x' });
    expect(m.tekst).toContain('Hei,');
  });
});

describe('lib/email - sendInnloggingslenke (mock transport)', () => {
  const nodemailer = require('nodemailer');
  const ekteCreateTransport = nodemailer.createTransport;
  const lagret = {};
  let sisteSendMail;

  beforeEach(() => {
    for (const k of NOKLER) { lagret[k] = process.env[k]; delete process.env[k]; }
    sisteSendMail = null;
    nodemailer.createTransport = () => ({
      sendMail: async (opts) => { sisteSendMail = opts; return { messageId: '<magic@havstund>' }; },
    });
  });
  afterEach(() => {
    nodemailer.createTransport = ekteCreateTransport;
    for (const k of NOKLER) {
      if (lagret[k] === undefined) delete process.env[k];
      else process.env[k] = lagret[k];
    }
  });

  it('konfigurert: setter to/from/subject + reply-to og sender', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    const res = await email.sendInnloggingslenke('kunde@havstund.no', { navn: 'Ola', lenke: 'https://havstund.no/api/auth/magic/tok' });
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('<magic@havstund>');
    expect(sisteSendMail.to).toBe('kunde@havstund.no');
    expect(sisteSendMail.from).toBe('post@havstund.no');
    expect(sisteSendMail.replyTo).toBe('post@havstund.no');
    expect(sisteSendMail.text).toContain('https://havstund.no/api/auth/magic/tok');
    expect(sisteSendMail.html).toContain('href="https://havstund.no/api/auth/magic/tok"');
  });

  it('fire-and-forget: ikke konfigurert -> { ok:false, simulert:true }, ingen sendMail', async () => {
    expect(email.isConfigured()).toBe(false);
    const res = await email.sendInnloggingslenke('kunde@havstund.no', { navn: 'Ola', lenke: '/api/auth/magic/x' });
    expect(res).toMatchObject({ ok: false, simulert: true });
    expect(sisteSendMail).toBeNull();
  });

  it('fire-and-forget: manglende mottaker -> { ok:false }, kaster ikke', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    const res = await email.sendInnloggingslenke('', { lenke: '/x' });
    expect(res.ok).toBe(false);
    expect(sisteSendMail).toBeNull();
  });
});
