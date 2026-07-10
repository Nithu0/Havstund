/* Havstund — ansatt<->admin intern chat, ADMIN-siden (/api/personalchat).
   Bolge 98-justering. Motsatsen til ansatt-siden i routes/min.js (GET/POST
   /api/min/meldinger, egen traad). Her ser og svarer ADMIN alle ansattes traader.

   ADMIN-ONLY: router.use(requireRole('admin')). En ansatt naar ALDRI hit -> 403
   (i motsetning til /api/min, som er 'ansatt','admin'). Speiler blocker-2-skillet:
   ansatt ser bare sitt eget, admin ser alt.

   avsender settes ALLTID server-side ('admin' her) — ALDRI fra klient. ansatt_id
   for en traad tas fra URL-parameteret (:ansattId) og valideres mot ansatte-tabellen
   for POST, ikke fra body.

   GET  /            -> traad-oversikt: alle ansatte m/ antall uleste + siste melding.
   GET  /:ansattId   -> full traad for en ansatt; markerer ansattes meldinger lest.
   POST /:ansattId   -> admin svarer {tekst}; avsender='admin'. */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const { writeAudit } = require('../lib/audit');

const router = express.Router();

// Admin-only. En ansatt/kunde/agent avvises med 403 FOER noen handler kjorer.
router.use(requireRole('admin'));

const MELDING_MAX = 4000;

function utilgjengelig(res) {
  return res.status(503).json({ error: 'Personalchat er midlertidig utilgjengelig.' });
}

// Validerer :ansattId som positivt heltall. Returnerer tallet eller null.
function gyldigAnsattId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ---------- GET / (traad-oversikt: uleste + siste melding per ansatt) ----------
// Speiler meldinger.js GET /kunder. Lister ALLE ansatte (ogsaa de uten meldinger
// enda), nyeste aktivitet forst. `uleste` teller ANSATTES ulesteste meldinger —
// det admin ikke har svart paa. Ingen lonn her; kun navn/stilling + tellere.
router.get('/', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  try {
    const { rows } = await db.query(
      `SELECT a.id AS ansatt_id, a.navn, a.stilling,
              m.tekst     AS siste_tekst,
              m.avsender  AS siste_avsender,
              m.opprettet AS siste_tid,
              COALESCE(c.uleste, 0) AS uleste
         FROM ansatte a
         LEFT JOIN LATERAL (
           SELECT tekst, avsender, opprettet
             FROM personal_meldinger
            WHERE ansatt_id = a.id
            ORDER BY opprettet DESC, id DESC
            LIMIT 1
         ) m ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS uleste
             FROM personal_meldinger
            WHERE ansatt_id = a.id AND avsender = 'ansatt' AND lest = false
         ) c ON true
        ORDER BY (m.opprettet IS NULL), m.opprettet DESC, a.navn ASC`,
      []
    );
    res.json(rows);
  } catch (e) {
    console.error('personalchat GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente traad-oversikt' });
  }
});

// ---------- GET /:ansattId (full traad; marker ansattes meldinger lest) ----------
router.get('/:ansattId', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const ansattId = gyldigAnsattId(req.params.ansattId);
  if (!ansattId) return res.status(400).json({ error: 'Ugyldig ansatt-id' });
  try {
    const ansatt = await db.one('SELECT id, navn, stilling FROM ansatte WHERE id = $1', [ansattId]);
    if (!ansatt) return res.status(404).json({ error: 'Ansatt ikke funnet' });

    const { rows } = await db.query(
      `SELECT id, ansatt_id, avsender, tekst, lest, opprettet
         FROM personal_meldinger
        WHERE ansatt_id = $1
        ORDER BY opprettet ASC, id ASC`,
      [ansattId]
    );
    // Admin aapner traaden -> ansattes meldinger er naa lest.
    await db.query(
      "UPDATE personal_meldinger SET lest = true WHERE ansatt_id = $1 AND avsender = 'ansatt' AND lest = false",
      [ansattId]
    );
    res.json({ ansatt, meldinger: rows });
  } catch (e) {
    console.error('personalchat GET /:ansattId feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente traad' });
  }
});

// ---------- POST /:ansattId {tekst} (admin svarer; avsender='admin') ----------
// avsender bindes til konstanten 'admin' — ALDRI fra body. ansatt_id tas fra URL
// og valideres mot ansatte-tabellen (404 hvis ukjent), ikke fra body.
router.post('/:ansattId', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const ansattId = gyldigAnsattId(req.params.ansattId);
  if (!ansattId) return res.status(400).json({ error: 'Ugyldig ansatt-id' });
  const tekst = String((req.body && req.body.tekst) || '').trim();
  if (!tekst) return res.status(400).json({ error: 'Melding kan ikke vaere tom' });
  if (tekst.length > MELDING_MAX) return res.status(400).json({ error: 'Meldingen er for lang' });
  try {
    const ansatt = await db.one('SELECT id FROM ansatte WHERE id = $1', [ansattId]);
    if (!ansatt) return res.status(404).json({ error: 'Ansatt ikke funnet' });

    const melding = await db.one(
      `INSERT INTO personal_meldinger (ansatt_id, avsender, tekst, lest)
       VALUES ($1, 'admin', $2, false)
       RETURNING id, ansatt_id, avsender, tekst, lest, opprettet`,
      [ansattId, tekst]
    );
    // Fire-and-forget revisjonsspor (ikke penge-handling, men sporbar admin-handling).
    writeAudit(req.user, 'personalchat.svar', { ansatt_id: ansattId, melding_id: melding.id });
    res.status(201).json({ melding });
  } catch (e) {
    console.error('personalchat POST /:ansattId feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke sende melding' });
  }
});

module.exports = router;
