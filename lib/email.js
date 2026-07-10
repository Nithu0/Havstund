/* Havstund — e-post-utsending (SMTP via nodemailer).
   Sender statusoppdateringer på bookinger til kunden.

   MILJØ-STYRT: modulen gjør INGENTING hvis den ikke er konfigurert.
   Da resolver send-funksjonen { ok:false, simulert:true } i stedet for å kaste.
   FIRE-AND-FORGET: kaster ALDRI — e-post-trøbbel skal aldri stoppe en booking.

   Konfigureres via miljøvariabler på Railway (ingen hemmeligheter i koden):
     SMTP_HOST   -> SMTP-server (f.eks "smtp.domeneshop.no")
     SMTP_PORT   -> port (default 587)
     SMTP_USER   -> brukernavn / innlogging
     SMTP_PASS   -> passord
     SMTP_SECURE -> "true" for implisitt TLS (port 465), ellers STARTTLS
     POST_FROM   -> avsenderadresse, default "post@havstund.no"
     POST_REPLY_TO -> Reply-To-adresse for kundesvar, default = POST_FROM

   AVSENDER-HYGIENE / SPAM (infra — koden kan IKKE fikse dette):
   For at utgående e-post ikke skal havne i spam må eieren sette opp DNS for
   domenet i POST_FROM (havstund.no):
     - SPF-record (TXT) som autoriserer SMTP-serveren til å sende for domenet.
     - DKIM-signering (nøkkel hos e-postleverandøren + TXT-record i DNS).
   Dette er en engangs-DNS-jobb hos domene-/e-postleverandøren, ikke noe denne
   modulen kan gjøre. Reply-To settes i koden slik at kundesvar går til eier. */

const nodemailer = require('nodemailer');

// True bare hvis vert OG bruker OG passord er satt.
function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function fraAdresse() {
  return process.env.POST_FROM || 'post@havstund.no';
}

// Reply-To slik at kundesvar havner hos eier, ikke på en no-reply-avsender.
// Egen env-variabel med fallback til samme adresse som POST_FROM-oppsettet.
function svarTilAdresse() {
  return process.env.POST_REPLY_TO || fraAdresse();
}

// Bygger en nodemailer-transport fra miljøvariabler.
function lagTransport() {
  const port = Number(process.env.SMTP_PORT) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

// Norsk visningstekst for en booking-status.
function statusTekst(status) {
  const map = {
    bekreftet: 'bekreftet',
    avlyst: 'avlyst',
    fullfort: 'fullført',
    // Systemets faktiske start-status heter 'forespurt' (se GYLDIG_STATUS i
    // routes/bookings.js), ikke 'venter'. Uten denne nøkkelen falt en
    // forespurt-booking gjennom til fallback String(status).
    forespurt: 'mottatt og venter på behandling',
    // Kunde møtte ikke opp. Brukes foreløpig ikke til e-post — nøytral tekst.
    ingen_oppmoete: 'registrert som ikke oppmøtt',
  };
  return map[status] || String(status || '');
}

// Bygger emne + tekst/HTML for en statusoppdatering.
function byggMelding(navn, bookingInfo, nyStatus) {
  const b = bookingInfo || {};
  const aktivitet = b.aktivitet || b.aktivitetNavn || 'din aktivitet';
  const dato = (b.dato || '') + (b.tid ? ' ' + b.tid : '');
  const statusOrd = statusTekst(nyStatus);
  const hilsen = navn ? ('Hei ' + navn + ',') : 'Hei,';

  const emne = 'Havstund — booking ' + statusOrd;

  const linjer = [
    hilsen,
    '',
    'Statusen på din booking er nå: ' + statusOrd + '.',
    aktivitet ? ('Aktivitet: ' + aktivitet) : '',
    dato ? ('Dato: ' + dato) : '',
    b.id != null ? ('Booking-nr: ' + b.id) : '',
    '',
    'Vennlig hilsen',
    'Havstund',
  ].filter(Boolean);

  const tekst = linjer.join('\n');
  const html = '<p>' + linjer.map((l) => (l === '' ? '<br>' : escapeHtml(l))).join('<br>') + '</p>';

  return { emne, tekst, html };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* Sender en status-e-post til kunden. FIRE-AND-FORGET — kaster ALDRI.
   Returnerer { ok:true, messageId } ved suksess,
   { ok:false, simulert:true } hvis ikke konfigurert,
   { ok:false, error } ved feil. */
async function sendStatusEpost(til, navn, bookingInfo, nyStatus) {
  if (!isConfigured()) return { ok: false, simulert: true, grunn: 'SMTP ikke konfigurert' };
  if (!til) return { ok: false, error: 'mangler mottakeradresse' };

  try {
    const transport = lagTransport();
    const { emne, tekst, html } = byggMelding(navn, bookingInfo, nyStatus);
    const info = await transport.sendMail({
      from: fraAdresse(),
      replyTo: svarTilAdresse(),
      to: til,
      subject: emne,
      text: tekst,
      html,
    });
    return { ok: true, messageId: info && info.messageId };
  } catch (e) {
    console.error('E-post-utsending feilet:', e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Absolutt URL til nettstedet - Gmail krever absolutte bilde-URL-er i e-post.
// POST_BASE_URL kan settes paa Railway; default er produksjonsdomenet.
function baseUrl() {
  return (process.env.POST_BASE_URL || 'https://havstund.no').replace(/\/+$/, '');
}

function logoUrl() {
  return baseUrl() + '/bilder/wordmark.png';
}

// Merkevare-innpakning rundt e-post-innhold. INLINE CSS: Gmail (og de fleste
// klienter) stripper <style>-blokker, saa all styling maa ligge paa elementene.
// Logoen refereres via absolutt URL med alt-tekst.
function layout(innerHtml) {
  const logo = escapeHtml(logoUrl());
  const hjem = escapeHtml(baseUrl());
  return [
    '<!DOCTYPE html>',
    '<html lang="no"><body style="margin:0;padding:0;background:#eef5fc;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef5fc;padding:24px 0;"><tr><td align="center">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">',
    '<tr><td style="background:#2a6f9e;padding:24px;text-align:center;">',
    '<img src="' + logo + '" alt="Havstund" width="180" style="display:block;margin:0 auto;max-width:180px;height:auto;border:0;" />',
    '</td></tr>',
    '<tr><td style="padding:28px 32px;color:#1c2b36;font-size:15px;line-height:1.6;">',
    innerHtml,
    '</td></tr>',
    '<tr><td style="background:#f2f7fc;padding:18px 32px;color:#5b6b78;font-size:12px;line-height:1.5;text-align:center;">',
    'Havstund &middot; Lofoten &middot; <a href="' + hjem + '" style="color:#2a6f9e;text-decoration:none;">havstund.no</a>',
    '</td></tr>',
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');
}

// Bygger emne + ren tekst + branded HTML for "booking mottatt"-kvitteringen.
// Speiler byggMelding-monsteret (samme retur-form { emne, tekst, html }).
function byggMottattMelding(navn, bookingInfo, aktNavn) {
  const b = bookingInfo || {};
  const aktivitet = aktNavn || b.aktivitet || b.aktivitetNavn || 'din aktivitet';
  const dato = (b.dato || '') + (b.tid ? ' ' + b.tid : '');
  const hilsen = navn ? ('Hei ' + navn + ',') : 'Hei,';

  const emne = 'Havstund — vi har mottatt bookingen din';

  const linjer = [
    hilsen,
    '',
    'Takk! Vi har mottatt bookingen din og bekrefter den saa snart vi har sett paa den.',
    aktivitet ? ('Aktivitet: ' + aktivitet) : '',
    dato ? ('Dato: ' + dato) : '',
    b.antall != null ? ('Antall: ' + b.antall) : '',
    b.id != null ? ('Booking-nr: ' + b.id) : '',
    '',
    'Vi har lagt ved en kalenderfil (.ics) saa du enkelt kan sette av tiden.',
    '',
    'Vennlig hilsen',
    'Havstund',
  ].filter(Boolean);

  const tekst = linjer.join('\n');
  const innhold = '<p style="margin:0 0 12px;">'
    + linjer.map((l) => (l === '' ? '<br>' : escapeHtml(l))).join('<br>')
    + '</p>';
  const html = layout(innhold);

  return { emne, tekst, html };
}

// ICS-tekst maa escape backslash, semikolon, komma og linjeskift (RFC 5545).
function icsEscape(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

// Bygger et .ics-kalendervedlegg fra booking-dato/tid. Ren tekst, ingen ny
// dependency. Flytende (lokal) tid - ingen tidssone-avhengighet. Uten tid blir
// det en heldags-hendelse. Linjer skilles med CRLF per RFC 5545.
// Returnerer null hvis dato mangler/er ugyldig (da sendes e-posten uten vedlegg).
function byggIcs(bookingInfo, aktNavn) {
  const b = bookingInfo || {};
  const datoDel = String(b.dato || '').replace(/-/g, '');
  if (!/^\d{8}$/.test(datoDel)) return null;

  const tittel = 'Havstund — ' + (aktNavn || b.aktivitet || 'booking');
  const uid = 'booking-' + (b.id != null ? b.id : datoDel) + '@havstund.no';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  const linjer = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Havstund//Booking//NO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    'UID:' + uid,
    'DTSTAMP:' + stamp,
  ];

  const tidMatch = /^(\d{2}):(\d{2})/.exec(String(b.tid || ''));
  if (tidMatch) {
    const startH = Number(tidMatch[1]);
    const sluttHNum = (startH + 1) % 24;
    const sluttH = String(sluttHNum).padStart(2, '0');
    // Naar slutt-timen wrapper forbi midnatt (23:xx -> 00:xx) maa DTEND-datoen
    // flyttes en dag frem; ellers havner DTEND FOER DTSTART (bryter RFC 5545 og
    // kan faa kalender-klienter til aa avvise hele filen).
    let sluttDato = datoDel;
    if (sluttHNum < startH) {
      const d = new Date(Date.UTC(
        Number(datoDel.slice(0, 4)),
        Number(datoDel.slice(4, 6)) - 1,
        Number(datoDel.slice(6, 8)) + 1,
      ));
      sluttDato = String(d.getUTCFullYear()).padStart(4, '0')
        + String(d.getUTCMonth() + 1).padStart(2, '0')
        + String(d.getUTCDate()).padStart(2, '0');
    }
    linjer.push('DTSTART:' + datoDel + 'T' + tidMatch[1] + tidMatch[2] + '00');
    linjer.push('DTEND:' + sluttDato + 'T' + sluttH + tidMatch[2] + '00');
  } else {
    linjer.push('DTSTART;VALUE=DATE:' + datoDel);
  }

  linjer.push('SUMMARY:' + icsEscape(tittel));
  if (b.id != null) linjer.push('DESCRIPTION:' + icsEscape('Booking-nr: ' + b.id));
  linjer.push('LOCATION:' + icsEscape('Havstund, Lofoten'));
  linjer.push('STATUS:TENTATIVE');
  linjer.push('END:VEVENT');
  linjer.push('END:VCALENDAR');
  return linjer.join('\r\n');
}

/* Sender "booking mottatt"-kvittering til kunden med .ics-vedlegg.
   FIRE-AND-FORGET - kaster ALDRI. Samme retur-kontrakt som sendStatusEpost:
   { ok:true, messageId } | { ok:false, simulert:true } | { ok:false, error }. */
async function sendBookingMottatt(til, navn, bookingInfo, aktNavn) {
  if (!isConfigured()) return { ok: false, simulert: true, grunn: 'SMTP ikke konfigurert' };
  if (!til) return { ok: false, error: 'mangler mottakeradresse' };

  try {
    const transport = lagTransport();
    const { emne, tekst, html } = byggMottattMelding(navn, bookingInfo, aktNavn);
    const brev = {
      from: fraAdresse(),
      replyTo: svarTilAdresse(),
      to: til,
      subject: emne,
      text: tekst,
      html,
    };
    const ics = byggIcs(bookingInfo, aktNavn);
    if (ics) {
      brev.attachments = [{
        filename: 'havstund-booking.ics',
        content: ics,
        contentType: 'text/calendar; method=PUBLISH; charset=UTF-8',
      }];
    }
    const info = await transport.sendMail(brev);
    return { ok: true, messageId: info && info.messageId };
  } catch (e) {
    console.error('E-post-utsending (mottatt) feilet:', e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Bygger emne + ren tekst + branded HTML for "du har fått et svar/tilbud"-varselet.
// Speiler byggMottattMelding-monsteret (samme retur-form { emne, tekst, html }).
// harTilbud/pris nevnes bare hvis ansatt/admin la ved et tilbud.
function byggNyMeldingMelding(opts) {
  const o = opts || {};
  const navn = o.navn;
  const harTilbud = !!o.harTilbud || (o.pris != null && o.pris !== '');
  const hilsen = navn ? ('Hei ' + navn + ',') : 'Hei,';

  const emne = harTilbud
    ? 'Havstund — du har fått et tilbud'
    : 'Havstund — du har fått et svar';

  const linjer = [
    hilsen,
    '',
    harTilbud
      ? 'Du har fått et tilbud fra Havstund. Logg inn på Min side for å se det.'
      : 'Du har fått et svar fra Havstund. Logg inn på Min side for å lese det.',
    (harTilbud && o.pris != null && o.pris !== '') ? ('Foreslått pris: ' + o.pris + ' kr') : '',
    '',
    'Vennlig hilsen',
    'Havstund',
  ].filter(Boolean);

  const tekst = linjer.join('\n');
  const innhold = '<p style="margin:0 0 12px;">'
    + linjer.map((l) => (l === '' ? '<br>' : escapeHtml(l))).join('<br>')
    + '</p>';
  const html = layout(innhold);

  return { emne, tekst, html };
}

/* Varsler kunden om at en ansatt/admin har svart i meldingstråden (evt. med tilbud).
   Innholdslost varsel — selve svaret leses på Min side (ingen meldingstekst i e-post).
   FIRE-AND-FORGET — kaster ALDRI. Samme retur-kontrakt som sendStatusEpost:
   { ok:true, messageId } | { ok:false, simulert:true } | { ok:false, error }. */
async function sendNyMelding(til, opts) {
  if (!isConfigured()) return { ok: false, simulert: true, grunn: 'SMTP ikke konfigurert' };
  if (!til) return { ok: false, error: 'mangler mottakeradresse' };

  try {
    const transport = lagTransport();
    const { emne, tekst, html } = byggNyMeldingMelding(opts);
    const info = await transport.sendMail({
      from: fraAdresse(),
      replyTo: svarTilAdresse(),
      to: til,
      subject: emne,
      text: tekst,
      html,
    });
    return { ok: true, messageId: info && info.messageId };
  } catch (e) {
    console.error('E-post-utsending (ny melding) feilet:', e && e.message ? e.message : String(e));
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = { isConfigured, statusTekst, sendStatusEpost, byggMelding, byggMottattMelding, layout, byggIcs, sendBookingMottatt, byggNyMeldingMelding, sendNyMelding };
