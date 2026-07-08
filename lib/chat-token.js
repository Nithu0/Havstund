/* Havstund — signert eierskaps-token for anonym chat.
   Cookie-verdi: "<thread_id>.<HMAC_SHA256(thread_id, secret)>".
   Hindrer forfalskning av havstund_chat-cookien (IDOR): bare den som
   opprettet tråden får en gyldig signatur. All verifisering er timing-safe.

   Merk: cookie-parser i server.js kjøres UTEN secret, så dette er en helt
   uavhengig HMAC-ordning (ikke Express' "signed cookies"). */
const crypto = require('crypto');

// Fail-closed hemmelighet. Gjenbruker CHAT_TOKEN_SECRET hvis satt, ellers
// JWT_SECRET (samme krav som lib/auth.js: minst 32 tegn). I produksjon KASTES
// det ved oppstart uten gyldig hemmelighet — ingen usikker default. I
// dev/test genereres en tilfeldig per-prosess hemmelighet (tokens
// invalideres ved omstart), akkurat som JWT-hemmeligheten.
function resolveSecret() {
  const env = process.env.CHAT_TOKEN_SECRET || process.env.JWT_SECRET;
  if (env && env.length >= 32) return env;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CHAT_TOKEN_SECRET (eller JWT_SECRET) må være satt og minst 32 tegn i produksjon');
  }
  const dev = crypto.randomBytes(32).toString('hex');
  console.warn('⚠ CHAT_TOKEN_SECRET/JWT_SECRET mangler/for kort — bruker tilfeldig dev-hemmelighet for chat-token');
  return dev;
}
const SECRET = resolveSecret();

function hmac(idStr) {
  return crypto.createHmac('sha256', SECRET).update(idStr).digest('hex');
}

// Lag signert cookie-verdi for en tråd-id.
function signChatToken(id) {
  const idStr = String(id);
  return idStr + '.' + hmac(idStr);
}

// Timing-safe verifisering av at token er en gyldig signatur for gitt id.
function verifyChatToken(token, id) {
  if (typeof token !== 'string' || !token) return false;
  const punkt = token.lastIndexOf('.');
  if (punkt <= 0) return false;
  const idDel = token.slice(0, punkt);
  const sig = token.slice(punkt + 1);
  if (idDel !== String(id)) return false;
  const forventet = hmac(idDel);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(forventet, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Trekk ut en verifisert tråd-id fra en signert cookie (eller null hvis
// mangler/forfalsket). Brukes av POST /thread for trygg tråd-gjenbruk.
function chatTokenId(token) {
  if (typeof token !== 'string') return null;
  const punkt = token.lastIndexOf('.');
  if (punkt <= 0) return null;
  const id = Number(token.slice(0, punkt));
  if (!Number.isInteger(id) || id <= 0) return null;
  return verifyChatToken(token, id) ? id : null;
}

module.exports = { signChatToken, verifyChatToken, chatTokenId };
