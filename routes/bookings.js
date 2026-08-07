/* Havstund — bookinger (/api/bookings).
   POST / -> opprett booking fra forsidens skjema. Eneste endepunkt.

   Forenklet 2026-08-07 (operator: "kun forsiden"). Fjernet herfra:
     - GET / og GET /agenda      (admin-lister — sidene finnes ikke lenger)
     - PATCH /:id, POST /:id/refusjon (statusstyring + refusjon = admin)
     - speiling til regnskap_poster   (regnskapsdelen er droppet)
     - gjestekonto + magisk innloggingslenke (kundesiden finnes ikke lenger,
       så lenken pekte ingensteds)
   BEHOLDT bevisst: validering, stengt-dag-sjekk og kapasitets-/overbookingsvernet
   med transaksjonslås — det beskytter forsidens booking og er ikke admin-logikk.

   Bookingen varsles til Discord, som er bakrommet. */
const express = require('express');
const db = require('../db');
const discord = require('../lib/discord');
const email = require('../lib/email');

const router = express.Router();

// F11: samme e-post-monster som resten av kodebasen (ikke et nytt).
const EPOST_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Dato maa vaere ISO ÅÅÅÅ-MM-DD (DATE-kolonnen) og en reell dato.
const DATO_RE = /^\d{4}-\d{2}-\d{2}$/;
// Lengdegrenser slik at feltene ikke gaar ubegrenset i DB.
const MAKS = { navn: 200, tlf: 40, melding: 4000 };

// F11: valideringsfeil bruker samme superset-svarform {error,code,feil} som
// 409-ene (PR #30) fordi klienten leser ulike nokler — sa 400 ikke brekker frontend.
function valideringsfeil(res, melding) {
  return res.status(400).json({ error: melding, code: 'validering', feil: 'validering' });
}

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

  // F11: lengdegrenser + format FOR feltene treffer DB.
  if (typeof navn !== 'string' || navn.length > MAKS.navn) {
    return valideringsfeil(res, `Navnet er for langt (maks ${MAKS.navn} tegn).`);
  }
  if (tlf != null && String(tlf).length > MAKS.tlf) {
    return valideringsfeil(res, `Telefonnummeret er for langt (maks ${MAKS.tlf} tegn).`);
  }
  if (melding != null && String(melding).length > MAKS.melding) {
    return valideringsfeil(res, `Meldingen er for lang (maks ${MAKS.melding} tegn).`);
  }
  if (typeof epost !== 'string' || !EPOST_RE.test(epost)) {
    return valideringsfeil(res, 'Ugyldig e-postadresse.');
  }
  // Round-trip: JS Date ruller f.eks. 2026-02-30 over til mars i stedet for NaN,
  // sa vi sammenligner den normaliserte UTC-datoen mot input for aa fange
  // format-gyldige-men-ureelle datoer.
  const datoObj = typeof dato === 'string' && DATO_RE.test(dato)
    ? new Date(`${dato}T00:00:00Z`)
    : null;
  if (!datoObj || Number.isNaN(datoObj.getTime()) ||
      datoObj.toISOString().slice(0, 10) !== dato) {
    return valideringsfeil(res, 'Ugyldig dato — bruk formatet ÅÅÅÅ-MM-DD.');
  }

  try {
    // Hent aktivitetens pris + kapasitet (fallback for slot-kapasitet)
    const akt = await db.one(
      'SELECT id, pris, navn, kapasitet FROM activities WHERE id = $1 AND aktiv = true',
      [aktId]
    );
    if (!akt) return res.status(404).json({ error: 'Aktivitet ikke funnet' });

    // --- Kapasitet / overbookingsvern ---
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
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,'forespurt',$8,$9)
         RETURNING *`,
        [aktId, navn, epost, tlf || null, dato, tid || null, antallN, belop, melding || null]
      );
      return insRows[0];
    });

    if (fullt) {
      return res.status(409).json({ error: 'Beklager, det er dessverre fullt paa valgt tidspunkt.', code: 'fullt', feil: 'fullt' });
    }

    // Varsle Discord (#general) — fire-and-forget, stopper aldri bookingen.
    // Discord ER bakrommet nå som admin-sidene er borte.
    discord.bookingVarsel(booking, akt.navn);

    // Kvittering til kunden: "vi har mottatt bookingen din" + .ics-vedlegg.
    // Fire-and-forget ETTER commit (booking er garantert lagret her) — e-post-
    // feil skal ALDRI velte bookingen.
    email.sendBookingMottatt(booking.epost, booking.navn, booking, akt.navn);

    res.status(201).json({ booking });
  } catch (e) {
    console.error('bookings POST / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke opprette booking' });
  }
});

module.exports = router;
