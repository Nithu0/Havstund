/* Havstund — service-token → 'agent'-principal (brain-integrasjon, HULL 1).
 *
 * AI-brainen (havstund-brain) snakker med nettsiden over REST og sender
 *   Authorization: Bearer <WEBSITE_SERVICE_TOKEN>
 * Denne modulen autentiserer DET tokenet til en syntetisk 'agent'-principal og
 * slipper den gjennom guards på NØYAKTIG de rutene brain-adapteren kaller — ikke
 * blankt på alt.
 *
 * SIKKERHET:
 *  - Fail-closed: er WEBSITE_SERVICE_TOKEN tom/uset, gir token-stien ALDRI
 *    tilgang (ingen bypass på tom streng, ingen sammenligning utføres).
 *  - Timing-safe sammenligning (crypto.timingSafeEqual) mot tidsangreps-lekkasje.
 *  - Allowlist: agent-rollen slipper kun gjennom på (metode, sti) som adapteren
 *    faktisk bruker. Alle andre ruter er uberørt — agent får 401/403 der.
 *
 * AGENT-IDENTITET / AUDIT (begrunnelse):
 *  - audit_log.actor_id er INTEGER UTEN FK (db/schema.sql), og writeAudit
 *    tolererer allerede actor.id == null (lib/audit.js). Ingen rute som
 *    adapteren bruker persisterer req.user.id i en FK-bundet kolonne når den
 *    handler som ansatt/admin (bookings GET treffer ansatt-grenen, meldinger og
 *    regnskap bruker query-param / egne id-er). Derfor trengs INGEN seeded
 *    'agent'-bruker: en syntetisk principal med id=null er den reneste løsningen
 *    og holder skjema + seed uendret.
 */
const { timingSafeEqual } = require('crypto');

const AGENT_USER = Object.freeze({ id: null, rolle: 'agent', navn: 'AI-agent' });

// Allowlist: ruter brain-adapteren (havstund-brain/src/adapters/http-website-adapter.ts)
// faktisk kaller. Stiene er montert under /api/<fil> i server.js. Metode + regex
// matches mot req.method + req.originalUrl (uten query-streng).
// VIKTIG: ved endring av adapteren — hold denne lista i synk.
const AGENT_ALLOWLIST = [
  // bookings: list (GET), opprett (POST), sett status (PATCH /:id)
  { method: 'GET', re: /^\/api\/bookings\/?$/ },
  { method: 'POST', re: /^\/api\/bookings\/?$/ },
  { method: 'PATCH', re: /^\/api\/bookings\/\d+\/?$/ },
  // availability: list (GET), erstatt slots (PUT)
  { method: 'GET', re: /^\/api\/availability\/?$/ },
  { method: 'PUT', re: /^\/api\/availability\/?$/ },
  // hours: list (GET), sett ukedag (PUT /:ukedag)
  { method: 'GET', re: /^\/api\/hours\/?$/ },
  { method: 'PUT', re: /^\/api\/hours\/\d+\/?$/ },
  // activities: list (GET), admin/all (GET), én (GET /:id), opprett (POST),
  //             oppdater (PUT /:id), soft-delete (DELETE /:id)
  { method: 'GET', re: /^\/api\/activities\/?$/ },
  { method: 'GET', re: /^\/api\/activities\/admin\/all\/?$/ },
  { method: 'GET', re: /^\/api\/activities\/\d+\/?$/ },
  { method: 'POST', re: /^\/api\/activities\/?$/ },
  { method: 'PUT', re: /^\/api\/activities\/\d+\/?$/ },
  { method: 'DELETE', re: /^\/api\/activities\/\d+\/?$/ },
  // meldinger: kundetråd (GET ?bruker_id=), svar kunde (POST ?bruker_id=)
  { method: 'GET', re: /^\/api\/meldinger\/?$/ },
  { method: 'POST', re: /^\/api\/meldinger\/?$/ },
  // admin/content: list (GET), upsert (PUT /:nokkel)
  { method: 'GET', re: /^\/api\/admin\/content\/?$/ },
  { method: 'PUT', re: /^\/api\/admin\/content\/[^/]+\/?$/ },
  // regnskap/timer: list (GET), logg timer (POST)
  { method: 'GET', re: /^\/api\/regnskap\/timer\/?$/ },
  { method: 'POST', re: /^\/api\/regnskap\/timer\/?$/ },
  // regnskap/poster: opprett regnskapspost (POST) — bekreftet skriving fra
  // agenten (Fase 6). Nettsiden gjør mvaSplitt fra bekreftet brutto.
  { method: 'POST', re: /^\/api\/regnskap\/poster\/?$/ },
  // health: åpen uansett, men adapteren treffer den med token.
  { method: 'GET', re: /^\/api\/health\/?$/ },
];

// Sti uten query-streng.
function pathOf(req) {
  const url = req.originalUrl || req.url || '';
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

// Er (metode, sti) på agent-allowlista?
function agentRuteTillatt(req) {
  const sti = pathOf(req);
  const metode = (req.method || '').toUpperCase();
  return AGENT_ALLOWLIST.some((r) => r.method === metode && r.re.test(sti));
}

// Timing-safe streng-likhet. Fail-closed på tom/uset forventet verdi.
function tokenLikt(forventet, kandidat) {
  if (!forventet || !kandidat) return false; // ingen bypass på tom streng
  const a = Buffer.from(String(forventet), 'utf8');
  const b = Buffer.from(String(kandidat), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Middleware: kjøres FØR authOptional. Setter agent-principal når et gyldig
// service-token er sendt. Blokkerer aldri selv — bare setter req.user/req.isAgent.
// authOptional hopper over JWT-parsing når req.user allerede er satt.
function agentAuth(req, _res, next) {
  const forventet = process.env.WEBSITE_SERVICE_TOKEN;
  if (!forventet) return next(); // fail-closed: ingen token-sti uten env
  const header = req.headers && req.headers.authorization;
  if (!header) return next();
  // Lineær parsing (ingen regex) — unngår ReDoS på bruker-styrt header.
  const trimmet = String(header).trim();
  if (!/^bearer /i.test(trimmet.slice(0, 7))) return next(); // konstant-lengde, ingen backtracking
  const kandidat = trimmet.slice(7).trim();
  if (!kandidat) return next();
  if (tokenLikt(forventet, kandidat)) {
    req.user = { ...AGENT_USER };
    req.isAgent = true;
  }
  return next();
}

// Er denne requesten en agent som er tillatt på DENNE ruten?
function agentTillattHer(req) {
  return req.isAgent === true && agentRuteTillatt(req);
}

// Global gate: håndhever allowlista for ALLE ruter (også de som sjekker rolle
// inne i handleren, ikke via requireRole). En agent som treffer en ikke-
// allowlistet sti får 403 FØR handleren kjører. Ikke-agent-requests berøres ikke.
function agentGate(req, res, next) {
  if (req.isAgent === true && !agentRuteTillatt(req)) {
    return res.status(403).json({ error: 'Ingen tilgang' });
  }
  return next();
}

module.exports = { agentAuth, agentGate, agentTillattHer, agentRuteTillatt, AGENT_ALLOWLIST };
