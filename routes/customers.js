/* Havstund — kundesøk (/api/customers).
   GET /search?q=  -> søk i users (navn/epost), PARAMETRISERT (ingen SQL-injection).
   Kun admin. Returnerer maks 25 treff. */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

// Søk etter kunder på navn eller e-post. Bruker ILIKE med parametrisert
// wildcard ($1) — søkestrengen havner ALDRI i SQL-teksten, så spesialtegn
// (', ;, --, %, _) kan ikke endre spørringen eller bryte ut av strengen.
router.get('/search', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const raw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!raw) {
    return res.status(400).json({ error: 'q er påkrevd' });
  }
  if (raw.length > 100) {
    return res.status(400).json({ error: 'q er for lang (maks 100)' });
  }

  // Escape LIKE-metategn (% _ \) i brukerens tekst, så de tolkes bokstavelig.
  // Selve verdien sendes som parameter — ESCAPE '\\' definerer escape-tegnet.
  const escaped = raw.replace(/[\\%_]/g, '\\$&');
  const monster = `%${escaped}%`;

  try {
    const { rows } = await db.query(
      `SELECT id, navn, epost, rolle, opprettet
         FROM users
        WHERE rolle = 'kunde'
          AND (navn ILIKE $1 ESCAPE '\\' OR epost ILIKE $1 ESCAPE '\\')
        ORDER BY navn
        LIMIT 25`,
      [monster]
    );
    res.json(rows);
  } catch (e) {
    console.error('customers GET /search feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke søke etter kunder' });
  }
});

module.exports = router;
