/* Havstund — ansatte-administrasjon (/api/staff).
   Alt krever rolle 'admin'.
   GET  /                 -> list brukere med rolle 'ansatt'|'admin'
   POST /invite           -> opprett bruker (rolle) + engangs-token i reset_tokens
   POST /:id/deactivate   -> sett bruker til rolle 'kunde' (deaktiver tilgang)
   2FA (innlogget bruker):
   POST /2fa/setup        -> speakeasy-secret + qrcode dataURL (lagrer secret, ikke aktivert)
   POST /2fa/verify {kode} -> verifiser TOTP -> users.totp_enabled=true */
const crypto = require('crypto');
const express = require('express');
const speakeasy = require('speakeasy');
const qrcode = require('qrcode');
const db = require('../db');
const { requireRole, requireAuth } = require('../lib/auth');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

const EPOST_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Roller som kan inviteres som ansatt/admin.
const STAFF_ROLLER = new Set(['ansatt', 'admin']);
// Token-levetid for invitasjon: 7 dager.
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

function rensEpost(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function dbUtilgjengelig(res) {
  return res.status(503).json({ error: 'Database ikke tilgjengelig' });
}

function offentligBruker(u) {
  return {
    id: u.id,
    navn: u.navn,
    epost: u.epost,
    rolle: u.rolle,
    totp_enabled: !!u.totp_enabled,
  };
}

/* GET /api/staff — list ansatte + admin. */
router.get('/', requireRole('admin'), async (_req, res) => {
  if (!db.isConfigured()) return dbUtilgjengelig(res);
  try {
    const { rows } = await db.query(
      `SELECT id, navn, epost, rolle, totp_enabled
         FROM users
        WHERE rolle IN ('ansatt', 'admin')
        ORDER BY rolle, navn, id`,
      [],
    );
    res.json(rows.map(offentligBruker));
  } catch (e) {
    console.error('staff GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente ansatte' });
  }
});

/* POST /api/staff/invite {epost, rolle} — opprett bruker + engangs-token. */
router.post('/invite', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) return dbUtilgjengelig(res);

  const epost = rensEpost(req.body && req.body.epost);
  const rolle = typeof (req.body && req.body.rolle) === 'string' ? req.body.rolle.trim() : '';

  if (!EPOST_RE.test(epost)) return res.status(400).json({ error: 'Ugyldig e-postadresse.' });
  if (!STAFF_ROLLER.has(rolle)) {
    return res.status(400).json({ error: "rolle må være 'ansatt' eller 'admin'." });
  }

  try {
    const finnes = await db.one('SELECT id FROM users WHERE epost=$1', [epost]);
    if (finnes) return res.status(409).json({ error: 'E-postadressen er allerede registrert.' });

    // Tilfeldig passord-hash som plassholder — brukeren setter eget passord via token.
    const plassholder = crypto.randomBytes(32).toString('hex');
    const bruker = await db.one(
      `INSERT INTO users (navn, epost, passord_hash, rolle)
       VALUES ($1, $2, $3, $4)
       RETURNING id, navn, epost, rolle, totp_enabled`,
      [epost.split('@')[0], epost, plassholder, rolle],
    );

    const token = crypto.randomBytes(32).toString('hex');
    const utloper = new Date(Date.now() + INVITE_TTL_MS);
    await db.query(
      'INSERT INTO reset_tokens (token, user_id, utloper) VALUES ($1, $2, $3)',
      [token, bruker.id, utloper],
    );

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(req.user, 'staff:invite', { maal: bruker.id, epost: bruker.epost, rolle: bruker.rolle });

    res.status(201).json({ user: offentligBruker(bruker), token });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'E-postadressen er allerede registrert.' });
    }
    console.error('staff POST /invite feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke invitere ansatt' });
  }
});

/* POST /api/staff/:id/deactivate — degrader til 'kunde' (fjern ansatt-tilgang). */
router.post('/:id/deactivate', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) return dbUtilgjengelig(res);

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });

  if (req.user && req.user.id === id) {
    return res.status(400).json({ error: 'Du kan ikke deaktivere deg selv.' });
  }

  try {
    const rad = await db.one(
      `UPDATE users SET rolle='kunde'
        WHERE id=$1 AND rolle IN ('ansatt', 'admin')
      RETURNING id, navn, epost, rolle, totp_enabled`,
      [id],
    );
    if (!rad) return res.status(404).json({ error: 'Ansatt ikke funnet' });

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(req.user, 'staff:deaktiver', { maal: rad.id, epost: rad.epost });

    res.json({ ok: true, user: offentligBruker(rad) });
  } catch (e) {
    console.error('staff POST /:id/deactivate feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke deaktivere ansatt' });
  }
});

/* POST /api/staff/2fa/setup — generer secret + qrcode for innlogget bruker. */
router.post('/2fa/setup', requireAuth, async (req, res) => {
  if (!db.isConfigured()) return dbUtilgjengelig(res);
  try {
    const secret = speakeasy.generateSecret({
      name: `Havstund (${req.user.navn || req.user.id})`,
    });
    // Lagrer secret, men aktiverer ikke før /2fa/verify lykkes.
    await db.query('UPDATE users SET totp_secret=$1, totp_enabled=false WHERE id=$2', [
      secret.base32,
      req.user.id,
    ]);
    const qr = await qrcode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qr, otpauth_url: secret.otpauth_url });
  } catch (e) {
    console.error('staff POST /2fa/setup feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke starte 2FA-oppsett' });
  }
});

/* POST /api/staff/2fa/verify {kode} — verifiser TOTP -> aktiver 2FA. */
router.post('/2fa/verify', requireAuth, async (req, res) => {
  if (!db.isConfigured()) return dbUtilgjengelig(res);

  const kode = typeof (req.body && req.body.kode) === 'string' ? req.body.kode.trim() : '';
  if (!kode) return res.status(400).json({ error: 'Fyll ut engangskoden.' });

  try {
    const bruker = await db.one('SELECT totp_secret FROM users WHERE id=$1', [req.user.id]);
    if (!bruker || !bruker.totp_secret) {
      return res.status(400).json({ error: '2FA er ikke satt opp. Kjør oppsett først.' });
    }

    const ok = speakeasy.totp.verify({
      secret: bruker.totp_secret,
      encoding: 'base32',
      token: kode,
      window: 1,
    });
    if (!ok) return res.status(403).json({ error: 'Feil engangskode.' });

    await db.query('UPDATE users SET totp_enabled=true WHERE id=$1', [req.user.id]);

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(req.user, '2fa:aktivert', { maal: req.user.id });

    res.json({ ok: true, totp_enabled: true });
  } catch (e) {
    console.error('staff POST /2fa/verify feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke verifisere 2FA' });
  }
});

module.exports = router;
