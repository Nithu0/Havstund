/* Havstund — sikkerhets-middleware (helmet + rate limiting).
   Mountes fra server.js via applySecurity(app).

   Rollback: alt kan slås av med RATE_LIMIT_ENABLED=false (helmet beholdes).
   Grenser kan justeres med env-variabler uten kodeendring. */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

function tall(envVerdi, fallback) {
  const n = Number.parseInt(envVerdi, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function applySecurity(app) {
  // Railway kjører bak en proxy — nødvendig for at rate-limit skal se ekte klient-IP.
  app.set('trust proxy', 1);

  // Sikkerhets-headere. CSP er bevisst AV: den offentlige siden laster inline-script
  // + CDN-libs (Swiper, GLightbox, Lenis, notie, Chart.js, SheetJS). En streng CSP
  // må utformes og testes separat (egen oppgave) før den slås på.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    })
  );

  if (process.env.RATE_LIMIT_ENABLED === 'false') {
    console.log('  ⚠ rate limiting AV (RATE_LIMIT_ENABLED=false)');
    return;
  }

  const felles = { standardHeaders: true, legacyHeaders: false };

  // Streng grense på innlogging/registrering — brute-force-vern.
  const authLimiter = rateLimit({
    ...felles,
    windowMs: tall(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 15 * 60 * 1000),
    max: tall(process.env.RATE_LIMIT_AUTH_MAX, 10),
    message: { error: 'For mange forsøk. Vent noen minutter og prøv igjen.' },
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);

  // Moderat grense på offentlig booking-innsending (spam-vern).
  const bookingLimiter = rateLimit({
    ...felles,
    windowMs: tall(process.env.RATE_LIMIT_BOOKING_WINDOW_MS, 60 * 60 * 1000),
    max: tall(process.env.RATE_LIMIT_BOOKING_MAX, 30),
    message: { error: 'For mange bookingforsøk. Prøv igjen senere.' },
  });
  // Kun POST (oppretting). GET-lista for ansatte rammes ikke.
  app.use('/api/bookings', (req, res, next) =>
    req.method === 'POST' ? bookingLimiter(req, res, next) : next()
  );
}

module.exports = { applySecurity };
