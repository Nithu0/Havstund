/* Havstund — aktiviteter (/api/activities).
   GET /        -> aktive aktiviteter sortert på sortering
   GET /:id     -> én aktivitet (404 hvis ikke funnet) */
const express = require('express');
const db = require('../db');

const router = express.Router();

const FELT = 'id, slug, navn, beskrivelse, varighet, pris, kapasitet, bilde';

// Liste aktive aktiviteter
router.get('/', async (_req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  try {
    const { rows } = await db.query(
      `SELECT ${FELT} FROM activities WHERE aktiv = true ORDER BY sortering`,
      []
    );
    res.json(rows);
  } catch (e) {
    console.error('activities GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente aktiviteter' });
  }
});

// Én aktivitet
router.get('/:id', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  try {
    const rad = await db.one(
      `SELECT ${FELT} FROM activities WHERE id = $1 AND aktiv = true`,
      [id]
    );
    if (!rad) return res.status(404).json({ error: 'Aktivitet ikke funnet' });
    res.json(rad);
  } catch (e) {
    console.error('activities GET /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente aktivitet' });
  }
});

module.exports = router;
