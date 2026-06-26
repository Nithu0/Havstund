/* Havstund — Sentry (feilrapportering).
   Tynn wrapper rundt @sentry/node. MILJØ-STYRT: gjør INGENTING uten SENTRY_DSN.

   Konfigureres via miljøvariabler på Railway (ingen hemmeligheter i koden):
     SENTRY_DSN          -> prosjektets DSN fra Sentry. Mangler den => full no-op.
     SENTRY_ENVIRONMENT  -> valgfritt miljønavn (default process.env.NODE_ENV || 'development').
     SENTRY_TRACES_SAMPLE_RATE -> valgfri tracing-andel (0..1), default 0 (av).

   Som de andre eksterne integrasjonene (discord.js / fiken.js): kaster ALDRI.
   Sentry-trøbbel skal aldri stoppe en request eller oppstart. */

const Sentry = require('@sentry/node');

// True bare hvis DSN er satt (ikke-tom string).
function isConfigured() {
  return !!(process.env.SENTRY_DSN && String(process.env.SENTRY_DSN).trim());
}

// Settes til true første gang init() faktisk slår på Sentry,
// slik at captureException kun sender når vi er initialisert.
let aktiv = false;

// Initialiser Sentry. No-op (returnerer false) hvis SENTRY_DSN mangler.
// app-argumentet tas imot for fremtidig Express-integrasjon, men er valgfritt;
// modulen fungerer uten det. Kaster ALDRI.
function init(_app) {
  if (!isConfigured()) return false;
  try {
    let traces = Number(process.env.SENTRY_TRACES_SAMPLE_RATE);
    if (!Number.isFinite(traces) || traces < 0) traces = 0;
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      tracesSampleRate: traces,
    });
    aktiv = true;
    return true;
  } catch (e) {
    console.error('Sentry-init feilet:', e && e.message ? e.message : e);
    return false;
  }
}

// Rapporter en feil til Sentry. No-op hvis ikke initialisert. Kaster ALDRI.
function captureException(err, context) {
  if (!aktiv) return;
  try {
    if (context) Sentry.captureException(err, context);
    else Sentry.captureException(err);
  } catch (e) {
    console.error('Sentry-rapportering feilet:', e && e.message ? e.message : e);
  }
}

module.exports = { isConfigured, init, captureException };
