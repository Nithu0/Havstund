const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

// GET / -> liste kvitteringer
router.get('/', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Databasen er ikke konfigurert' });
  }

  if (!req.user) {
    return res.status(401).json({ error: 'Du må være innlogget for å se kvitteringer' });
  }

  try {
    // Kunde ser kun egne kvitteringer
    if (req.user.rolle === 'kunde') {
      const result = await db.query(
        'SELECT * FROM receipts WHERE bruker_id = $1 ORDER BY opprettet DESC',
        [req.user.id]
      );
      return res.json({ receipts: result.rows });
    }

    // Ansatt/admin ser alle, evt. filtrert på ?bruker_id=
    const brukerId = req.query.bruker_id;
    if (brukerId !== undefined) {
      const parsed = parseInt(brukerId, 10);
      if (!Number.isInteger(parsed) || String(parsed) !== String(brukerId).trim()) {
        return res.status(400).json({ error: 'Ugyldig bruker_id' });
      }
      const result = await db.query(
        `SELECT r.*, u.navn AS kundenavn
         FROM receipts r
         LEFT JOIN users u ON u.id = r.bruker_id
         WHERE r.bruker_id = $1
         ORDER BY r.opprettet DESC`,
        [parsed]
      );
      return res.json({ receipts: result.rows });
    }

    const result = await db.query(
      `SELECT r.*, u.navn AS kundenavn
       FROM receipts r
       LEFT JOIN users u ON u.id = r.bruker_id
       ORDER BY r.opprettet DESC`
    );
    return res.json({ receipts: result.rows });
  } catch (err) {
    console.error('Feil ved henting av kvitteringer:', err);
    return res.status(500).json({ error: 'Kunne ikke hente kvitteringer' });
  }
});

// POST / -> opprett kvittering (ansatt/admin)
router.post('/', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Databasen er ikke konfigurert' });
  }

  try {
    const { bruker_id, booking_id, belop, beskrivelse, betalt, dato } = req.body || {};

    const brukerId = parseInt(bruker_id, 10);
    if (!Number.isInteger(brukerId) || brukerId <= 0) {
      return res.status(400).json({ error: 'Gyldig bruker_id er påkrevd' });
    }

    const belopInt = parseInt(belop, 10);
    if (!Number.isInteger(belopInt) || belopInt < 0 || String(belopInt) !== String(belop).trim()) {
      return res.status(400).json({ error: 'Beløp må være et heltall større enn eller lik 0' });
    }

    const result = await db.query(
      `INSERT INTO receipts (bruker_id, booking_id, belop, beskrivelse, betalt, dato, opprettet)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       RETURNING *`,
      [
        brukerId,
        booking_id ?? null,
        belopInt,
        beskrivelse ?? null,
        betalt === true,
        dato ?? null,
      ]
    );

    return res.status(201).json({ receipt: result.rows[0] });
  } catch (err) {
    console.error('Feil ved opprettelse av kvittering:', err);
    return res.status(500).json({ error: 'Kunne ikke opprette kvittering' });
  }
});

// PATCH /:id -> oppdater kvittering (ansatt/admin)
router.patch('/:id', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Databasen er ikke konfigurert' });
  }

  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Ugyldig id' });
    }

    const { betalt, belop, beskrivelse } = req.body || {};

    const felter = [];
    const verdier = [];
    let i = 1;

    if (betalt !== undefined) {
      felter.push(`betalt = $${i++}`);
      verdier.push(betalt === true);
    }

    if (belop !== undefined) {
      const belopInt = parseInt(belop, 10);
      if (!Number.isInteger(belopInt) || belopInt < 0 || String(belopInt) !== String(belop).trim()) {
        return res.status(400).json({ error: 'Beløp må være et heltall større enn eller lik 0' });
      }
      felter.push(`belop = $${i++}`);
      verdier.push(belopInt);
    }

    if (beskrivelse !== undefined) {
      felter.push(`beskrivelse = $${i++}`);
      verdier.push(beskrivelse);
    }

    if (felter.length === 0) {
      return res.status(400).json({ error: 'Ingen felter å oppdatere' });
    }

    verdier.push(id);
    const result = await db.query(
      `UPDATE receipts SET ${felter.join(', ')} WHERE id = $${i} RETURNING *`,
      verdier
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Kvittering ikke funnet' });
    }

    return res.json({ receipt: result.rows[0] });
  } catch (err) {
    console.error('Feil ved oppdatering av kvittering:', err);
    return res.status(500).json({ error: 'Kunne ikke oppdatere kvittering' });
  }
});

module.exports = router;
