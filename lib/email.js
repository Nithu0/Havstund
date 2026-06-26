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
     POST_FROM   -> avsenderadresse, default "post@havstund.no" */

const nodemailer = require('nodemailer');

// True bare hvis vert OG bruker OG passord er satt.
function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function fraAdresse() {
  return process.env.POST_FROM || 'post@havstund.no';
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
    venter: 'mottatt og venter på behandling',
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

module.exports = { isConfigured, sendStatusEpost, byggMelding };
