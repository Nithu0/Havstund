// describe/it/expect er globale (vitest.config.js -> globals: true)
// F28 (statusTekst-mapping) + F29 (Reply-To-hygiene).
const email = require('../../lib/email');

describe('lib/email - statusTekst (F28)', () => {
  it('mapper forespurt til vennlig ventetekst (ikke fallback String)', () => {
    // Systemets faktiske start-status er 'forespurt' (GYLDIG_STATUS i
    // routes/bookings.js). Denne falt tidligere gjennom til String(status).
    expect(email.statusTekst('forespurt')).toBe('mottatt og venter på behandling');
  });

  it('mapper bekreftet / avlyst / fullfort', () => {
    expect(email.statusTekst('bekreftet')).toBe('bekreftet');
    expect(email.statusTekst('avlyst')).toBe('avlyst');
    expect(email.statusTekst('fullfort')).toBe('fullført');
  });

  it('har en nøytral tekst for ingen_oppmoete', () => {
    expect(email.statusTekst('ingen_oppmoete')).toBe('registrert som ikke oppmøtt');
  });

  it('venter er fjernet (død kode) og faller nå til fallback', () => {
    // 'venter' fantes aldri i GYLDIG_STATUS; nøkkelen er borte, så en ukjent
    // status returnerer seg selv via fallback.
    expect(email.statusTekst('venter')).toBe('venter');
  });

  it('ukjent/tom status faller trygt til fallback uten kast', () => {
    expect(email.statusTekst('noe_helt_annet')).toBe('noe_helt_annet');
    expect(email.statusTekst(undefined)).toBe('');
    expect(email.statusTekst(null)).toBe('');
  });

  it('en forespurt-booking gir et pent emne, ikke "booking forespurt"', () => {
    const m = email.byggMelding('Kari', { id: 3, aktivitet: 'Fisketur' }, 'forespurt');
    expect(m.emne).toBe('Havstund — booking mottatt og venter på behandling');
    expect(m.tekst).toContain('mottatt og venter på behandling');
  });
});

// F29: Reply-To settes på utgående e-post slik at kundesvar havner hos eier.
// Samme CJS-monster som de andre e-post-testene: muter nodemailer-singletonen.
describe('lib/email - Reply-To-hygiene (F29)', () => {
  const nodemailer = require('nodemailer');
  const ekteCreateTransport = nodemailer.createTransport;
  const NOKLER = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'POST_FROM', 'POST_REPLY_TO', 'POST_BASE_URL'];
  const lagret = {};
  let sisteSendMail;

  beforeEach(() => {
    for (const k of NOKLER) { lagret[k] = process.env[k]; delete process.env[k]; }
    sisteSendMail = null;
    nodemailer.createTransport = () => ({
      sendMail: async (opts) => { sisteSendMail = opts; return { messageId: '<reply@havstund>' }; },
    });
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
  });
  afterEach(() => {
    nodemailer.createTransport = ekteCreateTransport;
    for (const k of NOKLER) {
      if (lagret[k] === undefined) delete process.env[k];
      else process.env[k] = lagret[k];
    }
  });

  it('sendStatusEpost setter replyTo (default = POST_FROM-fallback)', async () => {
    const res = await email.sendStatusEpost('kunde@havstund.no', 'Ola', { id: 1 }, 'bekreftet');
    expect(res.ok).toBe(true);
    expect(sisteSendMail).not.toBeNull();
    expect(sisteSendMail.replyTo).toBe('post@havstund.no');
  });

  it('sendBookingMottatt setter replyTo (default = POST_FROM-fallback)', async () => {
    const res = await email.sendBookingMottatt('kunde@havstund.no', 'Ola', { id: 1, dato: '2026-07-01' }, 'Havpadling');
    expect(res.ok).toBe(true);
    expect(sisteSendMail).not.toBeNull();
    expect(sisteSendMail.replyTo).toBe('post@havstund.no');
  });

  it('POST_REPLY_TO overstyrer replyTo når satt', async () => {
    process.env.POST_REPLY_TO = 'eier@havstund.no';
    await email.sendStatusEpost('kunde@havstund.no', 'Ola', { id: 1 }, 'avlyst');
    expect(sisteSendMail.replyTo).toBe('eier@havstund.no');
  });

  it('replyTo følger POST_FROM når POST_REPLY_TO ikke er satt', async () => {
    process.env.POST_FROM = 'booking@havstund.no';
    await email.sendStatusEpost('kunde@havstund.no', 'Ola', { id: 1 }, 'bekreftet');
    expect(sisteSendMail.from).toBe('booking@havstund.no');
    expect(sisteSendMail.replyTo).toBe('booking@havstund.no');
  });
});
