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

  // Streng grense på passordbytte — brute-force mot GAMMELT passord.
  // authLimiter dekker kun /login + /register, IKKE change-password, så denne
  // stien var uten eget vern. Egen limiter (ikke gjenbruk av authLimiter) gir
  // uavhengig env-knapp og deler ikke kvote med anonyme login-forsøk.
  // Default 5/15min: en ekte bruker bytter passord sjelden mer enn et par
  // ganger; strengere enn login (10) fordi legitim frekvens er svært lav.
  const passwordChangeLimiter = rateLimit({
    ...felles,
    windowMs: tall(process.env.RATE_LIMIT_PWCHANGE_WINDOW_MS, 15 * 60 * 1000),
    max: tall(process.env.RATE_LIMIT_PWCHANGE_MAX, 5),
    message: { error: 'For mange passordbytte-forsøk. Vent noen minutter og prøv igjen.' },
  });
  app.use('/api/auth/change-password', passwordChangeLimiter);

  // Moderat grense på kundevendte skjemaer (chat + meldinger). Disse var helt
  // uten rate-limit. Bevisst romsligere enn auth/booking fordi for stramt =
  // ekte kunder blokkeres midt i en samtale. Default 40/5min ≈ 8/min: en ivrig
  // kunde som skriver korte meldinger holder seg godt under, mens et skript som
  // spammer endepunktet stoppes. Én felles limiter for begge (samme «kundevendt
  // skjema»-gruppe), delt IP-bøtte.
  const kundeLimiter = rateLimit({
    ...felles,
    windowMs: tall(process.env.RATE_LIMIT_KUNDE_WINDOW_MS, 5 * 60 * 1000),
    max: tall(process.env.RATE_LIMIT_KUNDE_MAX, 40),
    message: { error: 'For mange forsøk på kort tid. Vent litt og prøv igjen.' },
  });
  // Kun POST (innsending). Ansatt-GET (chat/threads, meldinger-lister) rammes ikke.
  const kunPost = (limiter) => (req, res, next) =>
    req.method === 'POST' ? limiter(req, res, next) : next();
  app.use('/api/chat', kunPost(kundeLimiter));
  app.use('/api/meldinger', kunPost(kundeLimiter));

  // Moderat grense på offentlig booking-innsending (spam-vern).
  const bookingLimiter = rateLimit({
    ...felles,
    windowMs: tall(process.env.RATE_LIMIT_BOOKING_WINDOW_MS, 60 * 60 * 1000),
    max: tall(process.env.RATE_LIMIT_BOOKING_MAX, 30),
    message: { error: 'For mange bookingforsøk. Prøv igjen senere.' },
  });
  // Kun POST (oppretting). GET-lista for ansatte rammes ikke.
  app.use('/api/bookings', kunPost(bookingLimiter));

  // Global backstop: et romslig tak på ALT under /api, så ruter vi glemmer å
  // dekke spesifikt likevel har et tak. MÅ registreres SIST: Express kjører
  // middleware i registreringsrekkefølge, så de spesifikke limiterne over
  // treffer først. Blir en spesifikk grense truffet, sender den 429 og kaller
  // aldri next() — da nås ikke backstop, og en allerede-blokkert forespørsel
  // brenner ikke backstop-kvoten unødig. Passerte forespørsler teller i begge,
  // som er meningen (backstop er en samlet nød-teller, ikke primærkontroll).
  // Default 600/15min ≈ 40/min: løst nok til aldri å ramme en ekte økt, stramt
  // nok til å kappe et løpsk skript.
  const globalLimiter = rateLimit({
    ...felles,
    windowMs: tall(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS, 15 * 60 * 1000),
    max: tall(process.env.RATE_LIMIT_GLOBAL_MAX, 600),
    message: { error: 'For mange forespørsler. Vent litt og prøv igjen.' },
  });
  app.use('/api', globalLimiter);
}

module.exports = { applySecurity };
