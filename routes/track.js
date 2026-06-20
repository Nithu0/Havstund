/* Havstund — besøkssporing (åpen rute).
   POST /api/track {sti,referrer} -> logger en pageview med anon-id fra cookie. */
const express = require('express');
const db = require('../db');

const router = express.Router();
const ANON_COOKIE = 'havstund_anon';

function lagAnonId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

router.post('/', async (req, res) => {
  try {
    // Les/sett anon-id cookie
    let anon = req.cookies && req.cookies[ANON_COOKIE];
    if (!anon) {
      anon = lagAnonId();
      res.cookie(ANON_COOKIE, anon, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 365 * 24 * 3600 * 1000,
        secure: process.env.NODE_ENV === 'production',
      });
    }

    const sti = (req.body && typeof req.body.sti === 'string') ? req.body.sti.slice(0, 512) : null;
    const referrer = (req.body && typeof req.body.referrer === 'string') ? req.body.referrer.slice(0, 512) : null;

    // Tål manglende/utilgjengelig DB stille
    try {
      await db.query(
        'INSERT INTO pageviews (sti, referrer, anon_id) VALUES ($1, $2, $3)',
        [sti, referrer, anon]
      );
    } catch (dbErr) {
      // Logg stille, men ikke krasj sporingen
      console.error('track: DB-feil (ignorert):', dbErr.message);
    }

    return res.json({ ok: true });
  } catch (e) {
    // Aldri la sporing velte forespørselen
    return res.json({ ok: true });
  }
});

module.exports = router;
