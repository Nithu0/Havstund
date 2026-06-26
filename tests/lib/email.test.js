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

// Regresjon: nodemailer 6 -> 9 (sikkerhetsoppgradering, breaking major).
// API-en (createTransport(host/port/secure/auth) + transport.sendMail(from/to/
// subject/text/html)) er uendret mellom 6 og 9 — denne testen vokter det ved
// aa mocke transporten og bekrefte at sendStatusEpost faktisk setter `to` =
// mottakerens e-post, og at fire-and-forget (ingen kast) er bevart.
describe('lib/email — nodemailer 9 transport (regresjon)', () => {
  // Vi muterer nodemailer-singletonen direkte (samme CJS-monster som bookings-
  // testen bruker for db). vi.mock fanger ikke require() paalitelig her.
  const nodemailer = require('nodemailer');
  const ekteCreateTransport = nodemailer.createTransport;

  const lagret = {};
  const NOKLER = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'POST_FROM'];
  let sisteSendMail;

  beforeEach(() => {
    for (const k of NOKLER) { lagret[k] = process.env[k]; delete process.env[k]; }
    sisteSendMail = null;
    // Mock-transport: fanger sendMail-argumentet, kaster aldri.
    nodemailer.createTransport = () => ({
      sendMail: async (opts) => {
        sisteSendMail = opts;
        return { messageId: '<test@havstund>' };
      },
    });
  });
  afterEach(() => {
    nodemailer.createTransport = ekteCreateTransport;
    for (const k of NOKLER) {
      if (lagret[k] === undefined) delete process.env[k];
      else process.env[k] = lagret[k];
    }
  });

  it('setter to = mottakerens e-post og sender via nodemailer 9-transporten', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    const res = await email.sendStatusEpost('kunde@havstund.no', 'Ola', { id: 42, aktivitet: 'Fisketur' }, 'bekreftet');
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('<test@havstund>');
    expect(sisteSendMail).not.toBeNull();
    expect(sisteSendMail.to).toBe('kunde@havstund.no');
    expect(sisteSendMail.from).toBe('post@havstund.no');
    expect(sisteSendMail.subject).toContain('bekreftet');
  });

  it('fire-and-forget bevart: isConfigured()=false -> ingen kast, ingen sendMail', async () => {
    // Ingen SMTP-env satt -> ikke konfigurert.
    expect(email.isConfigured()).toBe(false);
    const res = await email.sendStatusEpost('kunde@havstund.no', 'Ola', { id: 1 }, 'avlyst');
    expect(res).toMatchObject({ ok: false, simulert: true });
    expect(sisteSendMail).toBeNull(); // transporten ble aldri kalt
  });
});
