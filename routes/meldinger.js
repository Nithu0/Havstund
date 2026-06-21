/* Havstund — kunde↔admin meldinger/tilbud (/api/meldinger).
   GET  /            -> kunde: egen tråd (markerer admin-meldinger lest).
                        ansatt/admin: ?bruker_id= -> kundens tråd + kundeinfo.
   GET  /kunder      -> ansatt/admin: kunder med meldinger + uleste-teller.
   POST /            -> kunde: {tekst}. ansatt/admin: ?bruker_id= + {tekst, pris?}.
   PATCH /:id/lest   -> marker en melding som lest.
   Tåler manglende DB (503 vennlig). */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const discord = require('../lib/discord');

const router = express.Router();

function utilgjengelig(res) {
  return res.status(503).json({ error: 'Meldinger er midlertidig utilgjengelig. Prøv igjen om litt.' });
}

const erAnsatt = (u) => u && (u.rolle === 'ansatt' || u.rolle === 'admin');

// GET / — kundens egen tråd, eller (ansatt/admin) en valgt kundes tråd
router.get('/', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  if (!req.user) return res.status(401).json({ error: 'Ikke innlogget' });

  try {
    if (erAnsatt(req.user)) {
      const brukerId = Number(req.query.bruker_id);
      if (!Number.isInteger(brukerId) || brukerId <= 0) {
        return res.status(400).json({ error: 'Mangler gyldig bruker_id' });
      }

      const kunde = await db.one(
        'SELECT id, navn, epost, rolle FROM users WHERE id = $1',
        [brukerId]
      );
      if (!kunde) return res.status(404).json({ error: 'Kunde ikke funnet' });

      const { rows } = await db.query(
        `SELECT id, bruker_id, avsender, tekst, pris, lest, opprettet
           FROM customer_messages
          WHERE bruker_id = $1
          ORDER BY opprettet ASC`,
        [brukerId]
      );

      // Marker kundens meldinger som lest når ansatt åpner tråden
      await db.query(
        "UPDATE customer_messages SET lest = true WHERE bruker_id = $1 AND avsender = 'kunde' AND lest = false",
        [brukerId]
      );

      return res.json({ kunde, meldinger: rows });
    }

    // Kunde: egen tråd
    const { rows } = await db.query(
      `SELECT id, bruker_id, avsender, tekst, pris, lest, opprettet
         FROM customer_messages
        WHERE bruker_id = $1
        ORDER BY opprettet ASC`,
      [req.user.id]
    );

    // Marker admin-meldinger som lest når kunden ser dem
    await db.query(
      "UPDATE customer_messages SET lest = true WHERE bruker_id = $1 AND avsender = 'admin' AND lest = false",
      [req.user.id]
    );

    res.json({ meldinger: rows });
  } catch (e) {
    console.error('meldinger GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente meldinger' });
  }
});

// GET /kunder — kunder som har meldinger, nyeste aktivitet først
router.get('/kunder', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);

  try {
    const { rows } = await db.query(
      `SELECT u.id AS bruker_id, u.navn, u.epost,
              m.tekst     AS siste_tekst,
              m.opprettet AS siste_tid,
              COALESCE(c.uleste, 0) AS uleste
         FROM users u
         JOIN LATERAL (
           SELECT tekst, opprettet
             FROM customer_messages
            WHERE bruker_id = u.id
            ORDER BY opprettet DESC
            LIMIT 1
         ) m ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS uleste
             FROM customer_messages
            WHERE bruker_id = u.id AND avsender = 'kunde' AND lest = false
         ) c ON true
        ORDER BY m.opprettet DESC`,
      []
    );
    res.json(rows);
  } catch (e) {
    console.error('meldinger GET /kunder feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente kunder' });
  }
});

// POST / — kunde sender melding, eller ansatt/admin svarer en kunde (evt. med pris/tilbud)
router.post('/', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  if (!req.user) return res.status(401).json({ error: 'Ikke innlogget' });

  const tekst = String((req.body && req.body.tekst) || '').trim();
  if (!tekst) return res.status(400).json({ error: 'Melding kan ikke være tom' });
  if (tekst.length > 4000) return res.status(400).json({ error: 'Meldingen er for lang' });

  try {
    if (erAnsatt(req.user)) {
      const brukerId = Number(req.query.bruker_id);
      if (!Number.isInteger(brukerId) || brukerId <= 0) {
        return res.status(400).json({ error: 'Mangler gyldig bruker_id' });
      }

      const kunde = await db.one('SELECT id FROM users WHERE id = $1', [brukerId]);
      if (!kunde) return res.status(404).json({ error: 'Kunde ikke funnet' });

      let pris = null;
      if (req.body && req.body.pris !== undefined && req.body.pris !== null && req.body.pris !== '') {
        pris = Number(req.body.pris);
        if (!Number.isInteger(pris) || pris < 0) {
          return res.status(400).json({ error: 'Ugyldig pris' });
        }
      }

      const melding = await db.one(
        `INSERT INTO customer_messages (bruker_id, avsender, tekst, pris, lest)
         VALUES ($1, 'admin', $2, $3, false)
         RETURNING id, bruker_id, avsender, tekst, pris, lest, opprettet`,
        [brukerId, tekst, pris]
      );
      return res.status(201).json({ melding });
    }

    // Kunde sender til egen tråd
    const melding = await db.one(
      `INSERT INTO customer_messages (bruker_id, avsender, tekst, pris, lest)
       VALUES ($1, 'kunde', $2, NULL, false)
       RETURNING id, bruker_id, avsender, tekst, pris, lest, opprettet`,
      [req.user.id, tekst]
    );

    // Varsle ansatte i Discord (#meldinger) — fire-and-forget
    discord.kundeMeldingVarsel(
      { navn: req.user.navn, epost: req.user.epost },
      tekst
    );

    res.status(201).json({ melding });
  } catch (e) {
    console.error('meldinger POST / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke sende melding' });
  }
});

// PATCH /:id/lest — marker en melding som lest
router.patch('/:id/lest', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  if (!req.user) return res.status(401).json({ error: 'Ikke innlogget' });

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Ugyldig melding-id' });

  try {
    const melding = await db.one(
      'SELECT id, bruker_id FROM customer_messages WHERE id = $1',
      [id]
    );
    if (!melding) return res.status(404).json({ error: 'Melding ikke funnet' });

    // Kunde kan kun røre egne meldinger; ansatt/admin kan røre alle
    if (!erAnsatt(req.user) && melding.bruker_id !== req.user.id) {
      return res.status(403).json({ error: 'Ingen tilgang' });
    }

    const oppdatert = await db.one(
      `UPDATE customer_messages SET lest = true WHERE id = $1
       RETURNING id, bruker_id, avsender, tekst, pris, lest, opprettet`,
      [id]
    );
    res.json({ melding: oppdatert });
  } catch (e) {
    console.error('meldinger PATCH /:id/lest feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere melding' });
  }
});

module.exports = router;
