/* Havstund — bookinger (/api/bookings).
   POST /        -> opprett booking (gjest eller innlogget)
   GET  /        -> ansatt/admin: alle; kunde: egne; ellers 401
   PATCH /:id    -> kun ansatt/admin: oppdater status */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const discord = require('../lib/discord');

const router = express.Router();

const GYLDIG_STATUS = ['forespurt', 'bekreftet', 'avlyst', 'fullfort'];

// Opprett booking
router.post('/', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const { activity_id, navn, epost, tlf, dato, tid, antall, melding } = req.body || {};

  // Validering
  if (!activity_id || !navn || !epost || !dato) {
    return res.status(400).json({ error: 'Mangler påkrevde felt (aktivitet, navn, e-post, dato)' });
  }
  const aktId = Number(activity_id);
  if (!Number.isInteger(aktId)) {
    return res.status(400).json({ error: 'Ugyldig aktivitet' });
  }
  const antallN = Number.parseInt(antall, 10) || 1;
  if (antallN < 1) {
    return res.status(400).json({ error: 'Antall må være minst 1' });
  }

  try {
    // Hent aktivitetens pris
    const akt = await db.one(
      'SELECT id, pris, navn FROM activities WHERE id = $1 AND aktiv = true',
      [aktId]
    );
    if (!akt) return res.status(404).json({ error: 'Aktivitet ikke funnet' });

    const belop = antallN * akt.pris;
    const brukerId = req.user ? req.user.id : null;

    const booking = await db.one(
      `INSERT INTO bookings
         (activity_id, bruker_id, navn, epost, tlf, dato, tid, antall, status, belop, melding)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'forespurt',$9,$10)
       RETURNING *`,
      [aktId, brukerId, navn, epost, tlf || null, dato, tid || null, antallN, belop, melding || null]
    );

    // Varsle Discord (#general) — fire-and-forget, stopper aldri bookingen
    discord.bookingVarsel(booking, akt.navn);

    // Speil bookingen som inntektspost i regnskapet — feiler aldri bookingen
    try {
      const finnes = await db.one(
        'SELECT id FROM regnskap_poster WHERE booking_id = $1',
        [booking.id]
      );
      if (!finnes) {
        const brutto_ore = booking.belop * 100;
        const netto_ore = Math.round(brutto_ore / 1.25);
        const mva_ore = brutto_ore - netto_ore;
        await db.query(
          `INSERT INTO regnskap_poster
             (type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
              netto_ore, mva_ore, brutto_ore, betalingsmetode, kilde, booking_id)
           VALUES ('inntekt',$1,$2,$3,3000,3,25,$4,$5,$6,NULL,'booking',$7)`,
          [
            booking.dato,
            booking.navn,
            `${akt.navn} (${booking.antall} pers)`,
            netto_ore,
            mva_ore,
            brutto_ore,
            booking.id,
          ]
        );
      }
    } catch (regnskapFeil) {
      console.error('bookings: kunne ikke opprette regnskapspost:', regnskapFeil.message);
    }

    res.status(201).json({ booking });
  } catch (e) {
    console.error('bookings POST / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke opprette booking' });
  }
});

// Hent bookinger (rollebasert)
router.get('/', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  if (!req.user) {
    return res.status(401).json({ error: 'Ikke innlogget' });
  }

  try {
    const erAnsatt = req.user.rolle === 'ansatt' || req.user.rolle === 'admin';
    if (erAnsatt) {
      const { rows } = await db.query(
        `SELECT b.*, a.navn AS aktivitet_navn
           FROM bookings b
           LEFT JOIN activities a ON a.id = b.activity_id
          ORDER BY b.opprettet DESC`,
        []
      );
      return res.json(rows);
    }

    const { rows } = await db.query(
      `SELECT b.*, a.navn AS aktivitet_navn
         FROM bookings b
         LEFT JOIN activities a ON a.id = b.activity_id
        WHERE b.bruker_id = $1
        ORDER BY b.opprettet DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (e) {
    console.error('bookings GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente bookinger' });
  }
});

// Oppdater status (kun ansatt/admin)
router.patch('/:id', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  const { status } = req.body || {};
  if (!status || !GYLDIG_STATUS.includes(status)) {
    return res.status(400).json({ error: 'Ugyldig status' });
  }

  try {
    const booking = await db.one(
      'UPDATE bookings SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });
    res.json({ booking });
  } catch (e) {
    console.error('bookings PATCH /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere booking' });
  }
});

module.exports = router;
