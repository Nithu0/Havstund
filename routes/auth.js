/* Havstund — /api/auth: registrering, innlogging, utlogging, /me.
   Token i httpOnly-cookie (lib/auth). Roller: 'kunde' | 'ansatt' | 'admin'. */
const express = require('express');
const db = require('../db');
const {
  hashPassword, verifyPassword, signToken, setAuthCookie, clearAuthCookie, requireAuth,
} = require('../lib/auth');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

// Enkel e-postvalidering (god nok for skjema).
const EPOST_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Minste tillatte passordlengde — konfigurerbar via env, default 8.
const MIN_PW = Number.parseInt(process.env.MIN_PASSORD_LENGTH, 10) || 8;

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
  return {
    id: u.id,
    navn: u.navn,
    epost: u.epost,
    rolle: u.rolle,
    ai_agent_enabled: !!u.ai_agent_enabled,
  };
}

/* POST /api/auth/register {navn,epost,passord} */
router.post('/register', async (req, res) => {
  try {
    const navn = typeof req.body.navn === 'string' ? req.body.navn.trim() : '';
    const epost = rensEpost(req.body.epost);
    const passord = typeof req.body.passord === 'string' ? req.body.passord : '';

    if (!navn) return res.status(400).json({ error: 'Navn må fylles ut.' });
    if (!EPOST_RE.test(epost)) return res.status(400).json({ error: 'Ugyldig e-postadresse.' });
    if (passord.length < MIN_PW) {
      return res.status(400).json({ error: `Passordet må være minst ${MIN_PW} tegn.` });
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
    // Race: forhaandssjekken passerte, men INSERT tapte pga UNIQUE(epost) -> 23505.
    // Map til samme 409 som forhaandssjekken (speiler routes/staff.js /invite).
    if (e.code === '23505') {
      return res.status(409).json({ error: 'E-postadressen er allerede registrert.' });
    }
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

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(
      { id: bruker.id, navn: bruker.navn },
      'login',
      { epost: bruker.epost, rolle: bruker.rolle },
    );

    return res.json({ user: offentligBruker(bruker) });
  } catch (e) {
    if (/Database ikke konfigurert/i.test(e.message)) return dbUtilgjengelig(res);
    console.error('login-feil:', e.message);
    return res.status(500).json({ error: 'Noe gikk galt ved innlogging.' });
  }
});

/* GET /api/auth/magic/:token — magisk innlogging via engangs-token.
   Kunden fikk lenken paa e-post da bookingen opprettet/knyttet en konto.
   Gyldig token -> samme JWT-cookie som /login + redirect til Min side.
   Ugyldig/utloept -> redirect til /konto (ingen lekkasje om hvorfor).
   ENGANGS: token slettes i SAMME transaksjon som det valideres/konsumeres,
   saa en gjenbruk (dobbeltklikk/race) ikke kan logge inn to ganger. */
router.get('/magic/:token', async (req, res) => {
  const token = typeof req.params.token === 'string' ? req.params.token : '';
  if (!token) return res.redirect('/konto?feil=lenke');
  if (!db.isConfigured()) return res.redirect('/konto?feil=utilgjengelig');

  try {
    // valider + slaa opp bruker + slett token ATOMISK. SELECT ... FOR UPDATE
    // laaser token-raden paa SAMME connection gjennom hele tx (db.withTransaction),
    // saa to samtidige treff paa samme token serialiseres — den andre finner
    // raden slettet og faar null (ingen dobbel innlogging).
    const bruker = await db.withTransaction(async (client) => {
      const { rows: tokRows } = await client.query(
        'SELECT token, user_id, utloper FROM reset_tokens WHERE token = $1 FOR UPDATE',
        [token],
      );
      const rad = tokRows[0];
      // Mangler, mangler utloeps-tid, eller utloept -> ugyldig.
      if (!rad || rad.utloper == null || new Date(rad.utloper).getTime() <= Date.now()) {
        return null;
      }

      const { rows: brukerRows } = await client.query(
        'SELECT id, navn, epost, rolle FROM users WHERE id = $1',
        [rad.user_id],
      );
      const u = brukerRows[0];
      if (!u) return null;

      // ENGANGS: konsumer token i samme tx (etter vellykket brukeroppslag).
      await client.query('DELETE FROM reset_tokens WHERE token = $1', [token]);
      return u;
    });

    if (!bruker) return res.redirect('/konto?feil=lenke');

    // Samme token-/cookie-mekanisme som /login (signToken + setAuthCookie:
    // httpOnly, sameSite=lax, secure i prod).
    const jwtToken = signToken(bruker);
    setAuthCookie(res, jwtToken);

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(
      { id: bruker.id, navn: bruker.navn },
      'magisk-innlogging',
      { epost: bruker.epost, rolle: bruker.rolle },
    );

    return res.redirect('/min-side');
  } catch (e) {
    if (/Database ikke konfigurert/i.test(e.message)) return res.redirect('/konto?feil=utilgjengelig');
    console.error('magic-feil:', e.message);
    return res.redirect('/konto?feil=serverfeil');
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
      'SELECT id, navn, epost, rolle, ai_agent_enabled FROM users WHERE id=$1',
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

/* POST /api/auth/change-password {gammelt,nytt} — krever innlogging. */
router.post('/change-password', requireAuth, async (req, res) => {
  try {
    const gammelt = typeof req.body.gammelt === 'string' ? req.body.gammelt : '';
    const nytt = typeof req.body.nytt === 'string' ? req.body.nytt : '';

    if (!gammelt || !nytt) {
      return res.status(400).json({ error: 'Fyll ut både gammelt og nytt passord.' });
    }
    if (nytt.length < MIN_PW) {
      return res.status(400).json({ error: `Det nye passordet må være minst ${MIN_PW} tegn.` });
    }

    const bruker = await db.one(
      'SELECT passord_hash FROM users WHERE id=$1',
      [req.user.id],
    );
    if (!bruker) {
      clearAuthCookie(res);
      return res.status(401).json({ error: 'Ikke innlogget' });
    }

    if (!(await verifyPassword(gammelt, bruker.passord_hash))) {
      return res.status(403).json({ error: 'Feil nåværende passord.' });
    }

    const hash = await hashPassword(nytt);
    await db.query('UPDATE users SET passord_hash=$1 WHERE id=$2', [hash, req.user.id]);

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(req.user, 'passordbytte', { user_id: req.user.id });

    return res.json({ ok: true });
  } catch (e) {
    if (/Database ikke konfigurert/i.test(e.message)) return dbUtilgjengelig(res);
    console.error('change-password-feil:', e.message);
    return res.status(500).json({ error: 'Noe gikk galt ved passordbytte.' });
  }
});

module.exports = router;
