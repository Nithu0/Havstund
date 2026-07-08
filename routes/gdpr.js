/* Havstund — GDPR (/api/gdpr). Kun admin.
   GET  /export/:customerId    -> all PII for en kunde (join users + relaterte tabeller)
   POST /anonymize/:customerId -> sett users.anonymized_at + nullstill direkte PII
                                  (navn/epost/tlf) i users og bookings, men behold
                                  aggregat (belop/antall/status/datoer for regnskap). */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

// Felles 503 nar databasen ikke er konfigurert.
function dbUtilgjengelig(res) {
  return res.status(503).json({ error: 'Database ikke tilgjengelig' });
}

// Parser :customerId til positivt heltall, ellers null.
function parseId(v) {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---- GET /export/:customerId : all PII for kunden (GDPR innsynsrett) ----
router.get('/export/:customerId', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) return dbUtilgjengelig(res);

  const id = parseId(req.params.customerId);
  if (id == null) return res.status(400).json({ error: 'Ugyldig kunde-id.' });

  try {
    const bruker = await db.one(
      `SELECT id, navn, epost, rolle, opprettet, anonymized_at
         FROM users WHERE id=$1`,
      [id],
    );
    if (!bruker) return res.status(404).json({ error: 'Fant ikke kunden.' });

    // Relaterte PII-baerende tabeller. bruker_id-kobling pa alle.
    const [bookings, chatThreads, customerMessages, receipts, projects] = await Promise.all([
      db.query(
        `SELECT b.id, b.dato, b.tid, a.navn AS aktivitet, b.navn, b.epost, b.tlf,
                b.antall, b.belop, b.status, b.melding, b.opprettet
           FROM bookings b
           LEFT JOIN activities a ON a.id = b.activity_id
          WHERE b.bruker_id=$1
          ORDER BY b.opprettet DESC`,
        [id],
      ),
      db.query(
        `SELECT id, navn, epost, status, opprettet, sist
           FROM chat_threads WHERE bruker_id=$1 ORDER BY opprettet DESC`,
        [id],
      ),
      db.query(
        `SELECT id, avsender, tekst, pris, lest, opprettet
           FROM customer_messages WHERE bruker_id=$1 ORDER BY opprettet DESC`,
        [id],
      ),
      db.query(
        `SELECT id, booking_id, belop, beskrivelse, betalt, dato, opprettet
           FROM receipts WHERE bruker_id=$1 ORDER BY opprettet DESC`,
        [id],
      ),
      db.query(
        `SELECT id, tittel, type, status, beskrivelse, opprettet, oppdatert
           FROM projects WHERE bruker_id=$1 ORDER BY opprettet DESC`,
        [id],
      ),
    ]);

    return res.json({
      bruker,
      bookings: bookings.rows,
      chatThreads: chatThreads.rows,
      customerMessages: customerMessages.rows,
      receipts: receipts.rows,
      projects: projects.rows,
    });
  } catch (e) {
    console.error('gdpr GET /export feilet:', e.message);
    return res.status(500).json({ error: 'Kunne ikke hente kundedata.' });
  }
});

// ---- POST /anonymize/:customerId : GDPR sletteplikt (anonymisering) ----
// Beholder aggregat (belop/antall/status/datoer) for regnskap, men fjerner
// direkte personidentifiserende felt og setter anonymized_at som markor.
router.post('/anonymize/:customerId', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) return dbUtilgjengelig(res);

  const id = parseId(req.params.customerId);
  if (id == null) return res.status(400).json({ error: 'Ugyldig kunde-id.' });

  try {
    const bruker = await db.one('SELECT id, anonymized_at FROM users WHERE id=$1', [id]);
    if (!bruker) return res.status(404).json({ error: 'Fant ikke kunden.' });
    if (bruker.anonymized_at) {
      return res.status(409).json({ error: 'Kunden er allerede anonymisert.' });
    }

    // Alt-eller-ingenting: users + bookings + chat_threads anonymiseres i EN
    // transaksjon, saa anonymized_at kun settes hvis ALL PII-nullstilling ogsaa
    // lykkes. Ved feil rulles alt tilbake -> ingen delvis anonymisering, og
    // 409-vakten (linje 98-100) stenger dermed ikke en retry ute med PII liggende.
    await db.withTransaction(async (client) => {
      // users: nullstill direkte PII, men behold raden (FK-er + aggregat intakt).
      // (users har ikke tlf-kolonne; tlf bor kun pa bookings.)
      // epost ma forbli unik -> erstatt med determ. placeholder pr. id.
      await client.query(
        `UPDATE users
            SET navn='[slettet]',
                epost='slettet+' || id || '@anonymisert.havstund',
                anonymized_at=now()
          WHERE id=$1`,
        [id],
      );

      // bookings holder egne kopier av navn/epost/tlf -> nullstill, behold aggregat.
      await client.query(
        `UPDATE bookings
            SET navn='[slettet]', epost='[slettet]', tlf=NULL, melding=NULL
          WHERE bruker_id=$1`,
        [id],
      );

      // chat_threads har ogsaa navn + epost (direkte PII, schema.sql:49-57) ->
      // nullstill i samme tx saa sletteplikten faktisk oppfylles.
      await client.query(
        `UPDATE chat_threads
            SET navn='[slettet]', epost=NULL
          WHERE bruker_id=$1`,
        [id],
      );
    });

    // Revisjonsspor — fire-and-forget (writeAudit kaster aldri).
    await writeAudit(req.user, 'gdpr:anonymisert', { customerId: id });

    return res.json({ ok: true, anonymized: id });
  } catch (e) {
    console.error('gdpr POST /anonymize feilet:', e.message);
    return res.status(500).json({ error: 'Kunne ikke anonymisere kunden.' });
  }
});

module.exports = router;
