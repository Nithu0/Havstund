/* Havstund — CRM (/api/crm).
   GET /customers/:id/profile -> samlet kundeprofil for admin:
     bruker + bookinger (join activities) + meldinger + prosjekter.
   Alle id-er parametriseres. Kun admin. */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

router.get('/customers/:id/profile', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }

  try {
    const bruker = await db.one(
      `SELECT id, navn, epost, rolle, opprettet
         FROM users
        WHERE id = $1`,
      [id]
    );
    if (!bruker) return res.status(404).json({ error: 'Kunde ikke funnet' });

    // Bookinger med aktivitetsnavn (LEFT JOIN — booking kan ha slettet aktivitet).
    const { rows: bookinger } = await db.query(
      `SELECT b.id, b.activity_id, a.navn AS aktivitet, b.dato, b.tid,
              b.antall, b.status, b.belop, b.opprettet
         FROM bookings b
         LEFT JOIN activities a ON a.id = b.activity_id
        WHERE b.bruker_id = $1
        ORDER BY b.dato DESC, b.id DESC`,
      [id]
    );

    // Kunde-meldinger (toveis: avsender 'kunde' | 'ansatt' | 'ai').
    const { rows: meldinger } = await db.query(
      `SELECT id, avsender, tekst, pris, lest, opprettet
         FROM customer_messages
        WHERE bruker_id = $1
        ORDER BY opprettet DESC
        LIMIT 100`,
      [id]
    );

    // Prosjekter knyttet til kunden.
    const { rows: prosjekter } = await db.query(
      `SELECT id, tittel, type, status, beskrivelse, opprettet, oppdatert
         FROM projects
        WHERE bruker_id = $1
        ORDER BY opprettet DESC`,
      [id]
    );

    // Avledet oppsummering for rask oversikt i UI.
    const omsetning = bookinger
      .filter((b) => b.status === 'bekreftet' || b.status === 'fullfort')
      .reduce((s, b) => s + (Number(b.belop) || 0), 0);

    res.json({
      bruker,
      bookinger,
      meldinger,
      prosjekter,
      oppsummering: {
        antall_bookinger: bookinger.length,
        antall_meldinger: meldinger.length,
        antall_prosjekter: prosjekter.length,
        omsetning,
      },
    });
  } catch (e) {
    console.error('crm GET /customers/:id/profile feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente kundeprofil' });
  }
});

module.exports = router;
