/* Havstund — strukturert logging via pino.
   Eksporterer:
     - logger: pino-instans (level fra LOG_LEVEL, default 'info').
       Pretty-output i dev (NODE_ENV !== 'production') HVIS pino-pretty er
       installert; ellers faller den stille tilbake til JSON. Logging skal
       aldri stoppe oppstart.
     - lagRequestLogger(opts): factory som returnerer en pino-http-kompatibel
       request-logger (middleware). Server-steget wirer denne inn.

   MERK: denne fila oppretter KUN logger-modulen. Selve innwiringen i
   serveren gjøres et annet sted. */

const pino = require('pino');

const erProd = process.env.NODE_ENV === 'production';
const nivaa = process.env.LOG_LEVEL || 'info';

// Pretty-transport er kun ønskelig i dev og kun hvis pino-pretty finnes.
// Vi sjekker tilstedeværelse uten å kreve at den er installert, slik at
// fravær aldri kaster ved oppstart.
function harPinoPretty() {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

function byggOpts() {
  const opts = { level: nivaa };
  if (!erProd && harPinoPretty()) {
    opts.transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    };
  }
  return opts;
}

const logger = pino(byggOpts());

/* pino-http-kompatibel request-logger.
   Lazy-require av pino-http slik at modulen kan brukes (for app-logging)
   selv om pino-http av en eller annen grunn ikke er tilgjengelig — da
   returneres en no-op middleware i stedet for å kaste. */
function lagRequestLogger(opts = {}) {
  let pinoHttp;
  try {
    pinoHttp = require('pino-http');
  } catch {
    // Fallback: middleware som bare henger logger på req og går videre.
    return function requestLoggerFallback(req, _res, next) {
      req.log = logger;
      if (typeof next === 'function') next();
    };
  }
  return pinoHttp({ logger, ...opts });
}

module.exports = { logger, lagRequestLogger };
