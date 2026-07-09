// describe/it/expect er globale (vitest.config.js -> globals: true)
// S1A - "booking mottatt"-kvittering: branded layout (inline CSS + absolutt
// logo-URL), .ics-vedlegg, og fire-and-forget-kontrakt (kaster aldri).
const email = require('../../lib/email');

const NOKLER = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'POST_FROM', 'POST_BASE_URL'];

describe('lib/email - byggMottattMelding + layout', () => {
  // Sikre deterministisk logo-URL (ingen POST_BASE_URL lekker inn fra miljoet).
  const lagretBase = {};
  beforeEach(() => { lagretBase.v = process.env.POST_BASE_URL; delete process.env.POST_BASE_URL; });
  afterEach(() => {
    if (lagretBase.v === undefined) delete process.env.POST_BASE_URL;
    else process.env.POST_BASE_URL = lagretBase.v;
  });

  it('bygger emne + ren tekst med navn, aktivitet og dato', () => {
    const m = email.byggMottattMelding('Kari', { id: 7, dato: '2026-07-01', tid: '12:00', antall: 2 }, 'Havpadling');
    expect(m.emne.toLowerCase()).toContain('mottatt');
    expect(m.tekst).toContain('Hei Kari');
    expect(m.tekst).toContain('Havpadling');
    expect(m.tekst).toContain('2026-07-01');
    expect(m.tekst).toContain('7'); // booking-nr
  });

  it('HTML bruker branded layout med absolutt logo-URL og alt-tekst (Gmail-trygt)', () => {
    const m = email.byggMottattMelding('Kari', { id: 7, dato: '2026-07-01' }, 'Havpadling');
    expect(m.html).toContain('https://havstund.no/bilder/wordmark.png');
    expect(m.html).toContain('alt="Havstund"');
    // Inline CSS: ingen <style>-blokk (Gmail stripper den).
    expect(m.html).not.toContain('<style');
    expect(m.html).toContain('style=');
  });

  it('layout(html) respekterer POST_BASE_URL for absolutt logo-URL', () => {
    process.env.POST_BASE_URL = 'https://staging.havstund.no/';
    const html = email.layout('<p>hei</p>');
    expect(html).toContain('https://staging.havstund.no/bilder/wordmark.png');
    expect(html).toContain('<p>hei</p>');
  });
});

describe('lib/email - byggIcs', () => {
  it('bygger et gyldig VEVENT fra dato + tid (CRLF, flytende tid, 1t varighet)', () => {
    const ics = email.byggIcs({ id: 42, dato: '2026-07-01', tid: '12:00' }, 'Havpadling');
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('DTSTART:20260701T120000');
    expect(ics).toContain('DTEND:20260701T130000');
    expect(ics).toContain('SUMMARY:Havstund');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics).toContain('\r\n'); // RFC 5545 linjeskift
  });

  it('DTEND-datoen ruller til neste dag naar starttiden er 23:xx (velformet)', () => {
    // 23:30 -> slutt-timen wrapper forbi midnatt; DTEND-datoen maa vaere dagen etter
    // DTSTART, ellers havner DTEND foer DTSTART (bryter RFC 5545).
    const ics = email.byggIcs({ id: 7, dato: '2026-07-01', tid: '23:30' }, 'Havpadling');
    expect(ics).toContain('DTSTART:20260701T233000');
    expect(ics).toContain('DTEND:20260702T003000');
  });

  it('uten tid blir det en heldags-hendelse', () => {
    const ics = email.byggIcs({ id: 1, dato: '2026-07-01' }, 'Havpadling');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260701');
    expect(ics).not.toContain('DTEND');
  });

  it('returnerer null uten gyldig dato (da sendes e-posten uten vedlegg)', () => {
    expect(email.byggIcs({ id: 1 }, 'Havpadling')).toBeNull();
    expect(email.byggIcs({ dato: 'ugyldig' }, 'Havpadling')).toBeNull();
  });
});

describe('lib/email - sendBookingMottatt (mock transport)', () => {
  // Samme CJS-monster som regresjonstesten: muter nodemailer-singletonen direkte.
  const nodemailer = require('nodemailer');
  const ekteCreateTransport = nodemailer.createTransport;
  const lagret = {};
  let sisteSendMail;

  beforeEach(() => {
    for (const k of NOKLER) { lagret[k] = process.env[k]; delete process.env[k]; }
    sisteSendMail = null;
    nodemailer.createTransport = () => ({
      sendMail: async (opts) => { sisteSendMail = opts; return { messageId: '<mottatt@havstund>' }; },
    });
  });
  afterEach(() => {
    nodemailer.createTransport = ekteCreateTransport;
    for (const k of NOKLER) {
      if (lagret[k] === undefined) delete process.env[k];
      else process.env[k] = lagret[k];
    }
  });

  it('setter to + from + subject og legger ved .ics-kalenderfil', async () => {
    process.env.SMTP_HOST = 'smtp.test';
    process.env.SMTP_USER = 'u';
    process.env.SMTP_PASS = 'p';
    const res = await email.sendBookingMottatt('kunde@havstund.no', 'Ola', { id: 42, dato: '2026-07-01', tid: '12:00', antall: 1 }, 'Havpadling');
    expect(res.ok).toBe(true);
    expect(res.messageId).toBe('<mottatt@havstund>');
    expect(sisteSendMail).not.toBeNull();
    expect(sisteSendMail.to).toBe('kunde@havstund.no');
    expect(sisteSendMail.from).toBe('post@havstund.no');
    expect(sisteSendMail.text).toContain('Havpadling'); // ren-tekst multipart-fallback
    expect(sisteSendMail.html).toContain('alt="Havstund"'); // branded HTML
    expect(Array.isArray(sisteSendMail.attachments)).toBe(true);
    expect(sisteSendMail.attachments).toHaveLength(1);
    expect(sisteSendMail.attachments[0].filename).toMatch(/\.ics$/);
    expect(sisteSendMail.attachments[0].contentType).toContain('text/calendar');
    expect(sisteSendMail.attachments[0].content).toContain('BEGIN:VCALENDAR');
  });

  it('fire-and-forget: ikke konfigurert -> ingen kast, ingen sendMail', async () => {
    expect(email.isConfigured()).toBe(false);
    const res = await email.sendBookingMottatt('kunde@havstund.no', 'Ola', { id: 1, dato: '2026-07-01' }, 'Havpadling');
    expect(res).toMatchObject({ ok: false, simulert: true });
    expect(sisteSendMail).toBeNull(); // transporten ble aldri kalt
  });
});
