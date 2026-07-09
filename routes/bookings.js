/* Havstund — bookinger (/api/bookings).
   POST /        -> opprett booking (gjest eller innlogget)
   GET  /        -> ansatt/admin: alle; kunde: egne; ellers 401
   PATCH /:id    -> kun ansatt/admin: oppdater status */
const crypto = require('crypto');
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const { mvaSplitt } = require('../lib/regnskap');
const discord = require('../lib/discord');
const email = require('../lib/email');
const { writeAudit } = require('../lib/audit');
const { logger } = require('../lib/logger');

const router = express.Router();

// 'ingen_oppmoete' (S3): kunde som ikke moette opp. Distinkt fra 'avlyst' slik at
// eieren kan male no-show-rate. Utloser INGEN pengehandling — kun status.
const GYLDIG_STATUS = ['forespurt', 'bekreftet', 'avlyst', 'fullfort', 'ingen_oppmoete'];

// F11: samme e-post-monster som routes/auth.js + routes/staff.js (ikke et nytt).
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

// Fase 4 PII: refusjons-`grunn` er fritekst fra en ansatt/admin. Den skal IKKE
// kunne baere kunde-PII (navn/e-post/telefon) inn i regnskaps-/bilagslaget.
// Heuristisk sanitering: fjern e-postadresser og telefon-lignende sifferrekker,
// kollaps whitespace, kapp lengde. Ikke vanntett anonymisering (en ansatt KAN
// skrive et navn som fri tekst), men lukker de maskin-gjenkjennelige lekkasjene.
// Returnerer null for tom/ugyldig input (kolonnen er NULLABLE).
function saniterGrunn(grunn) {
  if (grunn == null) return null;
  let s = String(grunn);
  s = s.replace(/\S+@\S+\.\S+/g, '[fjernet]');            // e-post
  s = s.replace(/\+?\d[\d\s().-]{6,}\d/g, '[fjernet]');   // telefon-lignende
  s = s.replace(/\s+/g, ' ').trim().slice(0, 200);
  return s.length ? s : null;
}

// Unik, ugjettbar gavekort-kode. UNIQUE-constrainten paa gavekort.kode er
// database-backstop mot den (usannsynlige) kollisjonen.
function lagGavekortKode() {
  return 'HAV-GK-' + crypto.randomBytes(6).toString('hex').toUpperCase();
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

    // Sanntidsvarsel til ansatte: en INNHOLDSLOS ping ('ny_booking', ingen
    // payload/PII) til det ansatt-only rommet. Admin-agendaen lytter og
    // re-henter /api/bookings/agenda (authed) — sa selve booking-dataene
    // aldri gaar over den udifferensierte socket-kanalen. Fire-and-forget:
    // en feil her skal ALDRI velte bookingen (samme monster som discord/e-post).
    try {
      const io = req.app && req.app.get && req.app.get('io');
      if (io) io.to('ansatte').emit('ny_booking');
    } catch (varselFeil) {
      console.error('bookings: ny_booking-ping feilet:', varselFeil.message);
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
    // F26: e-posten kaster aldri (lib/email er fire-and-forget), men en feilet
    // utsending returnerer { ok:false, ... }. Uten await forsvant den sporlost.
    // Vi await-er og logger ved ok===false — men en e-postfeil skal ALDRI velte
    // statusendringen (status er allerede committet over).
    const epostRes = await email.sendStatusEpost(
      booking.epost,
      booking.navn,
      { id: booking.id, dato: booking.dato, tid: booking.tid },
      status
    );
    if (epostRes && epostRes.ok === false) {
      logger.warn(
        { bookingId: booking.id, grunn: epostRes.error || epostRes.grunn || 'ukjent' },
        'bookings: status-e-post ikke sendt'
      );
    }

    res.json({ booking });
  } catch (e) {
    console.error('bookings PATCH /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere booking' });
  }
});

// Fase 4 — Refusjon (kun ansatt/admin). Tar N delrefusjoner per booking.
//
// Hele operasjonen kjorer i ÉN transaksjon (db.withTransaction), med
// SELECT ... FOR UPDATE paa bookingen som serialiserings-laas. Det gir:
//   - Summerings-invarianten Σ(refusjoner) + ny ≤ opprinnelig brutto haandhevet
//     atomisk: to samtidige delrefusjoner kan ikke begge lese en utdatert sum og
//     begge passere — den andre blokkerer til den forste committer.
//   - Idempotens: idempotens_nokkel (fra body/`Idempotency-Key`) forhaandssjekkes
//     OG er UNIQUE i DB (backstop mot dobbelklikk/retry i en race).
//   - Atomisitet: refusjons-rad + evt. gavekort + lokal reverserende
//     regnskapspost + booking-oppdatering committer eller ruller tilbake SAMMEN.
//
// Fiken: den GATEDE delete+repost-flyten (versjonert saleNumber + deleted-filter)
// er bygget som adapter-primitiver i lib/fiken.js (reverserSalg/finnAktivtSalg,
// begge bak isConfigured()), men BEVISST IKKE koblet inn i denne money-ruten enda
// — den kan ikke live-verifiseres uten et Fiken test-firma-token, og skal ikke
// legge uverifisert atferd paa penge-pathen for operatoren kobler Fiken. Lokal
// regnskaps-speiling (negativ post) beholdes uendret i mellomtiden.
router.post('/:id/refusjon', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  const { belop_ore, grunn, gavekort } = req.body || {};
  const somGavekort = gavekort === true || gavekort === 'true';
  const grunnRen = saniterGrunn(grunn);
  const idem =
    (req.body && req.body.idempotens_nokkel) || req.get('Idempotency-Key') || null;

  try {
    const utfall = await db.withTransaction(async (client) => {
      // Laas bookingen for hele operasjonen (serialiserer samtidige refusjoner).
      const { rows: bRows } = await client.query(
        'SELECT * FROM bookings WHERE id = $1 FOR UPDATE',
        [id]
      );
      const booking = bRows[0];
      if (!booking) return { status: 404, body: { error: 'Booking ikke funnet' } };

      // Idempotens-forhaandssjekk: samme noekkel = samme hendelse -> ingen ny rad.
      if (idem) {
        const { rows: dupRows } = await client.query(
          'SELECT id FROM refusjoner WHERE idempotens_nokkel = $1',
          [idem]
        );
        if (dupRows[0]) {
          return {
            status: 200,
            body: { booking, refusjon_id: dupRows[0].id, duplikat: true },
          };
        }
      }

      const fullt = Math.round((booking.belop || 0) * 100);
      const { rows: sumRows } = await client.query(
        'SELECT COALESCE(SUM(belop_ore),0)::bigint AS sum FROM refusjoner WHERE booking_id = $1',
        [id]
      );
      const alleredeRefundert = Number(sumRows[0] && sumRows[0].sum) || 0;
      const gjenstaende = fullt - alleredeRefundert;

      // Belop: oppgitt, ellers hele det gjenstaende.
      let refundOre = belop_ore != null ? Math.round(Number(belop_ore)) : gjenstaende;
      if (!Number.isFinite(refundOre) || refundOre <= 0) {
        return { status: 400, body: { error: 'Ugyldig refusjonsbeløp' } };
      }
      // Invariant: Σ refusjoner + ny ≤ opprinnelig brutto.
      if (refundOre > gjenstaende) {
        return {
          status: 409,
          body: {
            error: 'Refusjonsbeløpet overstiger gjenstående refunderbart beløp.',
            code: 'refusjon_overstiger',
            feil: 'refusjon_overstiger',
            gjenstaende_ore: gjenstaende,
          },
        };
      }

      // Gavekort valgt: utsted i SAMME tx (verdi = refusjonsbelopet). Regnskaps-
      // messig er et gavekort en FORPLIKTELSE (gjeld) ved utstedelse og INNTEKT
      // ved innloesning. Konkret gjeldskonto + MVA-tidspunkt avklares med
      // regnskapsfoerer (docs/proposals/2026-07-09_fase4-...), saa vi POSTERER
      // IKKE en uverifisert gjeldskonto her enda — vi registrerer forpliktelsen i
      // gavekort-tabellen. Den lokale reverserende inntektsposten under staar
      // uansett (inntekten reverseres); gjeldsspeilingen er et aapent punkt.
      let gavekortId = null;
      let gavekortKode = null;
      if (somGavekort) {
        gavekortKode = lagGavekortKode();
        const { rows: gkRows } = await client.query(
          `INSERT INTO gavekort (kode, verdi_ore, utstedt_for_refusjon_av)
           VALUES ($1,$2,$3) RETURNING id`,
          [gavekortKode, refundOre, `booking:${id}`]
        );
        gavekortId = gkRows[0] && gkRows[0].id;
      }

      // Refusjons-raden. UNIQUE(idempotens_nokkel) er backstop mot en race der to
      // like forespoersler passerte forhaandssjekken; da kaster INSERT -> hele tx
      // ROLLBACK-er (inkl. gavekortet over) -> 500. Sjelden, men trygt.
      const { rows: rRows } = await client.query(
        `INSERT INTO refusjoner
           (booking_id, belop_ore, grunn, gavekort, gavekort_id, idempotens_nokkel, opprettet_av)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [
          id,
          refundOre,
          grunnRen,
          somGavekort,
          gavekortId,
          idem,
          req.user ? req.user.navn || String(req.user.id) : null,
        ]
      );
      const refusjonId = rRows[0] && rRows[0].id;

      // Lokal reverserende (negativ) regnskapspost — speiler aktivitetens MVA.
      // Beholdt for bakoverkompat (regnskapspakke leser refusjon som negativ
      // regnskap_poster). beskrivelse er PII-fri: sanitert grunn, ingen kunde-
      // navn i fritekst.
      const { rows: aktRows } = await client.query(
        'SELECT navn, mva_sats FROM activities WHERE id = $1',
        [booking.activity_id]
      );
      const akt = aktRows[0] || null;
      const sats = akt && akt.mva_sats != null ? Number(akt.mva_sats) : 25;
      const { netto_ore, mva_ore, brutto_ore, mva_sats } = mvaSplitt(refundOre, sats);
      const mvaKode = mva_sats === 0 ? 0 : 3;
      const beskr =
        `Refusjon: ${(akt && akt.navn) || 'booking'}` +
        (grunnRen ? ` (${grunnRen})` : '') +
        (somGavekort ? ' [gavekort]' : '');
      await client.query(
        `INSERT INTO regnskap_poster
           (type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
            netto_ore, mva_ore, brutto_ore, betalingsmetode, kilde, booking_id)
         VALUES ('inntekt',CURRENT_DATE,$1,$2,3000,$3,$4,$5,$6,$7,NULL,'booking',$8)`,
        [booking.navn, beskr, mvaKode, mva_sats, -netto_ore, -mva_ore, -brutto_ore, id]
      );

      // Booking-feltet beholdt for bakoverkompat: KUMULATIV sum (ikke lenger
      // kilden til sannhet — det er SUM(refusjoner)). refund_reason = sanitert.
      const nyttTotal = alleredeRefundert + refundOre;
      const { rows: oppdRows } = await client.query(
        `UPDATE bookings
            SET refund_amount_ore = $1, refund_reason = $2, refunded_at = now()
          WHERE id = $3
          RETURNING *`,
        [nyttTotal, grunnRen, id]
      );

      return {
        status: 200,
        body: {
          booking: oppdRows[0],
          refusjon: {
            id: refusjonId,
            belop_ore: refundOre,
            gjenstaende_ore: gjenstaende - refundOre,
          },
          gavekort: gavekortKode ? { kode: gavekortKode, verdi_ore: refundOre } : null,
        },
      };
    });

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri). Kun for faktiske
    // refusjoner (ikke 4xx-utfall).
    if (utfall.status === 200 && !utfall.body.duplikat) {
      await writeAudit(req.user, 'refusjon', {
        booking_id: id,
        refund_amount_ore: utfall.body.refusjon ? utfall.body.refusjon.belop_ore : null,
        gavekort: somGavekort,
        grunn: grunnRen,
      });
    }

    return res.status(utfall.status).json(utfall.body);
  } catch (e) {
    console.error('bookings POST /:id/refusjon feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke refundere booking' });
  }
});

module.exports = router;
