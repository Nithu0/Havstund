/* Havstund — bookinger (/api/bookings).
   POST /        -> opprett booking (gjest eller innlogget)
   GET  /        -> ansatt/admin: alle; kunde: egne; ellers 401
   PATCH /:id    -> kun ansatt/admin: oppdater status */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const { mvaSplitt } = require('../lib/regnskap');
const discord = require('../lib/discord');
const email = require('../lib/email');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

const GYLDIG_STATUS = ['forespurt', 'bekreftet', 'avlyst', 'fullfort'];

// business_hours bruker ukedag 0=mandag .. 6=sondag (se db/seed.js).
// JS Date.getUTCDay() er 0=sondag .. 6=lordag -> konverter.
function ukedagFraDato(dato) {
  const d = new Date(`${dato}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return (d.getUTCDay() + 6) % 7;
}

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
    // Hent aktivitetens pris + kapasitet (fallback for slot-kapasitet)
    const akt = await db.one(
      'SELECT id, pris, navn, kapasitet, mva_sats FROM activities WHERE id = $1 AND aktiv = true',
      [aktId]
    );
    if (!akt) return res.status(404).json({ error: 'Aktivitet ikke funnet' });

    // --- #3 Kapasitet / overbookingsvern ---
    // 1) Stengt dag? closed_dates har eksakt dato, eller business_hours[ukedag].stengt.
    const stengtDato = await db.one(
      'SELECT dato FROM closed_dates WHERE dato = $1',
      [dato]
    );
    if (stengtDato) {
      return res.status(409).json({ error: 'Vi holder dessverre stengt den valgte datoen.', code: 'stengt', feil: 'stengt' });
    }
    const ukedag = ukedagFraDato(dato);
    if (ukedag !== null) {
      const bh = await db.one(
        'SELECT stengt FROM business_hours WHERE ukedag = $1',
        [ukedag]
      );
      if (bh && bh.stengt) {
        return res.status(409).json({ error: 'Vi holder dessverre stengt den valgte datoen.', code: 'stengt', feil: 'stengt' });
      }
    }

    // 2) Kapasitet + INSERT i ÉN transaksjon slik at to samtidige POST
    //    serialiseres (ingen overbooking-race).
    //    Vi tar SELECT ... FOR UPDATE på activities-raden FØRST. Det er én rad
    //    som alltid finnes for slotten — den fungerer som serialiserings-lås:
    //    en samtidig POST blokkerer på den til vår tx committer/rollbacker.
    //    Deretter leser vi slot-kapasitet (availability-rad ellers activities)
    //    og SUM(antall) med SAMME client, slik at låsen holder hele veien.
    const belop = antallN * akt.pris;
    const brukerId = req.user ? req.user.id : null;

    let fullt = false;
    const booking = await db.withTransaction(async (client) => {
      // Serialiserings-lås: lås activities-raden for denne aktiviteten.
      await client.query('SELECT id FROM activities WHERE id = $1 FOR UPDATE', [aktId]);

      // Slot-kapasitet: availability-rad hvis finnes, ellers activities.kapasitet.
      const { rows: availRows } = await client.query(
        'SELECT kapasitet FROM availability WHERE activity_id = $1 AND dato = $2 AND tid = $3',
        [aktId, dato, tid || null]
      );
      const availRad = availRows[0] || null;
      const kapasitet = availRad ? availRad.kapasitet : akt.kapasitet;

      if (kapasitet != null) {
        const { rows: opptattRows } = await client.query(
          `SELECT COALESCE(SUM(antall),0) AS sum
             FROM bookings
            WHERE activity_id = $1 AND dato = $2
              AND tid IS NOT DISTINCT FROM $3
              AND status IN ('forespurt','bekreftet')`,
          [aktId, dato, tid || null]
        );
        const sum = Number(opptattRows[0] && opptattRows[0].sum) || 0;
        if (sum + antallN > kapasitet) {
          fullt = true;
          return null; // COMMIT av tom tx; låsen slippes
        }
      }

      const { rows: insRows } = await client.query(
        `INSERT INTO bookings
           (activity_id, bruker_id, navn, epost, tlf, dato, tid, antall, status, belop, melding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'forespurt',$9,$10)
         RETURNING *`,
        [aktId, brukerId, navn, epost, tlf || null, dato, tid || null, antallN, belop, melding || null]
      );
      const nyBooking = insRows[0];

      // Speil bookingen som inntektspost i regnskapet — INNE i SAMME tx som
      // booking-INSERT. Atomisitet (A5): booking + regnskapspost committer eller
      // ruller tilbake SAMMEN. Feiler regnskap-INSERT, kastes feilen videre,
      // withTransaction ROLLBACK-er bookingen, og POST svarer 500. Bevisst
      // atferdsendring: ingen booking uten matchende regnskapspost.
      // Idempotens-lookup bevart (samme client), så en re-kjøring ikke dobbelt-
      // poster om bookingen allerede har en regnskapspost.
      const { rows: finnesRows } = await client.query(
        'SELECT id FROM regnskap_poster WHERE booking_id = $1',
        [nyBooking.id]
      );
      if (!finnesRows[0]) {
        // Fase 3: per-aktivitet MVA. Bruk aktivitetens sats (default 25 hvis null).
        const sats = akt.mva_sats != null ? Number(akt.mva_sats) : 25;
        const { netto_ore, mva_ore, brutto_ore, mva_sats } = mvaSplitt(nyBooking.belop * 100, sats);
        // Fiken MVA-kode: 3=salg 25%, 0=uten avgift. Annet -> behold 3 (salg).
        const mvaKode = mva_sats === 0 ? 0 : 3;
        await client.query(
          `INSERT INTO regnskap_poster
             (type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
              netto_ore, mva_ore, brutto_ore, betalingsmetode, kilde, booking_id)
           VALUES ('inntekt',$1,$2,$3,3000,$4,$5,$6,$7,$8,NULL,'booking',$9)`,
          [
            nyBooking.dato,
            nyBooking.navn,
            `${akt.navn} (${nyBooking.antall} pers)`,
            mvaKode,
            mva_sats,
            netto_ore,
            mva_ore,
            brutto_ore,
            nyBooking.id,
          ]
        );
      }

      return nyBooking;
    });

    if (fullt) {
      return res.status(409).json({ error: 'Beklager, det er dessverre fullt paa valgt tidspunkt.', code: 'fullt', feil: 'fullt' });
    }

    // Varsle Discord (#general) — fire-and-forget, stopper aldri bookingen
    discord.bookingVarsel(booking, akt.navn);

    // Kvittering til kunden: "vi har mottatt bookingen din" + .ics-vedlegg.
    // Fire-and-forget ETTER commit (booking er garantert lagret her) - e-post-
    // feil skal ALDRI velte bookingen (samme monster som sendStatusEpost).
    email.sendBookingMottatt(booking.epost, booking.navn, booking, akt.navn);

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
    // 'agent' (service-token, brain) leser som ansatt/admin: hele lista.
    const erAnsatt =
      req.user.rolle === 'ansatt' || req.user.rolle === 'admin' || req.user.rolle === 'agent';
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

// #5 Agenda / dagsvisning (kun ansatt/admin) — fremtidige bookinger, sortert.
router.get('/agenda', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const { dato } = req.query || {};
  try {
    const { rows } = await db.query(
      `SELECT b.*, a.navn AS aktivitet_navn
         FROM bookings b
         LEFT JOIN activities a ON a.id = b.activity_id
        WHERE b.dato >= COALESCE($1::date, CURRENT_DATE)
        ORDER BY b.dato, b.tid NULLS LAST`,
      [dato || null]
    );
    res.json(rows);
  } catch (e) {
    console.error('bookings GET /agenda feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente agenda' });
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

    // #6 Kundevarsel ved statusendring — in-app + e-post, fire-and-forget.
    // Hverken meldingsraden eller e-posten skal velte statusoppdateringen.
    try {
      if (booking.bruker_id != null) {
        await db.query(
          `INSERT INTO customer_messages (bruker_id, avsender, tekst, lest)
           VALUES ($1, 'admin', $2, false)`,
          [booking.bruker_id, `Bookingen din er nå: ${status}.`]
        );
      }
    } catch (msgFeil) {
      console.error('bookings: kunne ikke lagre kundemelding:', msgFeil.message);
    }
    // E-post (kaster aldri — lib/email er fire-and-forget).
    email.sendStatusEpost(
      booking.epost,
      booking.navn,
      { id: booking.id, dato: booking.dato, tid: booking.tid },
      status
    );

    res.json({ booking });
  } catch (e) {
    console.error('bookings PATCH /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere booking' });
  }
});

// Fase 3 — Refusjon (kun ansatt/admin): merk booking refundert + reverserende
// (negativ) regnskapspost. Pengelogikk speiler den opprinnelige inntektsposten.
router.post('/:id/refusjon', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  const { belop_ore, grunn } = req.body || {};

  try {
    const booking = await db.one('SELECT * FROM bookings WHERE id = $1', [id]);
    if (!booking) return res.status(404).json({ error: 'Booking ikke funnet' });

    // Refusjonsbeløp i øre: oppgitt beløp, ellers hele booking-beløpet.
    const fullt = Math.round((booking.belop || 0) * 100);
    let refundOre = belop_ore != null ? Math.round(Number(belop_ore)) : fullt;
    if (!Number.isFinite(refundOre) || refundOre <= 0) {
      return res.status(400).json({ error: 'Ugyldig refusjonsbeløp' });
    }
    if (refundOre > fullt) refundOre = fullt;

    const oppdatert = await db.one(
      `UPDATE bookings
          SET refund_amount_ore = $1, refund_reason = $2, refunded_at = now()
        WHERE id = $3
        RETURNING *`,
      [refundOre, grunn || null, id]
    );

    // Reverserende (negativ) regnskapspost — speil aktivitetens MVA-sats.
    try {
      const akt = await db.one(
        'SELECT navn, mva_sats FROM activities WHERE id = $1',
        [booking.activity_id]
      );
      const sats = akt && akt.mva_sats != null ? Number(akt.mva_sats) : 25;
      const { netto_ore, mva_ore, brutto_ore, mva_sats } = mvaSplitt(refundOre, sats);
      const mvaKode = mva_sats === 0 ? 0 : 3;
      await db.query(
        `INSERT INTO regnskap_poster
           (type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
            netto_ore, mva_ore, brutto_ore, betalingsmetode, kilde, booking_id)
         VALUES ('inntekt',CURRENT_DATE,$1,$2,3000,$3,$4,$5,$6,$7,NULL,'booking',$8)`,
        [
          booking.navn,
          `Refusjon: ${(akt && akt.navn) || 'booking'}${grunn ? ` (${grunn})` : ''}`,
          mvaKode,
          mva_sats,
          -netto_ore,
          -mva_ore,
          -brutto_ore,
          id,
        ]
      );
    } catch (regnskapFeil) {
      console.error('bookings: kunne ikke lagre refusjonspost:', regnskapFeil.message);
    }

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(req.user, 'refusjon', {
      booking_id: id,
      refund_amount_ore: refundOre,
      grunn: grunn || null,
    });

    res.json({ booking: oppdatert });
  } catch (e) {
    console.error('bookings POST /:id/refusjon feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke refundere booking' });
  }
});

module.exports = router;
