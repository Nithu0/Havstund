/* Havstund — /api/auth: registrering, innlogging, utlogging, /me.
   Token i httpOnly-cookie (lib/auth). Roller: 'kunde' | 'ansatt' | 'admin'. */
const express = require('express');
const db = require('../db');
const {
  hashPassword, verifyPassword, signToken, setAuthCookie, clearAuthCookie,
} = require('../lib/auth');

const router = express.Router();

// Enkel e-postvalidering (god nok for skjema).
const EPOST_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function rensEpost(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

// Felles 503-svar når databasen ikke er konfigurert (DATABASE_URL mangler).
function dbUtilgjengelig(res) {
  return res.status(503).json({
    error: 'Innlogging er midlertidig utilgjengelig. Prøv igjen senere.',
  });
}

function offentligBruker(u) {
  return { id: u.id, navn: u.navn, epost: u.epost, rolle: u.rolle };
}

/* POST /api/auth/register {navn,epost,passord} */
router.post('/register', async (req, res) => {
  try {
    const navn = typeof req.body.navn === 'string' ? req.body.navn.trim() : '';
    const epost = rensEpost(req.body.epost);
    const passord = typeof req.body.passord === 'string' ? req.body.passord : '';

    if (!navn) return res.status(400).json({ error: 'Navn må fylles ut.' });
    if (!EPOST_RE.test(epost)) return res.status(400).json({ error: 'Ugyldig e-postadresse.' });
    if (passord.length < 6) {
      return res.status(400).json({ error: 'Passordet må være minst 6 tegn.' });
    }

    const finnes = await db.one('SELECT id FROM users WHERE epost=$1', [epost]);
    if (finnes) {
      return res.status(409).json({ error: 'E-postadressen er allerede registrert.' });
    }

    const hash = await hashPassword(passord);
    const bruker = await db.one(
      `INSERT INTO users (navn, epost, passord_hash, rolle)
       VALUES ($1, $2, $3, 'kunde')
       RETURNING id, navn, epost, rolle`,
      [navn, epost, hash],
    );

    const token = signToken(bruker);
    setAuthCookie(res, token);
    return res.status(201).json({ user: offentligBruker(bruker) });
  } catch (e) {
    if (/Database ikke konfigurert/i.test(e.message)) return dbUtilgjengelig(res);
    console.error('register-feil:', e.message);
    return res.status(500).json({ error: 'Noe gikk galt ved registrering.' });
  }
});

/* POST /api/auth/login {epost,passord} */
router.post('/login', async (req, res) => {
  try {
    const epost = rensEpost(req.body.epost);
    const passord = typeof req.body.passord === 'string' ? req.body.passord : '';

    if (!epost || !passord) {
      return res.status(400).json({ error: 'Fyll ut e-post og passord.' });
    }

    const bruker = await db.one(
      'SELECT id, navn, epost, rolle, passord_hash FROM users WHERE epost=$1',
      [epost],
    );
    if (!bruker || !(await verifyPassword(passord, bruker.passord_hash))) {
      return res.status(401).json({ error: 'Feil e-post eller passord.' });
    }

    const token = signToken(bruker);
    setAuthCookie(res, token);
    return res.json({ user: offentligBruker(bruker) });
  } catch (e) {
    if (/Database ikke konfigurert/i.test(e.message)) return dbUtilgjengelig(res);
    console.error('login-feil:', e.message);
    return res.status(500).json({ error: 'Noe gikk galt ved innlogging.' });
  }
});

/* POST /api/auth/logout */
router.post('/logout', (req, res) => {
  clearAuthCookie(res);
  return res.json({ ok: true });
});

/* GET /api/auth/me */
router.get('/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Ikke innlogget' });
  try {
    const bruker = await db.one(
      'SELECT id, navn, epost, rolle FROM users WHERE id=$1',
      [req.user.id],
    );
    if (!bruker) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Ikke innlogget' });
    }
    return res.json({ user: offentligBruker(bruker) });
  } catch (e) {
    if (/Database ikke konfigurert/i.test(e.message)) return dbUtilgjengelig(res);
    console.error('me-feil:', e.message);
    return res.status(500).json({ error: 'Noe gikk galt.' });
  }
});

module.exports = router;
