/* Havstund — innsikt / forretningsmetrikker (/api/insights).
   Kun ansatt/admin. Read-only aggregater over bookings (+ activities).
   belop pa bookings er i HELE kroner (jf. routes/export.js), ikke ore.

   GET /activity-stats  -> bookinger + omsetning per aktivitet
                           (LEFT JOIN activities slik at ukjent aktivitet tas med)
   GET /customer-metrics -> CLV per kunde (sum belop per epost, kun bekreftet/fullfort) */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

// Alt under /api/insights krever ansatt eller admin
router.use(requireRole('ansatt', 'admin'));

function utilgjengelig(res) {
  return res.status(503).json({ error: 'Innsikt er midlertidig utilgjengelig.' });
}

// Status som teller som faktisk omsetning (forespurt/avlyst teller ikke).
const OMSETNING_STATUS = ['bekreftet', 'fullfort'];

// ---------- AKTIVITETS-STATISTIKK ----------
// Bookinger + personer + omsetning per aktivitet. LEFT JOIN slik at bookinger
// uten matchende aktivitet (NULL activity_id) tas med som "(ukjent aktivitet)".
router.get('/activity-stats', async (_req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  try {
    const { rows } = await db.query(
      `SELECT a.id                          AS activity_id,
              a.navn                        AS aktivitet,
              COUNT(b.id)::int              AS antall_bookinger,
              COALESCE(SUM(b.antall), 0)::int AS antall_personer,
              COALESCE(SUM(
                CASE WHEN b.status = ANY($1) THEN b.belop ELSE 0 END
              ), 0)::bigint                 AS omsetning
         FROM bookings b
         LEFT JOIN activities a ON a.id = b.activity_id
        GROUP BY a.id, a.navn
        ORDER BY omsetning DESC, antall_bookinger DESC`,
      [OMSETNING_STATUS]
    );
    res.json(
      rows.map((r) => ({
        activity_id: r.activity_id,
        aktivitet: r.aktivitet == null ? '(ukjent aktivitet)' : r.aktivitet,
        antall_bookinger: r.antall_bookinger,
        antall_personer: r.antall_personer,
        omsetning: Number(r.omsetning),
      }))
    );
  } catch (e) {
    console.error('insights /activity-stats feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente aktivitets-statistikk' });
  }
});

// ---------- KUNDE-METRIKKER (CLV) ----------
// CLV = sum belop per kunde. Grupperer pa epost (lower) fordi gjester ikke har
// bruker_id. Kun bekreftet/fullfort regnes som omsetning.
router.get('/customer-metrics', async (_req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  try {
    const { rows } = await db.query(
      `SELECT lower(b.epost)                AS epost,
              MAX(b.navn)                   AS navn,
              COUNT(b.id)::int              AS antall_bookinger,
              COALESCE(SUM(
                CASE WHEN b.status = ANY($1) THEN b.belop ELSE 0 END
              ), 0)::bigint                 AS clv,
              MIN(b.opprettet)              AS forste_booking,
              MAX(b.opprettet)              AS siste_booking
         FROM bookings b
        WHERE b.epost IS NOT NULL AND b.epost <> ''
        GROUP BY lower(b.epost)
        ORDER BY clv DESC, antall_bookinger DESC`,
      [OMSETNING_STATUS]
    );
    res.json(
      rows.map((r) => ({
        epost: r.epost,
        navn: r.navn,
        antall_bookinger: r.antall_bookinger,
        clv: Number(r.clv),
        forste_booking: r.forste_booking,
        siste_booking: r.siste_booking,
      }))
    );
  } catch (e) {
    console.error('insights /customer-metrics feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente kunde-metrikker' });
  }
});

module.exports = router;
