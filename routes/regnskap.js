/* Havstund — regnskap (/api/regnskap). Kun ansatt/admin.
   Fiken-formet: belop i ore, norsk kontoplan, MVA-koder.
   Tanken: en fremtidig integrasjon henter disse postene og dytter dem
   rett inn i Fikens API (Salg / Kjop / Timeforing / Lonn).

   GET  /oversikt?maaned=YYYY-MM   -> manedlig resultat (inntekt/utgift/mva/lonn)
   GET  /poster?maaned=&type=      -> liste poster
   POST /poster                    -> ny post (regner mva/brutto selv)
   DELETE /poster/:id
   GET  /ansatte                   -> liste ansatte
   POST /ansatte                   -> ny ansatt
   PATCH /ansatte/:id              -> oppdater ansatt
   GET  /timer?maaned=&ansatt_id=  -> liste timeforinger
   POST /timer                     -> ny timeforing
   DELETE /timer/:id
   GET  /lonn?maaned=YYYY-MM       -> lonnsgrunnlag per ansatt (for lonnskjoring) */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

// Alt under /api/regnskap krever ansatt eller admin
router.use(requireRole('ansatt', 'admin'));

function utilgjengelig(res) {
  return res.status(503).json({ error: 'Regnskap er midlertidig utilgjengelig.' });
}

// YYYY-MM (default: inneverende maned hvis ugyldig)
function gyldigMaaned(m) {
  return typeof m === 'string' && /^\d{4}-\d{2}$/.test(m) ? m : null;
}

const TYPER = ['inntekt', 'utgift'];
const SATSER = [0, 12, 15, 25];

// ---------- OVERSIKT ----------
router.get('/oversikt', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  if (!maaned) return res.status(400).json({ error: 'Mangler gyldig maaned (YYYY-MM)' });
  try {
    const p = await db.one(
      `SELECT
         COALESCE(SUM(CASE WHEN type='inntekt' THEN netto_ore END),0)::bigint  AS inntekt_netto,
         COALESCE(SUM(CASE WHEN type='inntekt' THEN mva_ore END),0)::bigint     AS utgaaende_mva,
         COALESCE(SUM(CASE WHEN type='utgift'  THEN netto_ore END),0)::bigint   AS utgift_netto,
         COALESCE(SUM(CASE WHEN type='utgift'  THEN mva_ore END),0)::bigint     AS inngaaende_mva,
         COUNT(*)::int                                                          AS antall
       FROM regnskap_poster
       WHERE to_char(dato,'YYYY-MM') = $1`,
      [maaned]
    );
    const lonn = await db.one(
      `SELECT COALESCE(SUM(t.timer * a.timelonn_ore),0)::bigint AS lonn_ore,
              COALESCE(SUM(t.timer),0)::numeric                  AS sum_timer
         FROM timeforinger t JOIN ansatte a ON a.id = t.ansatt_id
        WHERE to_char(t.dato,'YYYY-MM') = $1`,
      [maaned]
    );
    const inntektNetto = Number(p.inntekt_netto);
    const utgiftNetto = Number(p.utgift_netto);
    res.json({
      maaned,
      inntekt_netto: inntektNetto,
      utgift_netto: utgiftNetto,
      resultat_ore: inntektNetto - utgiftNetto,
      utgaaende_mva: Number(p.utgaaende_mva),
      inngaaende_mva: Number(p.inngaaende_mva),
      mva_aa_betale: Number(p.utgaaende_mva) - Number(p.inngaaende_mva),
      antall_poster: p.antall,
      lonn_ore: Number(lonn.lonn_ore),
      sum_timer: Number(lonn.sum_timer),
    });
  } catch (e) {
    console.error('regnskap /oversikt feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente oversikt' });
  }
});

// ---------- POSTER ----------
router.get('/poster', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  const type = TYPER.includes(req.query.type) ? req.query.type : null;
  const vilkaar = [];
  const verdier = [];
  if (maaned) { verdier.push(maaned); vilkaar.push(`to_char(dato,'YYYY-MM') = $${verdier.length}`); }
  if (type) { verdier.push(type); vilkaar.push(`type = $${verdier.length}`); }
  const where = vilkaar.length ? 'WHERE ' + vilkaar.join(' AND ') : '';
  try {
    const { rows } = await db.query(
      `SELECT id, type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
              netto_ore, mva_ore, brutto_ore, betalingsmetode, bilag, kilde, fiken_status
         FROM regnskap_poster ${where}
        ORDER BY dato DESC, id DESC`,
      verdier
    );
    res.json(rows);
  } catch (e) {
    console.error('regnskap /poster GET feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente poster' });
  }
});

router.post('/poster', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const b = req.body || {};
  const type = TYPER.includes(b.type) ? b.type : null;
  if (!type) return res.status(400).json({ error: 'Ugyldig type (inntekt/utgift)' });
  if (!b.dato || !/^\d{4}-\d{2}-\d{2}$/.test(b.dato)) return res.status(400).json({ error: 'Ugyldig dato' });
  if (!b.beskrivelse || !String(b.beskrivelse).trim()) return res.status(400).json({ error: 'Beskrivelse er pakrevd' });

  const nettoOre = Math.round(Number(b.netto_ore));
  if (!Number.isFinite(nettoOre) || nettoOre < 0) return res.status(400).json({ error: 'Ugyldig belop' });
  const sats = SATSER.includes(Number(b.mva_sats)) ? Number(b.mva_sats) : 0;
  const mvaOre = Math.round(nettoOre * sats / 100);
  const bruttoOre = nettoOre + mvaOre;
  const konto = Number.isInteger(Number(b.konto)) ? Number(b.konto) : null;
  const mvaKode = Number.isInteger(Number(b.mva_kode)) ? Number(b.mva_kode) : null;

  try {
    const post = await db.one(
      `INSERT INTO regnskap_poster
         (type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
          netto_ore, mva_ore, brutto_ore, betalingsmetode, bilag, kilde)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
                 netto_ore, mva_ore, brutto_ore, betalingsmetode, bilag, kilde, fiken_status`,
      [type, b.dato, b.kontakt || null, String(b.beskrivelse).trim(), konto, mvaKode, sats,
       nettoOre, mvaOre, bruttoOre, b.betalingsmetode || null, b.bilag || null, b.kilde || 'manuell']
    );
    res.status(201).json({ post });
  } catch (e) {
    console.error('regnskap /poster POST feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre post' });
  }
});

router.delete('/poster/:id', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  try {
    await db.query('DELETE FROM regnskap_poster WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('regnskap /poster DELETE feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke slette' });
  }
});

// ---------- ANSATTE ----------
router.get('/ansatte', async (_req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  try {
    const { rows } = await db.query(
      `SELECT id, user_id, navn, epost, stilling, timelonn_ore, konto, aktiv
         FROM ansatte ORDER BY aktiv DESC, navn ASC`
    );
    res.json(rows);
  } catch (e) {
    console.error('regnskap /ansatte GET feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente ansatte' });
  }
});

router.post('/ansatte', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const b = req.body || {};
  if (!b.navn || !String(b.navn).trim()) return res.status(400).json({ error: 'Navn er pakrevd' });
  const timelonnOre = Math.round(Number(b.timelonn_ore));
  if (!Number.isFinite(timelonnOre) || timelonnOre < 0) return res.status(400).json({ error: 'Ugyldig timelonn' });
  try {
    const ansatt = await db.one(
      `INSERT INTO ansatte (navn, epost, stilling, timelonn_ore, konto)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, user_id, navn, epost, stilling, timelonn_ore, konto, aktiv`,
      [String(b.navn).trim(), b.epost || null, b.stilling || null, timelonnOre,
       Number.isInteger(Number(b.konto)) ? Number(b.konto) : 5000]
    );
    res.status(201).json({ ansatt });
  } catch (e) {
    console.error('regnskap /ansatte POST feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre ansatt' });
  }
});

router.patch('/ansatte/:id', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  const b = req.body || {};
  const felt = [];
  const verdier = [];
  if (b.navn !== undefined) { verdier.push(String(b.navn).trim()); felt.push(`navn = $${verdier.length}`); }
  if (b.epost !== undefined) { verdier.push(b.epost || null); felt.push(`epost = $${verdier.length}`); }
  if (b.stilling !== undefined) { verdier.push(b.stilling || null); felt.push(`stilling = $${verdier.length}`); }
  if (b.timelonn_ore !== undefined) { verdier.push(Math.round(Number(b.timelonn_ore)) || 0); felt.push(`timelonn_ore = $${verdier.length}`); }
  if (b.aktiv !== undefined) { verdier.push(!!b.aktiv); felt.push(`aktiv = $${verdier.length}`); }
  if (!felt.length) return res.status(400).json({ error: 'Ingen felt aa oppdatere' });
  verdier.push(id);
  try {
    const ansatt = await db.one(
      `UPDATE ansatte SET ${felt.join(', ')} WHERE id = $${verdier.length}
       RETURNING id, user_id, navn, epost, stilling, timelonn_ore, konto, aktiv`,
      verdier
    );
    if (!ansatt) return res.status(404).json({ error: 'Ansatt ikke funnet' });
    res.json({ ansatt });
  } catch (e) {
    console.error('regnskap /ansatte PATCH feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere ansatt' });
  }
});

// ---------- TIMER ----------
router.get('/timer', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  const ansattId = Number(req.query.ansatt_id);
  const vilkaar = [];
  const verdier = [];
  if (maaned) { verdier.push(maaned); vilkaar.push(`to_char(t.dato,'YYYY-MM') = $${verdier.length}`); }
  if (Number.isInteger(ansattId)) { verdier.push(ansattId); vilkaar.push(`t.ansatt_id = $${verdier.length}`); }
  const where = vilkaar.length ? 'WHERE ' + vilkaar.join(' AND ') : '';
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.ansatt_id, a.navn AS ansatt_navn, t.dato, t.timer, t.aktivitet, t.notat
         FROM timeforinger t JOIN ansatte a ON a.id = t.ansatt_id
         ${where}
        ORDER BY t.dato DESC, t.id DESC`,
      verdier
    );
    res.json(rows);
  } catch (e) {
    console.error('regnskap /timer GET feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente timer' });
  }
});

router.post('/timer', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const b = req.body || {};
  const ansattId = Number(b.ansatt_id);
  if (!Number.isInteger(ansattId)) return res.status(400).json({ error: 'Velg en ansatt' });
  if (!b.dato || !/^\d{4}-\d{2}-\d{2}$/.test(b.dato)) return res.status(400).json({ error: 'Ugyldig dato' });
  const timer = Number(b.timer);
  if (!Number.isFinite(timer) || timer <= 0 || timer > 24) return res.status(400).json({ error: 'Ugyldig timetall' });
  try {
    const t = await db.one(
      `INSERT INTO timeforinger (ansatt_id, dato, timer, aktivitet, notat)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, ansatt_id, dato, timer, aktivitet, notat`,
      [ansattId, b.dato, timer, b.aktivitet || null, b.notat || null]
    );
    res.status(201).json({ timeforing: t });
  } catch (e) {
    console.error('regnskap /timer POST feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre timer' });
  }
});

router.delete('/timer/:id', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  try {
    await db.query('DELETE FROM timeforinger WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error('regnskap /timer DELETE feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke slette' });
  }
});

// ---------- LONN (lonnsgrunnlag per ansatt for valgt maned) ----------
router.get('/lonn', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  if (!maaned) return res.status(400).json({ error: 'Mangler gyldig maaned (YYYY-MM)' });
  try {
    const { rows } = await db.query(
      `SELECT a.id AS ansatt_id, a.navn, a.stilling, a.timelonn_ore, a.konto,
              COALESCE(SUM(t.timer),0)::numeric                     AS sum_timer,
              COALESCE(SUM(t.timer * a.timelonn_ore),0)::bigint     AS brutto_ore
         FROM ansatte a
         LEFT JOIN timeforinger t
           ON t.ansatt_id = a.id AND to_char(t.dato,'YYYY-MM') = $1
        WHERE a.aktiv = true
        GROUP BY a.id
        ORDER BY a.navn ASC`,
      [maaned]
    );
    const total = rows.reduce((s, r) => s + Number(r.brutto_ore), 0);
    res.json({
      maaned,
      ansatte: rows.map((r) => ({
        ansatt_id: r.ansatt_id, navn: r.navn, stilling: r.stilling,
        timelonn_ore: r.timelonn_ore, konto: r.konto,
        sum_timer: Number(r.sum_timer), brutto_ore: Number(r.brutto_ore),
      })),
      total_brutto_ore: total,
    });
  } catch (e) {
    console.error('regnskap /lonn feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente lonnsgrunnlag' });
  }
});

module.exports = router;
