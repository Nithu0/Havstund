/* Havstund — tilgjengelighet / slots (/api/availability).
   Tabell `availability`: id, activity_id (FK activities ON DELETE CASCADE),
   dato (DATE), tid (TEXT), kapasitet (INTEGER, default 8).

   GET  /                 -> list slots (offentlig). Valgfrie filtre:
                             ?activity_id=<int>  og/eller  ?dato=YYYY-MM-DD
   PUT  /                 -> erstatt slots for (activity_id, dato)
                             (requireRole('ansatt','admin')).
                             Body: { activity_id, dato, slots: [{ tid, kapasitet }] }
                             Transaksjonelt: sletter eksisterende slots for
                             (activity_id, dato) og setter inn de nye. */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

const FELT = 'id, activity_id, dato, tid, kapasitet';

// Øvre grense på antall slots per PUT (vern mot misbruk / utilsiktet enorme batcher).
const MAX_SLOTS = 500;

// YYYY-MM-DD (enkel form-validering; Postgres gjor den endelige date-castingen).
const DATO_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parser et heltall >= 0. Godtar tall eller numerisk streng. Ellers null.
function heltallIkkeNegativ(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// Validerer + normaliserer PUT-kroppen.
// Returnerer { ok:true, data:{ activity_id, dato, slots } } eller { ok:false, feil }.
function validerPut(body) {
  const b = body || {};

  const activity_id = heltallIkkeNegativ(b.activity_id);
  if (activity_id === null) {
    return { ok: false, feil: 'activity_id må være et heltall ≥ 0' };
  }

  const dato = typeof b.dato === 'string' ? b.dato.trim() : '';
  if (!DATO_RE.test(dato)) {
    return { ok: false, feil: 'dato må være på formen YYYY-MM-DD' };
  }

  if (!Array.isArray(b.slots)) {
    return { ok: false, feil: 'slots må være en liste' };
  }
  if (b.slots.length > MAX_SLOTS) {
    return { ok: false, feil: `for mange slots (maks ${MAX_SLOTS})` };
  }

  const slots = [];
  for (const s of b.slots) {
    const rad = s || {};
    const tid = typeof rad.tid === 'string' ? rad.tid.trim() : '';
    if (!tid) return { ok: false, feil: 'hver slot må ha en ikke-tom tid' };
    if (tid.length > 50) return { ok: false, feil: 'tid er for lang (maks 50)' };
    // kapasitet valgfri pr. slot — default 8 (jf. schema).
    const kap = rad.kapasitet === undefined || rad.kapasitet === null
      ? 8
      : heltallIkkeNegativ(rad.kapasitet);
    if (kap === null) return { ok: false, feil: 'kapasitet må være et heltall ≥ 0' };
    slots.push({ tid, kapasitet: kap });
  }

  return { ok: true, data: { activity_id, dato, slots } };
}

// Liste slots (offentlig). Valgfrie filtre activity_id + dato.
router.get('/', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }

  const filtre = [];
  const params = [];

  if (req.query.activity_id !== undefined) {
    const aid = heltallIkkeNegativ(req.query.activity_id);
    if (aid === null) {
      return res.status(400).json({ error: 'activity_id må være et heltall ≥ 0' });
    }
    params.push(aid);
    filtre.push(`activity_id = $${params.length}`);
  }

  if (req.query.dato !== undefined) {
    const dato = String(req.query.dato).trim();
    if (!DATO_RE.test(dato)) {
      return res.status(400).json({ error: 'dato må være på formen YYYY-MM-DD' });
    }
    params.push(dato);
    filtre.push(`dato = $${params.length}`);
  }

  const where = filtre.length ? `WHERE ${filtre.join(' AND ')}` : '';
  try {
    const { rows } = await db.query(
      `SELECT ${FELT} FROM availability ${where} ORDER BY dato, tid, id`,
      params
    );
    res.json(rows);
  } catch (e) {
    console.error('availability GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente tilgjengelighet' });
  }
});

// Erstatt slots for (activity_id, dato). Kun ansatt/admin.
router.put('/', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const v = validerPut(req.body);
  if (!v.ok) return res.status(400).json({ error: v.feil });
  const { activity_id, dato, slots } = v.data;

  try {
    // Slett-og-sett for (activity_id, dato) slik at PUT er idempotent.
    // Pakket i én transaksjon: DELETE + alle INSERT er atomisk
    // (alt-eller-ingenting). En feilende INSERT ruller DELETE tilbake.
    const rader = await db.withTransaction(async (client) => {
      await client.query(
        'DELETE FROM availability WHERE activity_id = $1 AND dato = $2',
        [activity_id, dato]
      );

      const ut = [];
      for (const s of slots) {
        const { rows } = await client.query(
          `INSERT INTO availability (activity_id, dato, tid, kapasitet)
           VALUES ($1, $2, $3, $4)
           RETURNING ${FELT}`,
          [activity_id, dato, s.tid, s.kapasitet]
        );
        ut.push(rows[0]);
      }
      return ut;
    });

    res.json(rader);
  } catch (e) {
    // FK-brudd: ukjent activity_id.
    if (e.code === '23503') {
      return res.status(400).json({ error: 'ukjent activity_id' });
    }
    console.error('availability PUT / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre tilgjengelighet' });
  }
});

module.exports = router;
