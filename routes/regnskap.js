/* Havstund — regnskap (/api/regnskap). Admin-only (blocker 2, bolge 98).
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
const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const fiken = require('../lib/fiken');
const { logger } = require('../lib/logger');
const { writeAudit } = require('../lib/audit');
const { byggRegnskapspakke } = require('../lib/regnskapspakke');

const router = express.Router();

// Alt under /api/regnskap krever admin. Blocker 2 (bolge 98): en ansatt skal
// IKKE se alles lonn/timer/poster her. Ansatt far egne data via /api/min/* i en
// senere runde (bygges ikke naa). Hele ruteren er dermed admin-only.
router.use(requireRole('admin'));

function utilgjengelig(res) {
  return res.status(503).json({ error: 'Regnskap er midlertidig utilgjengelig.' });
}

// YYYY-MM (default: inneverende maned hvis ugyldig)
function gyldigMaaned(m) {
  return typeof m === 'string' && /^\d{4}-\d{2}$/.test(m) ? m : null;
}

// Streng YYYY-MM-DD: format OG ekte kalenderdag (avviser 2026-13-40, 2026-02-30).
// Returnerer den normaliserte strengen eller null.
function gyldigDato(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // roundtrip: JS ruller over ugyldige dager (feb 30 -> mar 2), saa mismatch = ugyldig.
  return d.toISOString().slice(0, 10) === s ? s : null;
}

const TYPER = ['inntekt', 'utgift'];
const SATSER = [0, 12, 15, 25];

// Positiv int fra env, ellers fallback (samme monster som lib/security.js:tall).
function tallEnv(envVerdi, fallback) {
  const n = Number.parseInt(envVerdi, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Moderat rate-limit KUN paa den tunge pakke-ruta (maneds-sporring + generator).
// Gated paa samme RATE_LIMIT_ENABLED-bryter som lib/security.js for konsistens,
// men limiteren er lokal her (vi eier ikke security.js). Av-bryter => no-op.
const pakkeLimiter = rateLimit({
  windowMs: tallEnv(process.env.RATE_LIMIT_PAKKE_WINDOW_MS, 15 * 60 * 1000),
  max: tallEnv(process.env.RATE_LIMIT_PAKKE_MAX, 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'For mange pakke-foresporsler. Vent litt og prov igjen.' },
});
const pakkeGate = process.env.RATE_LIMIT_ENABLED === 'false'
  ? (_req, _res, next) => next()
  : pakkeLimiter;

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
              netto_ore, mva_ore, brutto_ore, betalingsmetode, bilag, kilde, fiken_status,
              (vedlegg IS NOT NULL) AS har_vedlegg
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

  // Valgfritt kvitteringsbilde som base64 data-URL (lagres i DB — Railway-filsystem er flyktig)
  let vedlegg = null;
  if (b.vedlegg !== undefined && b.vedlegg !== null && b.vedlegg !== '') {
    if (typeof b.vedlegg !== 'string' || !b.vedlegg.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Vedlegg maa vaere et bilde (data:image/...)' });
    }
    if (b.vedlegg.length > 7000000) {
      return res.status(400).json({ error: 'Vedlegg for stort' });
    }
    vedlegg = b.vedlegg;
  }

  try {
    const post = await db.one(
      `INSERT INTO regnskap_poster
         (type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
          netto_ore, mva_ore, brutto_ore, betalingsmetode, bilag, vedlegg, kilde)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id, type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
                 netto_ore, mva_ore, brutto_ore, betalingsmetode, bilag, kilde, fiken_status`,
      [type, b.dato, b.kontakt || null, String(b.beskrivelse).trim(), konto, mvaKode, sats,
       nettoOre, mvaOre, bruttoOre, b.betalingsmetode || null, b.bilag || null, vedlegg, b.kilde || 'manuell']
    );
    res.status(201).json({ post });
  } catch (e) {
    console.error('regnskap /poster POST feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre post' });
  }
});

// Hent selve kvitteringsbildet for en post (parser data-URL -> binaer respons)
router.get('/poster/:id/vedlegg', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  try {
    const post = await db.one('SELECT vedlegg FROM regnskap_poster WHERE id = $1', [id]);
    if (!post || !post.vedlegg) return res.status(404).json({ error: 'Ingen vedlegg' });
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(post.vedlegg);
    if (!m) return res.status(404).json({ error: 'Ingen vedlegg' });
    const buf = Buffer.from(m[2], 'base64');
    res.set('Content-Type', m[1]);
    res.set('Content-Length', String(buf.length));
    res.send(buf);
  } catch (e) {
    console.error('regnskap /poster/:id/vedlegg GET feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente vedlegg' });
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
  // Valgfri kobling til en bruker (users.id). Admin kan koble en ansatt-rad til
  // en innlogget bruker slik at hentAnsatt (lib/ansatt.js) senere finner den via
  // user_id. Tom/utelatt => null (ukoblet). UNIQUE(user_id) legges av migrate();
  // en duplikat-kobling fanges som 23505 -> 409 under.
  let userId = null;
  if (b.user_id !== undefined && b.user_id !== null && b.user_id !== '') {
    userId = Number(b.user_id);
    if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Ugyldig user_id' });
  }
  try {
    const ansatt = await db.one(
      `INSERT INTO ansatte (navn, epost, stilling, timelonn_ore, konto, user_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, user_id, navn, epost, stilling, timelonn_ore, konto, aktiv`,
      [String(b.navn).trim(), b.epost || null, b.stilling || null, timelonnOre,
       Number.isInteger(Number(b.konto)) ? Number(b.konto) : 5000, userId]
    );
    res.status(201).json({ ansatt });
  } catch (e) {
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'Denne brukeren er allerede koblet til en ansatt.' });
    }
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
  // Bruker-kobling kan settes eller nullstilles eksplisitt av admin. Tom/null =>
  // koble fra. UNIQUE(user_id) (migrate) => duplikat fanges som 23505 -> 409.
  if (b.user_id !== undefined) {
    let uid = null;
    if (b.user_id !== null && b.user_id !== '') {
      uid = Number(b.user_id);
      if (!Number.isInteger(uid)) return res.status(400).json({ error: 'Ugyldig user_id' });
    }
    verdier.push(uid); felt.push(`user_id = $${verdier.length}`);
  }
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
    if (e && e.code === '23505') {
      return res.status(409).json({ error: 'Denne brukeren er allerede koblet til en ansatt.' });
    }
    console.error('regnskap /ansatte PATCH feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere ansatt' });
  }
});

// ---------- TIMER (bolge 98 steg 6: admin forer/redigerer/godkjenner PAA VEGNE AV ansatte) ----------
// Motsatsen til /api/min/* (ansatt selvbetjening, der ansatt_id UTLEDES fra
// req.ansatt.id). HER er ansatt_id ALLTID EKSPLISITT i body/query — admin handler
// paa vegne av en navngitt ansatt, aldri implisitt. Dette er en SKRIVESTI til
// ANDRES lonnsgrunnlag: hver skriving revideres (writeAudit).
//
// Statusmaskin (samme kolonner som /api/min/*, lagt av db/index.js:migrate):
//   utkast -> sendt_inn -> godkjent -> laast   (normalflyt)
//   avvist = sidespor (sendt_inn -> avvist, rettes og sendes paa nytt)
// Admin oppretter foringer som 'sendt_inn' (IKKE 'godkjent' — 2-stegs, design
// Sec 5.2.1: godkjenning er en egen, revidert handling). Overganger settes ALLTID
// server-side; en status i klient-body ignoreres. En LAAST rad er urorlig: ingen
// UPDATE/DELETE naar den (-> 409). Eneste vei "inn i" en laast rad er en
// korreksjonsrad (POST /timer/:id/korriger) som lar originalen staa uroert.

const TIMER_KOLONNER =
  'id, ansatt_id, dato, timer, aktivitet, notat, status, ' +
  'godkjent_av, godkjent_tid, begrunnelse, laast_tid, korrigerer_id, ' +
  'opprettet_av, endret_av, endret_tid, opprettet';

const TIMER_STATUSER = ['utkast', 'sendt_inn', 'godkjent', 'avvist', 'laast'];

// Timetall > 0 og <= 24 (samme som /api/min/*). Returnerer tallet eller null.
function gyldigTimer(v) {
  const t = Number(v);
  if (!Number.isFinite(t) || t <= 0 || t > 24) return null;
  return t;
}

// Korreksjonstimer: KAN vaere negativt (trekke fra en laast rad) — men ikke 0 og
// innen +/- 24. Returnerer tallet eller null.
function gyldigKorreksjonstimer(v) {
  const t = Number(v);
  if (!Number.isFinite(t) || t === 0 || t < -24 || t > 24) return null;
  return t;
}

// Fire-and-forget audit. writeAudit svelger allerede egne feil; .catch for
// sikkerhet slik at en audit-feil ALDRI velter selve skrivehandlingen. Kalles
// SYNKRONT i handleren (foer res) — revisjonssporet henger ikke etter svaret.
function auditTimer(user, handling, detaljer) {
  Promise.resolve(writeAudit(user, handling, detaljer)).catch(() => {});
}

// GET /timer?ansatt_id=&maaned=&status=  — alles foringer, filtrerbart. ansatt_id
// er VALGFRITT her: dette er LESING (admin ser alt). Skriving krever alltid
// eksplisitt ansatt_id (se POST).
router.get('/timer', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  const ansattId = Number(req.query.ansatt_id);
  const status = TIMER_STATUSER.includes(req.query.status) ? req.query.status : null;
  const vilkaar = [];
  const verdier = [];
  if (maaned) { verdier.push(maaned); vilkaar.push(`to_char(t.dato,'YYYY-MM') = $${verdier.length}`); }
  if (Number.isInteger(ansattId)) { verdier.push(ansattId); vilkaar.push(`t.ansatt_id = $${verdier.length}`); }
  if (status) { verdier.push(status); vilkaar.push(`t.status = $${verdier.length}`); }
  const where = vilkaar.length ? 'WHERE ' + vilkaar.join(' AND ') : '';
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.ansatt_id, a.navn AS ansatt_navn, t.dato, t.timer, t.aktivitet,
              t.notat, t.status, t.godkjent_av, t.godkjent_tid, t.begrunnelse,
              t.laast_tid, t.korrigerer_id, t.opprettet_av, t.endret_av, t.endret_tid
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

// POST /timer  — ny foring PAA VEGNE AV en ansatt. ansatt_id PAAKREVD (400 hvis
// mangler — aldri implisitt). status settes SERVER-side til 'sendt_inn': admin maa
// fortsatt godkjenne i et eget steg (design Sec 5.2.1, 2-stegs). opprettet_av =
// den innloggede admin. Revideres.
router.post('/timer', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const b = req.body || {};
  const ansattId = Number(b.ansatt_id);
  if (!Number.isInteger(ansattId)) return res.status(400).json({ error: 'ansatt_id er pakrevd' });
  const dato = gyldigDato(b.dato);
  if (!dato) return res.status(400).json({ error: 'Ugyldig dato (YYYY-MM-DD)' });
  const timer = gyldigTimer(b.timer);
  if (timer == null) return res.status(400).json({ error: 'Ugyldig timetall (> 0 og <= 24)' });
  try {
    // status bindes til konstanten 'sendt_inn' i SQL-teksten — den kan ikke settes
    // fra klient (selv om b.status finnes, roeres den aldri).
    const t = await db.one(
      `INSERT INTO timeforinger (ansatt_id, dato, timer, aktivitet, notat, status, opprettet_av)
       VALUES ($1,$2,$3,$4,$5,'sendt_inn',$6)
       RETURNING ${TIMER_KOLONNER}`,
      [ansattId, dato, timer, b.aktivitet || null, b.notat || null, req.user.id]
    );
    auditTimer(req.user, 'regnskap.timer.opprett', {
      id: t.id, ansatt_id: ansattId, dato, timer, status: 'sendt_inn',
    });
    res.status(201).json({ timeforing: t });
  } catch (e) {
    console.error('regnskap /timer POST feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre timer' });
  }
});

// POST /timer/laas?maaned=YYYY-MM  — laas maanedens godkjente foringer:
// godkjent -> laast + laast_tid. En laast rad er urorlig etterpaa (PATCH/DELETE
// -> 409). Enkelt-statement UPDATE er atomisk, saa ingen per-rad transaksjon er
// noedvendig. Revideres samlet (antall + maaned). Distinkt 2-segments sti — kolliderer
// ikke med POST /timer/:id/* (3 segmenter).
router.post('/timer/laas', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  if (!maaned) return res.status(400).json({ error: 'Mangler gyldig maaned (YYYY-MM)' });
  try {
    const { rows } = await db.query(
      `UPDATE timeforinger
          SET status = 'laast', laast_tid = now()
        WHERE status = 'godkjent'
          AND to_char(dato,'YYYY-MM') = $1
        RETURNING id`,
      [maaned]
    );
    const ids = rows.map((r) => r.id);
    auditTimer(req.user, 'regnskap.timer.laas', { maaned, antall: ids.length, ids });
    res.json({ laast: ids.length, ids, maaned });
  } catch (e) {
    console.error('regnskap /timer laas feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke laase timer' });
  }
});

// PATCH /timer/:id  — rediger enhver IKKE-LAAST foring. En laast rad er urorlig
// (-> 409). endret_av/endret_tid settes. status og ansatt_id ROERES ALDRI her
// (status via godkjenn/avvis; en foring flyttes ikke mellom ansatte). Les-sjekk-
// skriv i EN transaksjon med FOR UPDATE saa to samtidige admin-endringer paa samme
// rad serialiseres (tilstands-sjekken kan ikke omgaas av et race).
router.patch('/timer/:id', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  const b = req.body || {};
  const felt = [];
  const verdier = [];
  if (b.dato !== undefined) {
    const dato = gyldigDato(b.dato);
    if (!dato) return res.status(400).json({ error: 'Ugyldig dato (YYYY-MM-DD)' });
    verdier.push(dato); felt.push(`dato = $${verdier.length}`);
  }
  if (b.timer !== undefined) {
    const timer = gyldigTimer(b.timer);
    if (timer == null) return res.status(400).json({ error: 'Ugyldig timetall (> 0 og <= 24)' });
    verdier.push(timer); felt.push(`timer = $${verdier.length}`);
  }
  if (b.aktivitet !== undefined) { verdier.push(b.aktivitet || null); felt.push(`aktivitet = $${verdier.length}`); }
  if (b.notat !== undefined) { verdier.push(b.notat || null); felt.push(`notat = $${verdier.length}`); }
  if (!felt.length) return res.status(400).json({ error: 'Ingen felt aa oppdatere' });
  verdier.push(req.user.id); felt.push(`endret_av = $${verdier.length}`);
  felt.push('endret_tid = now()');
  try {
    const utfall = await db.withTransaction(async (client) => {
      const rad = (await client.query(
        'SELECT id, status FROM timeforinger WHERE id = $1 FOR UPDATE',
        [id]
      )).rows[0];
      if (!rad) return { kode: 404 };
      if (rad.status === 'laast') return { kode: 409 };
      verdier.push(id);
      const oppdatert = (await client.query(
        `UPDATE timeforinger SET ${felt.join(', ')} WHERE id = $${verdier.length}
         RETURNING ${TIMER_KOLONNER}`,
        verdier
      )).rows[0];
      return { kode: 200, timeforing: oppdatert };
    });
    if (utfall.kode === 404) return res.status(404).json({ error: 'Foring ikke funnet' });
    if (utfall.kode === 409) {
      return res.status(409).json({ error: 'Foringen er laast og kan ikke endres. Bruk korriger.' });
    }
    auditTimer(req.user, 'regnskap.timer.rediger', { id });
    res.json({ timeforing: utfall.timeforing });
  } catch (e) {
    console.error('regnskap /timer PATCH feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere foring' });
  }
});

// DELETE /timer/:id  — KUN en 'utkast'-rad kan slettes (annet -> 409). Innsendte/
// godkjente/laaste rader er del av lonnshistorikken og slettes aldri. FOR UPDATE
// saa tilstands-sjekken ikke omgaas av et race.
router.delete('/timer/:id', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  try {
    const utfall = await db.withTransaction(async (client) => {
      const rad = (await client.query(
        'SELECT id, status FROM timeforinger WHERE id = $1 FOR UPDATE',
        [id]
      )).rows[0];
      if (!rad) return { kode: 404 };
      if (rad.status !== 'utkast') return { kode: 409 };
      await client.query('DELETE FROM timeforinger WHERE id = $1', [id]);
      return { kode: 200 };
    });
    if (utfall.kode === 404) return res.status(404).json({ error: 'Foring ikke funnet' });
    if (utfall.kode === 409) {
      return res.status(409).json({ error: 'Kun utkast kan slettes. Innsendte/laaste foringer bevares.' });
    }
    auditTimer(req.user, 'regnskap.timer.slett', { id });
    res.json({ ok: true });
  } catch (e) {
    console.error('regnskap /timer DELETE feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke slette' });
  }
});

// POST /timer/:id/godkjenn  — sendt_inn -> godkjent. godkjent_av/godkjent_tid.
// Feil utgangstilstand (ikke sendt_inn) -> 409. FOR UPDATE serialiserer mot en
// samtidig avvis/godkjenn paa samme rad.
router.post('/timer/:id/godkjenn', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  try {
    const utfall = await db.withTransaction(async (client) => {
      const rad = (await client.query(
        'SELECT id, status FROM timeforinger WHERE id = $1 FOR UPDATE',
        [id]
      )).rows[0];
      if (!rad) return { kode: 404 };
      if (rad.status !== 'sendt_inn') return { kode: 409 };
      const oppdatert = (await client.query(
        `UPDATE timeforinger
            SET status = 'godkjent', godkjent_av = $1, godkjent_tid = now()
          WHERE id = $2
         RETURNING ${TIMER_KOLONNER}`,
        [req.user.id, id]
      )).rows[0];
      return { kode: 200, timeforing: oppdatert };
    });
    if (utfall.kode === 404) return res.status(404).json({ error: 'Foring ikke funnet' });
    if (utfall.kode === 409) {
      return res.status(409).json({ error: 'Bare en innsendt foring kan godkjennes.' });
    }
    auditTimer(req.user, 'regnskap.timer.godkjenn', { id, godkjent_av: req.user.id });
    res.json({ timeforing: utfall.timeforing });
  } catch (e) {
    console.error('regnskap /timer godkjenn feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke godkjenne foring' });
  }
});

// POST /timer/:id/avvis  (body: begrunnelse PAAKREVD) — sendt_inn -> avvist +
// begrunnelse. Feil utgangstilstand -> 409. Begrunnelse er obligatorisk (400)
// slik at en avvisning alltid er sporbar for den ansatte.
router.post('/timer/:id/avvis', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  const b = req.body || {};
  const begrunnelse = typeof b.begrunnelse === 'string' ? b.begrunnelse.trim() : '';
  if (!begrunnelse) return res.status(400).json({ error: 'Begrunnelse er pakrevd ved avvisning' });
  try {
    const utfall = await db.withTransaction(async (client) => {
      const rad = (await client.query(
        'SELECT id, status FROM timeforinger WHERE id = $1 FOR UPDATE',
        [id]
      )).rows[0];
      if (!rad) return { kode: 404 };
      if (rad.status !== 'sendt_inn') return { kode: 409 };
      const oppdatert = (await client.query(
        `UPDATE timeforinger
            SET status = 'avvist', begrunnelse = $1, endret_av = $2, endret_tid = now()
          WHERE id = $3
         RETURNING ${TIMER_KOLONNER}`,
        [begrunnelse, req.user.id, id]
      )).rows[0];
      return { kode: 200, timeforing: oppdatert };
    });
    if (utfall.kode === 404) return res.status(404).json({ error: 'Foring ikke funnet' });
    if (utfall.kode === 409) {
      return res.status(409).json({ error: 'Bare en innsendt foring kan avvises.' });
    }
    auditTimer(req.user, 'regnskap.timer.avvis', { id, begrunnelse });
    res.json({ timeforing: utfall.timeforing });
  } catch (e) {
    console.error('regnskap /timer avvis feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke avvise foring' });
  }
});

// POST /timer/:id/korriger  (body: timer PAAKREVD, begrunnelse VALGFRI) — ENESTE
// vei "inn i" en laast foring. Oppretter en NY rad med korrigerer_id = original.id
// (kan ha NEGATIVE timer for aa trekke fra), status='sendt_inn', opprettet_av =
// admin. Den LAASTE originalen er UROERT — historikken staar. Den nye raden maa
// selv godkjennes/laases. FOR UPDATE paa originalen serialiserer mot samtidige
// korreksjoner. Korreksjon gjelder KUN en laast rad (ellers 409 — en ulaast
// foring redigeres direkte via PATCH).
router.post('/timer/:id/korriger', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  const b = req.body || {};
  const timer = gyldigKorreksjonstimer(b.timer);
  if (timer == null) return res.status(400).json({ error: 'Ugyldig korreksjons-timetall (ikke 0, innen +/- 24)' });
  const begrunnelse = typeof b.begrunnelse === 'string' && b.begrunnelse.trim() ? b.begrunnelse.trim() : null;
  try {
    const utfall = await db.withTransaction(async (client) => {
      const orig = (await client.query(
        'SELECT id, ansatt_id, dato, aktivitet, status FROM timeforinger WHERE id = $1 FOR UPDATE',
        [id]
      )).rows[0];
      if (!orig) return { kode: 404 };
      if (orig.status !== 'laast') return { kode: 409 };
      const ny = (await client.query(
        `INSERT INTO timeforinger
           (ansatt_id, dato, timer, aktivitet, notat, status, korrigerer_id, opprettet_av, begrunnelse)
         VALUES ($1,$2,$3,$4,$5,'sendt_inn',$6,$7,$8)
         RETURNING ${TIMER_KOLONNER}`,
        [orig.ansatt_id, orig.dato, timer, orig.aktivitet,
          `Korreksjon av foring #${orig.id}`, orig.id, req.user.id, begrunnelse]
      )).rows[0];
      return { kode: 201, timeforing: ny, ansatt_id: orig.ansatt_id };
    });
    if (utfall.kode === 404) return res.status(404).json({ error: 'Foring ikke funnet' });
    if (utfall.kode === 409) {
      return res.status(409).json({ error: 'Bare en laast foring korrigeres. Rediger en ulaast foring direkte.' });
    }
    auditTimer(req.user, 'regnskap.timer.korriger', {
      original_id: id, ny_id: utfall.timeforing.id, ansatt_id: utfall.ansatt_id, timer,
    });
    res.status(201).json({ timeforing: utfall.timeforing });
  } catch (e) {
    console.error('regnskap /timer korriger feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke opprette korreksjon' });
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

// ---------- FIKEN-OVERFORING ----------
router.get('/fiken/status', async (_req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  try {
    const r = await db.one(
      `SELECT COUNT(*)::int AS antall
         FROM regnskap_poster
        WHERE fiken_status = 'ikke_sendt'`
    );
    res.json({ konfigurert: fiken.isConfigured(), antall_usendt: r.antall });
  } catch (e) {
    console.error('regnskap /fiken/status feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente Fiken-status' });
  }
});

router.post('/fiken/send', async (_req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  try {
    const { rows } = await db.query(
      `SELECT id, type, dato, kontakt, beskrivelse, konto, mva_kode, mva_sats,
              netto_ore, mva_ore, brutto_ore, betalingsmetode, bilag, kilde, fiken_status
         FROM regnskap_poster
        WHERE fiken_status = 'ikke_sendt'
        ORDER BY dato ASC, id ASC`
    );
    let sendt = 0, feilet = 0, simulert = 0;
    // Sekvensielt pga Fikens rate limit (maks ~1 request/sek) — IKKE parallelt.
    for (const post of rows) {
      const resultat = post.type === 'inntekt'
        ? await fiken.sendSalg(post)
        : await fiken.sendKjop(post);
      if (resultat && resultat.ok) {
        // Fase 4: persistér saleId (fra Fiken Location-header). Uten den kan
        // bilaget ikke reverseres senere (Fiken-delete krever saleId).
        await db.query(
          `UPDATE regnskap_poster SET fiken_status = 'sendt', fiken_id = $2 WHERE id = $1`,
          [post.id, resultat.fikenId != null ? String(resultat.fikenId) : null]
        );
        sendt += 1;
      } else if (resultat && resultat.simulert) {
        simulert += 1;
      } else {
        feilet += 1;
      }
    }
    res.json({ sendt, feilet, simulert, konfigurert: fiken.isConfigured() });
  } catch (e) {
    console.error('regnskap /fiken/send feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke sende til Fiken' });
  }
});

// ---------- REGNSKAPSPAKKE (Fase 3b: leverings-ruta) ----------
// GET /pakke/:maaned  ->  { pakke, manifest }
// ADMIN-ONLY: hele ruteren er admin-only (router.use over). Denne route-nivaa
// requireRole('admin') beholdes som belte-og-seler + intensjons-dokumentasjon.
// Ruta henter en maneds regnskapsdata, kaller den rene generatoren
// (lib/regnskapspakke.js), og returnerer en validert, PII-fri, HMAC-signert
// pakke som JSON. ZIP/vedlegg-streaming er BEVISST utenfor scope (senere fase).
router.get('/pakke/:maaned', requireRole('admin'), pakkeGate, async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);

  const maaned = gyldigMaaned(req.params.maaned);
  if (!maaned) {
    return res.status(400).json({ error: 'Ugyldig maaned. Bruk formatet YYYY-MM.' });
  }

  try {
    // Poster: KUN forretningskolonnene generatoren bruker — IKKE SELECT *, som
    // ville dratt med kontakt/vedlegg (PII/tung). Reduser PII-flaten allerede i
    // sporringen (belte-og-seler med generatorens egen whitelist).
    const poster = (await db.query(
      `SELECT id, type, dato, beskrivelse, konto, mva_sats,
              netto_ore, mva_ore, brutto_ore, betalingsmetode, kilde, booking_id
         FROM regnskap_poster
        WHERE to_char(dato,'YYYY-MM') = $1
        ORDER BY dato ASC, id ASC`,
      [maaned]
    )).rows;

    // Timegrunnlag: timeforinger for maneden + aktive ansatte (id -> timelonn/konto).
    const timeforinger = (await db.query(
      `SELECT id, ansatt_id, dato, timer
         FROM timeforinger
        WHERE to_char(dato,'YYYY-MM') = $1
        ORDER BY dato ASC, id ASC`,
      [maaned]
    )).rows;

    const ansatte = (await db.query(
      `SELECT id, timelonn_ore, konto
         FROM ansatte
        WHERE aktiv = true
        ORDER BY id ASC`
    )).rows;

    // Dagsoppgjor: tabellen finnes men er trolig TOM til «lukk dagen»-flyten
    // bygges. Generatoren tar tom liste (invariant 2 hopper over da).
    const dagsoppgjor = (await db.query(
      `SELECT dato, brutto_ore, mva_ore, antall_bilag, lukket_tid
         FROM dagsoppgjor
        WHERE to_char(dato,'YYYY-MM') = $1
        ORDER BY dato ASC`,
      [maaned]
    )).rows;

    // Generatoren KASTER ved invariant-brudd (ubalansert sum, float, PII, ukjent
    // type). Det er en DATATILSTAND operatoren maa rette, ikke en serverfeil ->
    // 422, ikke 500. Date-kallet horer hjemme HER (i kalleren), ikke i den rene
    // funksjonen.
    let pakke;
    try {
      pakke = byggRegnskapspakke({
        periode: maaned,
        poster,
        dagsoppgjor,
        timeforinger,
        ansatte,
        generert: new Date().toISOString(),
      });
    } catch (genFeil) {
      logger.warn(
        { maaned, feil: genFeil && genFeil.message },
        'regnskapspakke: generator avviste manedens data'
      );
      return res.status(422).json({
        error: 'Manedens regnskapsdata kan ikke pakkes: den balanserer ikke eller '
          + 'inneholder persondata. Rett postene for maneden og prov igjen.',
        detalj: genFeil && genFeil.message,
      });
    }

    // Kanonisk serialisering: NOYAKTIG denne strengen (utf8-bytes) hashes OG
    // signeres. Del 2 MAA hashe bit-for-bit samme bytes for aa verifisere. Vi
    // sender `pakke`-objektet uendret i svaret; en klient som gjor
    // JSON.stringify(body.pakke) reproduserer samme streng (JSON bevarer
    // innsettingsrekkefolge, og alle belop er heltall — ingen float-formattering).
    const kanonisk = JSON.stringify(pakke);
    const sha256 = crypto.createHash('sha256').update(kanonisk, 'utf8').digest('hex');

    const manifest = {
      algoritme: 'sha256',
      sha256,
      signatur_algoritme: 'HMAC-SHA256',
      periode: pakke.periode,
      schema_version: pakke.schema_version,
      antall_bilag: pakke.kontrollsum.antall_bilag,
      generert: pakke.generert,
    };

    // Uten secret: IKKE 500. Folg kodebasens degraderingsmonster (jf. e-post ->
    // "simulert"): pakken leveres USIGNERT, og vi advarer tydelig.
    const secret = process.env.REGNSKAP_PAKKE_SECRET;
    if (secret) {
      manifest.signatur = crypto.createHmac('sha256', secret).update(kanonisk, 'utf8').digest('hex');
      manifest.signert = true;
    } else {
      manifest.signatur = null;
      manifest.signert = false;
      logger.warn(
        { maaned },
        'REGNSKAP_PAKKE_SECRET mangler — regnskapspakken leveres USIGNERT. '
        + 'Sett env-en for at del 2 skal kunne verifisere signaturen.'
      );
    }

    // Audit hver nedlasting. Fire-and-forget: en audit-feil skal ALDRI velte
    // svaret (writeAudit svelger allerede egne feil, men vi .catch for sikkerhet).
    Promise.resolve(
      writeAudit(req.user, 'regnskap.pakke.hent', {
        periode: maaned,
        antall_bilag: pakke.kontrollsum.antall_bilag,
        signert: manifest.signert,
      })
    ).catch(() => {});

    res.json({ pakke, manifest });
  } catch (e) {
    logger.error({ feil: e && e.message }, 'regnskap /pakke feilet');
    res.status(500).json({ error: 'Kunne ikke bygge regnskapspakke' });
  }
});

// ---------- DAGSOPPGJOR (Fase 5: «lukk dagen») ----------
// POST /dagsoppgjor/:dato  -> lukk en kalenderdag (admin-only, append-only).
// GET  /dagsoppgjor?maaned=YYYY-MM -> lukkede dager for maneden.
//
// KRITISK KOBLING til regnskapspakke-generatoren: dagsoppgjor.brutto_ore MAA
// regnes med SAMME konvensjon som bilagslaget i lib/regnskapspakke.js, dvs.
// summen av ABSOLUTTVERDIER (SUM(ABS(brutto_ore))). En refusjon lagres negativt
// i regnskap_poster, men generatoren baerer den som POSITIVT belop (handling
// 'kreditering'). Regner vi her uten ABS, ville generatorens invariant 2
// (Sigma dagsoppgjor.brutto_ore == kontrollsum.brutto_ore) briste og GET
// /pakke/:maaned kaste 422 paa en lukket dag. Derfor ABS her — samme tall
// generatoren bruker.

// Admin-only: hele ruteren er admin-only (router.use over). Denne route-nivaa
// requireRole('admin') beholdes som belte-og-seler + intensjons-dokumentasjon.
router.post('/dagsoppgjor/:dato', requireRole('admin'), async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);

  const dato = gyldigDato(req.params.dato);
  if (!dato) return res.status(400).json({ error: 'Ugyldig dato. Bruk formatet YYYY-MM-DD.' });

  // Fallback-kjede for hvem som lukket (req.user finnes garantert etter requireRole).
  const lukketAv = req.user.navn || req.user.epost || String(req.user.id);

  try {
    // Alt i EN transaksjon: les dagens summer og INSERT sammen, saa to samtidige
    // lukkinger serialiseres. Race-sikkerheten hviler til slutt paa dato UNIQUE +
    // ON CONFLICT DO NOTHING (den taperen faar rowCount 0 -> 409), IKKE paa
    // rekkefolgen av lesning. null tilbake = allerede lukket.
    const rad = await db.withTransaction(async (client) => {
      // Dagens kontrollsummer. ABS fordi refusjon lagres negativt — MATCHER
      // generatorens brutto-gjennomstromning (se blokk-kommentar over).
      const sum = (await client.query(
        `SELECT COALESCE(SUM(ABS(brutto_ore)),0)::int AS brutto_ore,
                COALESCE(SUM(ABS(mva_ore)),0)::int   AS mva_ore,
                COUNT(*)::int                        AS antall_bilag
           FROM regnskap_poster
          WHERE dato = $1::date`,
        [dato]
      )).rows[0];

      const ins = await client.query(
        `INSERT INTO dagsoppgjor (dato, lukket_av, lukket_tid, brutto_ore, mva_ore, antall_bilag)
         VALUES ($1::date, $2, now(), $3, $4, $5)
         ON CONFLICT (dato) DO NOTHING
         RETURNING dato, brutto_ore, mva_ore, antall_bilag, lukket_av, lukket_tid`,
        [dato, lukketAv, sum.brutto_ore, sum.mva_ore, sum.antall_bilag]
      );
      // rowCount 0 = ON CONFLICT slo til (dagen finnes allerede) -> append-only-brudd.
      return ins.rowCount ? ins.rows[0] : null;
    });

    if (!rad) {
      return res.status(409).json({
        error: 'Dagen er allerede lukket. Et dagsoppgjor er append-only og kan ikke lukkes to ganger.',
      });
    }

    // Fire-and-forget audit (writeAudit svelger egne feil; .catch for sikkerhet).
    Promise.resolve(
      writeAudit(req.user, 'regnskap.dagsoppgjor.lukk', {
        dato, brutto_ore: rad.brutto_ore, antall_bilag: rad.antall_bilag,
      })
    ).catch(() => {});

    res.status(201).json(rad);
  } catch (e) {
    // Belte-og-seler: hvis en DB ikke skulle fange ON CONFLICT og i stedet kaster
    // unique-violation (23505), oversett ogsaa DET til 409 (ikke 500).
    if (e && e.code === '23505') {
      return res.status(409).json({
        error: 'Dagen er allerede lukket. Et dagsoppgjor er append-only og kan ikke lukkes to ganger.',
      });
    }
    console.error('regnskap /dagsoppgjor POST feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lukke dagen' });
  }
});

// GET: lukkede dager for en maned. Admin-only via ruterens router.use — som
// alt annet under /api/regnskap etter blocker-2-fiksen (bolge 98). Lese-ruta
// trenger ingen egen route-nivaa gate.
router.get('/dagsoppgjor', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  if (!maaned) return res.status(400).json({ error: 'Mangler gyldig maaned (YYYY-MM)' });
  try {
    const { rows } = await db.query(
      `SELECT dato, brutto_ore, mva_ore, antall_bilag, lukket_av, lukket_tid
         FROM dagsoppgjor
        WHERE to_char(dato,'YYYY-MM') = $1
        ORDER BY dato ASC`,
      [maaned]
    );
    res.json(rows);
  } catch (e) {
    console.error('regnskap /dagsoppgjor GET feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente dagsoppgjor' });
  }
});

module.exports = router;
