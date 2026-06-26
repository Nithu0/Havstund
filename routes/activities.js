/* Havstund — aktiviteter (/api/activities).
   GET /          -> aktive aktiviteter sortert på sortering (offentlig)
   GET /:id       -> én aktivitet (404 hvis ikke funnet) (offentlig)
   POST /         -> opprett aktivitet            (requireRole('admin'))
   PUT /:id       -> oppdater aktivitet           (requireRole('admin'))
   DELETE /:id    -> soft-delete (aktiv=false)    (requireRole('admin')) */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

const FELT = 'id, slug, navn, beskrivelse, varighet, pris, kapasitet, bilde';
// Alle kolonner inkl. aktiv/sortering — brukt av admin-svar etter skriv.
const FELT_ADMIN = `${FELT}, aktiv, sortering`;

// Validerer + normaliserer kropp for POST/PUT.
// Returnerer { ok:true, data } eller { ok:false, feil }.
function validerKropp(body, { krevSlug }) {
  const b = body || {};
  const navn = typeof b.navn === 'string' ? b.navn.trim() : '';
  if (!navn) return { ok: false, feil: 'navn er påkrevd' };
  if (navn.length > 200) return { ok: false, feil: 'navn er for langt (maks 200)' };

  // slug: a-z, 0-9 og bindestrek, 1–64 tegn. Påkrevd ved POST.
  let slug = typeof b.slug === 'string' ? b.slug.trim() : '';
  if (krevSlug || slug) {
    if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
      return { ok: false, feil: 'slug må være a-z, 0-9 og bindestrek (1–64 tegn)' };
    }
  }

  // pris og kapasitet: heltall ≥ 0.
  const pris = heltallIkkeNegativ(b.pris);
  if (pris === null) return { ok: false, feil: 'pris må være et heltall ≥ 0' };
  const kapasitet = heltallIkkeNegativ(b.kapasitet);
  if (kapasitet === null) return { ok: false, feil: 'kapasitet må være et heltall ≥ 0' };

  // valgfrie tekstfelt (varighet er TEXT i schema)
  const beskrivelse = b.beskrivelse == null ? null : String(b.beskrivelse);
  const varighet = b.varighet == null ? null : String(b.varighet);
  const bilde = b.bilde == null ? null : String(b.bilde);

  return { ok: true, data: { slug, navn, beskrivelse, varighet, pris, kapasitet, bilde } };
}

// Parser et heltall ≥ 0. Godtar tall eller numerisk streng. Ellers null.
function heltallIkkeNegativ(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

// Liste aktive aktiviteter
router.get('/', async (_req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  try {
    const { rows } = await db.query(
      `SELECT ${FELT} FROM activities WHERE aktiv = true ORDER BY sortering`,
      []
    );
    res.json(rows);
  } catch (e) {
    console.error('activities GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente aktiviteter' });
  }
});

// Admin-liste: ALLE aktiviteter inkl. inaktive (soft-deletede).
// Plassert FØR '/:id' så ruten ikke fanges som id='admin'.
router.get('/admin/all', requireRole('admin'), async (_req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  try {
    const { rows } = await db.query(
      `SELECT ${FELT_ADMIN} FROM activities ORDER BY aktiv DESC, sortering, id`,
      []
    );
    res.json(rows);
  } catch (e) {
    console.error('activities GET /admin/all feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente aktiviteter' });
  }
});

// Én aktivitet
router.get('/:id', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  try {
    const rad = await db.one(
      `SELECT ${FELT} FROM activities WHERE id = $1 AND aktiv = true`,
      [id]
    );
    if (!rad) return res.status(404).json({ error: 'Aktivitet ikke funnet' });
    res.json(rad);
  } catch (e) {
    console.error('activities GET /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente aktivitet' });
  }
});

// ---- Admin-CRUD (kun rolle 'admin') ----

// Opprett aktivitet
router.post('/', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const v = validerKropp(req.body, { krevSlug: true });
  if (!v.ok) return res.status(400).json({ error: v.feil });
  const { slug, navn, beskrivelse, varighet, pris, kapasitet, bilde } = v.data;
  try {
    const rad = await db.one(
      `INSERT INTO activities (slug, navn, beskrivelse, varighet, pris, kapasitet, bilde)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${FELT_ADMIN}`,
      [slug, navn, beskrivelse, varighet, pris, kapasitet, bilde]
    );
    res.status(201).json(rad);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'slug er allerede i bruk' });
    }
    console.error('activities POST / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke opprette aktivitet' });
  }
});

// Oppdater aktivitet
router.put('/:id', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  // krevSlug:false — slug er valgfri ved PUT, men valideres hvis sendt.
  const v = validerKropp(req.body, { krevSlug: false });
  if (!v.ok) return res.status(400).json({ error: v.feil });
  const { slug, navn, beskrivelse, varighet, pris, kapasitet, bilde } = v.data;
  try {
    // COALESCE på slug: behold eksisterende hvis ikke sendt (tom streng -> null).
    const rad = await db.one(
      `UPDATE activities
          SET slug        = COALESCE($1, slug),
              navn        = $2,
              beskrivelse = $3,
              varighet    = $4,
              pris        = $5,
              kapasitet   = $6,
              bilde       = $7
        WHERE id = $8
      RETURNING ${FELT_ADMIN}`,
      [slug || null, navn, beskrivelse, varighet, pris, kapasitet, bilde, id]
    );
    if (!rad) return res.status(404).json({ error: 'Aktivitet ikke funnet' });
    res.json(rad);
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'slug er allerede i bruk' });
    }
    console.error('activities PUT /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere aktivitet' });
  }
});

// Soft-delete: sett aktiv=false (FK fra bookings/availability — ikke hard delete)
router.delete('/:id', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  try {
    const rad = await db.one(
      `UPDATE activities SET aktiv = false WHERE id = $1 RETURNING ${FELT_ADMIN}`,
      [id]
    );
    if (!rad) return res.status(404).json({ error: 'Aktivitet ikke funnet' });
    res.json({ ok: true, id: rad.id });
  } catch (e) {
    console.error('activities DELETE /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke slette aktivitet' });
  }
});

module.exports = router;
