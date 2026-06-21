/* Havstund — prosjekter (/api/projects).
   Roller: 'kunde' | 'ansatt' | 'admin'. erAnsatt = ansatt eller admin.
   GET  /            -> egne prosjekter (kunde) eller alle (ansatt/admin), med media
   POST /            -> opprett prosjekt (ansatt/admin)
   PATCH /:id        -> oppdater status/tittel/beskrivelse (ansatt/admin)
   POST /:id/media   -> legg til media på prosjekt (ansatt/admin) */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

const GYLDIGE_STATUSER = ['pabegynt', 'under_arbeid', 'ferdig', 'levert'];

// Henter media for en liste prosjekt-id-er, gruppert per project_id.
async function hentMediaFor(projectIds) {
  const kart = new Map();
  if (!projectIds.length) return kart;
  const { rows } = await db.query(
    `SELECT id, project_id, bruker_id, url, type, tittel, opprettet
       FROM project_media
      WHERE project_id = ANY($1)
      ORDER BY opprettet DESC`,
    [projectIds]
  );
  for (const m of rows) {
    if (!kart.has(m.project_id)) kart.set(m.project_id, []);
    kart.get(m.project_id).push(m);
  }
  return kart;
}

// Liste prosjekter (rollebasert)
router.get('/', async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  if (!req.user) {
    return res.status(401).json({ error: 'Ikke innlogget' });
  }
  const erAnsatt = req.user.rolle === 'ansatt' || req.user.rolle === 'admin';
  try {
    let prosjekter;
    if (!erAnsatt) {
      const { rows } = await db.query(
        `SELECT id, bruker_id, tittel, type, status, beskrivelse, opprettet, oppdatert
           FROM projects
          WHERE bruker_id = $1
          ORDER BY opprettet DESC`,
        [req.user.id]
      );
      prosjekter = rows;
    } else {
      const filterId = req.query.bruker_id ? Number(req.query.bruker_id) : null;
      if (filterId !== null && !Number.isInteger(filterId)) {
        return res.status(400).json({ error: 'Ugyldig bruker_id' });
      }
      const sql =
        `SELECT p.id, p.bruker_id, p.tittel, p.type, p.status, p.beskrivelse,
                p.opprettet, p.oppdatert, u.navn AS kundenavn
           FROM projects p
           LEFT JOIN users u ON u.id = p.bruker_id` +
        (filterId !== null ? ' WHERE p.bruker_id = $1' : '') +
        ' ORDER BY p.opprettet DESC';
      const { rows } = await db.query(sql, filterId !== null ? [filterId] : []);
      prosjekter = rows;
    }

    const mediaKart = await hentMediaFor(prosjekter.map((p) => p.id));
    for (const p of prosjekter) {
      p.media = mediaKart.get(p.id) || [];
    }
    res.json(prosjekter);
  } catch (e) {
    console.error('projects GET / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente prosjekter' });
  }
});

// Opprett prosjekt
router.post('/', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const { bruker_id, tittel, type, beskrivelse } = req.body || {};
  const kundeId = Number(bruker_id);
  if (!Number.isInteger(kundeId)) {
    return res.status(400).json({ error: 'Ugyldig eller manglende bruker_id' });
  }
  if (!tittel || !String(tittel).trim()) {
    return res.status(400).json({ error: 'Tittel er påkrevd' });
  }
  try {
    const project = await db.one(
      `INSERT INTO projects (bruker_id, tittel, type, beskrivelse)
       VALUES ($1, $2, $3, $4)
       RETURNING id, bruker_id, tittel, type, status, beskrivelse, opprettet, oppdatert`,
      [kundeId, String(tittel).trim(), type || null, beskrivelse || null]
    );
    res.status(201).json({ project });
  } catch (e) {
    console.error('projects POST / feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke opprette prosjekt' });
  }
});

// Oppdater prosjekt (status/tittel/beskrivelse)
router.patch('/:id', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  const { status, tittel, beskrivelse } = req.body || {};
  const felt = [];
  const verdier = [];
  let n = 1;

  if (status !== undefined) {
    if (!GYLDIGE_STATUSER.includes(status)) {
      return res.status(400).json({ error: 'Ugyldig status' });
    }
    felt.push(`status = $${n++}`);
    verdier.push(status);
  }
  if (tittel !== undefined) {
    if (!String(tittel).trim()) {
      return res.status(400).json({ error: 'Tittel kan ikke være tom' });
    }
    felt.push(`tittel = $${n++}`);
    verdier.push(String(tittel).trim());
  }
  if (beskrivelse !== undefined) {
    felt.push(`beskrivelse = $${n++}`);
    verdier.push(beskrivelse);
  }

  if (!felt.length) {
    return res.status(400).json({ error: 'Ingen felt å oppdatere' });
  }

  felt.push('oppdatert = now()');
  verdier.push(id);

  try {
    const project = await db.one(
      `UPDATE projects
          SET ${felt.join(', ')}
        WHERE id = $${n}
        RETURNING id, bruker_id, tittel, type, status, beskrivelse, opprettet, oppdatert`,
      verdier
    );
    if (!project) return res.status(404).json({ error: 'Prosjekt ikke funnet' });
    res.json({ project });
  } catch (e) {
    console.error('projects PATCH /:id feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere prosjekt' });
  }
});

// Legg til media på prosjekt
router.post('/:id/media', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Ugyldig id' });
  }
  const { url, tittel, type } = req.body || {};
  if (!url || !String(url).trim()) {
    return res.status(400).json({ error: 'url er påkrevd' });
  }
  try {
    const prosjekt = await db.one(
      'SELECT id, bruker_id FROM projects WHERE id = $1',
      [id]
    );
    if (!prosjekt) return res.status(404).json({ error: 'Prosjekt ikke funnet' });

    const media = await db.one(
      `INSERT INTO project_media (project_id, bruker_id, url, type, tittel)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_id, bruker_id, url, type, tittel, opprettet`,
      [id, prosjekt.bruker_id, String(url).trim(), type || 'bilde', tittel || null]
    );
    res.status(201).json({ media });
  } catch (e) {
    console.error('projects POST /:id/media feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke legge til media' });
  }
});

module.exports = router;
