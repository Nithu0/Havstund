/* Havstund — autentisering (bcrypt + JWT i httpOnly-cookie).
   Roller: 'kunde' | 'ansatt' | 'admin'. */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Fail-closed JWT-hemmelighet:
//  - satt og >= 32 tegn  -> bruk den
//  - prod uten gyldig    -> kast ved oppstart (ingen usikker default i prod)
//  - dev/test            -> generer tilfeldig per-prosess + advar
function resolveSecret() {
  const env = process.env.JWT_SECRET;
  if (env && env.length >= 32) return env;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET må være satt og minst 32 tegn i produksjon');
  }
  const dev = require('crypto').randomBytes(32).toString('hex');
  console.warn('⚠ JWT_SECRET mangler/for kort — bruker tilfeldig dev-hemmelighet (tokens invalideres ved omstart)');
  return dev;
}
const SECRET = resolveSecret();
const COOKIE = 'havstund_token';

async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
async function verifyPassword(pw, hash) {
  return bcrypt.compare(pw, hash);
}

function signToken(user) {
  return jwt.sign({ id: user.id, rolle: user.rolle, navn: user.navn }, SECRET, { expiresIn: '30d' });
}
function userFromToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

function setAuthCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 3600 * 1000,
    secure: process.env.NODE_ENV === 'production',
  });
}
function clearAuthCookie(res) {
  res.clearCookie(COOKIE);
}

// Setter req.user hvis gyldig token finnes (cookie eller Bearer). Blokkerer ikke.
function authOptional(req, _res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = (req.cookies && req.cookies[COOKIE]) || bearer;
  if (token) {
    const u = userFromToken(token);
    if (u) req.user = u;
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Ikke innlogget' });
  next();
}

// Bruk: requireRole('ansatt','admin')
function requireRole(...roller) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Ikke innlogget' });
    if (!roller.includes(req.user.rolle)) return res.status(403).json({ error: 'Ingen tilgang' });
    next();
  };
}

module.exports = {
  hashPassword, verifyPassword, signToken, userFromToken,
  setAuthCookie, clearAuthCookie, authOptional, requireAuth, requireRole, COOKIE,
};
