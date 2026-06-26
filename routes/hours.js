/* Havstund — apningstider (/api/hours).
   business_hours: fast ukentlig apningstid (ukedag 0=mandag .. 6=sondag).
   closed_dates:   enkeltdatoer som overstyrer (helligdager, ferie).

   GET  /            -> { hours:[...7 rader], closed:[...kommende] }  (offentlig)
   PUT  /:ukedag     -> sett apner/stenger/stengt for en ukedag        (requireRole)
   POST /closed      -> { dato, grunn }  legg til/oppdater stengt dato  (requireRole)
   DELETE /closed/:dato -> fjern stengt dato                            (requireRole) */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

// HH:MM eller HH:MM:SS (00-23 : 00-59 [: 00-59]).
const TID = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
// YYYY-MM-DD.
const DATO = /^\d{4}-\d{2}-\d{2}$/;

// Parser ukedag fra rute-param. 0..6 -> tall, ellers null.
function parseUkedag(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 6) return null;
  return n;
}

// Validerer en valgfri TIME-verdi. Returnerer { ok, val } der val er null naar tom.
function parseTid(v) {
  if (v === undefined || v === null || v === '') return { ok: true, val: null };
  if (typeof v !== 'string' || !TID.test(v.trim())) return { ok: false };
  return { ok: true, val: v.trim() };
}

// Offentlig: hele uka + kommende stengte datoer (fra og med i dag).
router.get('/', async (_req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  try {
    const hours = await db.query(
      `SELECT ukedag, apner, stenger, stengt
         FROM business_hours
        ORDER BY ukedag`,
      []
    );
    const closed = await db.query(
      `SELECT dato, grunn
         FROM closed_dates
        WHERE dato >= CURRENT_DATE
        ORDER BY dato`,
      []
    );
    res.json({ hours: hours.rows, closed: closed.rows });
  } catch (e) {
    console.error('hours GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente apningstider' });
  }
});

// Sett apningstid for én ukedag (upsert paa primarnokkel ukedag).
router.put('/:ukedag', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const ukedag = parseUkedag(req.params.ukedag);
  if (ukedag === null) {
    return res.status(400).json({ error: 'Ugyldig ukedag (maa vaere 0-6)' });
  }
  const b = req.body || {};
  const apner = parseTid(b.apner);
  if (!apner.ok) return res.status(400).json({ error: 'apner maa vaere HH:MM' });
  const stenger = parseTid(b.stenger);
  if (!stenger.ok) return res.status(400).json({ error: 'stenger maa vaere HH:MM' });
  const stengt = b.stengt === true || b.stengt === 'true';

  try {
    const rad = await db.one(
      `INSERT INTO business_hours (ukedag, apner, stenger, stengt)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (ukedag) DO UPDATE
            SET apner = EXCLUDED.apner,
                stenger = EXCLUDED.stenger,
                stengt = EXCLUDED.stengt
        RETURNING ukedag, apner, stenger, stengt`,
      [ukedag, apner.val, stenger.val, stengt]
    );
    res.json(rad);
  } catch (e) {
    console.error('hours PUT /:ukedag feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre apningstid' });
  }
});

// Legg til / oppdater en stengt dato (upsert paa primarnokkel dato).
router.post('/closed', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const b = req.body || {};
  const dato = typeof b.dato === 'string' ? b.dato.trim() : '';
  if (!DATO.test(dato)) {
    return res.status(400).json({ error: 'dato maa vaere YYYY-MM-DD' });
  }
  const grunn = b.grunn == null ? null : String(b.grunn);
  try {
    const rad = await db.one(
      `INSERT INTO closed_dates (dato, grunn)
            VALUES ($1, $2)
       ON CONFLICT (dato) DO UPDATE SET grunn = EXCLUDED.grunn
        RETURNING dato, grunn`,
      [dato, grunn]
    );
    res.status(201).json(rad);
  } catch (e) {
    console.error('hours POST /closed feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre stengt dato' });
  }
});

// Fjern en stengt dato.
router.delete('/closed/:dato', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const dato = String(req.params.dato || '').trim();
  if (!DATO.test(dato)) {
    return res.status(400).json({ error: 'dato maa vaere YYYY-MM-DD' });
  }
  try {
    const rad = await db.one(
      `DELETE FROM closed_dates WHERE dato = $1 RETURNING dato`,
      [dato]
    );
    if (!rad) return res.status(404).json({ error: 'Stengt dato ikke funnet' });
    res.json({ ok: true, dato: rad.dato });
  } catch (e) {
    console.error('hours DELETE /closed/:dato feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke slette stengt dato' });
  }
});

module.exports = router;
