/* Havstund — økonomi-scenarioer (/api/finance). KUN admin.
   GET    /     -> brukerens lagrede scenarioer
   POST   /     -> {navn,data} lagre nytt scenario
   DELETE /:id  -> slett brukerens scenario */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

// Alle ruter krever admin.
router.use(requireRole('admin'));

// Hent brukerens scenarioer
router.get('/', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  try {
    const { rows } = await db.query(
      `SELECT id, navn, data, oppdatert
         FROM finance_scenarios
        WHERE bruker_id = $1
        ORDER BY oppdatert DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('finance GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente scenarioer' });
  }
});

// Lagre nytt scenario
router.post('/', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const { navn, data } = req.body || {};
  if (!navn || typeof navn !== 'string') {
    return res.status(400).json({ error: 'Mangler navn' });
  }
  if (data === undefined || data === null || typeof data !== 'object') {
    return res.status(400).json({ error: 'Mangler data' });
  }
  try {
    const scenario = await db.one(
      `INSERT INTO finance_scenarios (bruker_id, navn, data)
       VALUES ($1, $2, $3)
       RETURNING id, navn, data, oppdatert`,
      [req.user.id, navn, JSON.stringify(data)]
    );
    res.status(201).json({ scenario });
  } catch (e) {
    console.error('finance POST / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre scenario' });
  }
});

// Slett brukerens scenario
router.delete('/:id', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  try {
    const slettet = await db.one(
      'DELETE FROM finance_scenarios WHERE id = $1 AND bruker_id = $2 RETURNING id',
      [id, req.user.id]
    );
    if (!slettet) return res.status(404).json({ error: 'Scenario ikke funnet' });
    res.json({ ok: true, id: slettet.id });
  } catch (e) {
    console.error('finance DELETE /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke slette scenario' });
  }
});

module.exports = router;
