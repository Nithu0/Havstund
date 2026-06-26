/* Havstund — admin/dashboard-API (ansatt + admin).
   Statistikk for besøk/bookinger/omsetning + innholds-CMS. */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

// Alle ruter krever ansatt eller admin
router.use(requireRole('ansatt', 'admin'));

// GET /api/admin/stats
router.get('/stats', async (_req, res) => {
  try {
    // Besøk i dag (distinkte besøkende)
    const besokIdag = await db.one(
      `SELECT COUNT(DISTINCT COALESCE(anon_id, id::text)) AS n
         FROM pageviews
        WHERE opprettet >= CURRENT_DATE`,
      []
    );

    // Besøk siste 7 dager (distinkte besøkende)
    const besok7d = await db.one(
      `SELECT COUNT(DISTINCT COALESCE(anon_id, id::text)) AS n
         FROM pageviews
        WHERE opprettet >= CURRENT_DATE - INTERVAL '6 days'`,
      []
    );

    // Nye bookinger (status forespurt)
    const bookingerNye = await db.one(
      `SELECT COUNT(*) AS n FROM bookings WHERE status = 'forespurt'`,
      []
    );

    // Totalt antall bookinger
    const bookingerTotalt = await db.one(
      `SELECT COUNT(*) AS n FROM bookings`,
      []
    );

    // Omsetning siste 30 dager (bekreftet + fullfort)
    const omsetning30d = await db.one(
      `SELECT COALESCE(SUM(belop), 0) AS sum
         FROM bookings
        WHERE status IN ('bekreftet','fullfort')
          AND opprettet >= CURRENT_DATE - INTERVAL '29 days'`,
      []
    );

    // 7-dagers serie: en rad per dag med besøk + bookinger
    const { rows: serieRader } = await db.query(
      `WITH dager AS (
         SELECT generate_series(
           CURRENT_DATE - INTERVAL '6 days',
           CURRENT_DATE,
           INTERVAL '1 day'
         )::date AS dag
       ),
       besok AS (
         SELECT date_trunc('day', opprettet)::date AS dag,
                COUNT(DISTINCT COALESCE(anon_id, id::text)) AS n
           FROM pageviews
          WHERE opprettet >= CURRENT_DATE - INTERVAL '6 days'
          GROUP BY 1
       ),
       book AS (
         SELECT date_trunc('day', opprettet)::date AS dag,
                COUNT(*) AS n
           FROM bookings
          WHERE opprettet >= CURRENT_DATE - INTERVAL '6 days'
          GROUP BY 1
       )
       SELECT to_char(d.dag, 'YYYY-MM-DD') AS dag,
              COALESCE(b.n, 0)::int  AS besok,
              COALESCE(bk.n, 0)::int AS bookinger
         FROM dager d
         LEFT JOIN besok b  ON b.dag  = d.dag
         LEFT JOIN book  bk ON bk.dag = d.dag
        ORDER BY d.dag`,
      []
    );

    return res.json({
      besokIdag: Number(besokIdag ? besokIdag.n : 0),
      besok7d: Number(besok7d ? besok7d.n : 0),
      bookingerNye: Number(bookingerNye ? bookingerNye.n : 0),
      bookingerTotalt: Number(bookingerTotalt ? bookingerTotalt.n : 0),
      omsetning30d: Number(omsetning30d ? omsetning30d.sum : 0),
      serie: serieRader,
    });
  } catch (e) {
    console.error('admin/stats-feil:', e.message);
    return res.status(500).json({ error: 'Kunne ikke hente statistikk' });
  }
});

// GET /api/admin/content -> alle innholdsrader
router.get('/content', async (_req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT nokkel, verdi, oppdatert FROM content ORDER BY nokkel',
      []
    );
    return res.json(rows);
  } catch (e) {
    console.error('admin/content-feil:', e.message);
    return res.status(500).json({ error: 'Kunne ikke hente innhold' });
  }
});

// PUT /api/admin/content/:nokkel {verdi} -> upsert
router.put('/content/:nokkel', async (req, res) => {
  try {
    const nokkel = req.params.nokkel;
    const verdi = (req.body && req.body.verdi != null) ? String(req.body.verdi) : '';
    if (!nokkel) return res.status(400).json({ error: 'Mangler nøkkel' });
    if (!/^[a-z0-9_.-]{1,64}$/.test(nokkel)) {
      return res.status(400).json({ error: 'Ugyldig nøkkel (kun a-z, 0-9, _ . - og maks 64 tegn)' });
    }
    if (verdi.length > 50000) {
      return res.status(400).json({ error: 'Verdien er for stor (maks 50 000 tegn)' });
    }

    const rad = await db.one(
      `INSERT INTO content (nokkel, verdi, oppdatert)
            VALUES ($1, $2, now())
       ON CONFLICT (nokkel)
       DO UPDATE SET verdi = EXCLUDED.verdi, oppdatert = now()
       RETURNING nokkel, verdi, oppdatert`,
      [nokkel, verdi]
    );

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(req.user, 'cms:endret', { nokkel });

    return res.json(rad);
  } catch (e) {
    console.error('admin/content put-feil:', e.message);
    return res.status(500).json({ error: 'Kunne ikke lagre innhold' });
  }
});

module.exports = router;
