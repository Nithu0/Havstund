/* Havstund — «Min side» for ansatte (/api/min/*). Bolge 98, steg 4 (lonns-sti).
   Selvbetjening: en ansatt ser og forer KUN sine EGNE timer. Motsatsen til
   /api/regnskap (admin-only), som ser alt.

   KJERNE-SIKKERHETSPRINSIPP (hele ruteren hviler paa dette):
     ansatt_id tas ALDRI fra body/query. Den UTLEDES fra req.ansatt.id, satt av
     hentAnsatt-middlewaren (ansatte WHERE user_id = req.user.id). Eierskap
     haandheves i SQL med WHERE ansatt_id = req.ansatt.id. En ansatt kan dermed
     aldri lese eller skrive en annens rad. Status settes ALLTID server-side —
     klienten kan ikke lofte en egen foring til 'godkjent'/'laast'.

   Statusmaskin (kolonner lagt av db/index.js:migrate):
     utkast -> sendt_inn -> godkjent -> laast   (normalflyt)
     avvist = sidespor tilbake til redigerbar (avvist foring rettes og sendes paa nytt)
   Redigerbar/slettbar KUN i tidlige tilstander (se REDIGERBAR/SLETTBAR). En
   PATCH/DELETE mot en laast/godkjent/sendt_inn rad -> 409. En rad som ikke er
   ens egen (eller ikke finnes) -> 404 (vi lekker ALDRI eksistensen av andres rader).

   GET    /timer?maaned=YYYY-MM   -> egne foringer (alle statuser)
   POST   /timer                  -> ny foring (status='utkast' ALLTID)
   PATCH  /timer/:id              -> rediger egen utkast/avvist
   DELETE /timer/:id              -> slett egen utkast
   POST   /timer/send-inn         -> send inn maanedens utkast+avvist
   GET    /lonn?maaned=YYYY-MM    -> egen sats + sum egne godkjente/laaste timer
   GET    /kalender?maaned=YYYY-MM-> egne foringer + apningstider + stengte dager */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');
const { hentAnsatt } = require('../lib/ansatt');

const router = express.Router();

// Rolle-gate FORST (ansatt|admin), deretter ansatt-oppslag. hentAnsatt setter
// req.ansatt og svarer 403 for en bruker uten koblet ansatt-rad — dermed virker
// ingen /api/min/*-rute uten en ekte ansatt-identitet. Rekkefolgen er bevisst:
// requireRole avviser fremmede roller (kunde/agent) FOER vi slaar opp ansatt.
router.use(requireRole('ansatt', 'admin'));
router.use(hentAnsatt);

// Tilstander som klienten selv kan endre/slette. Alt annet er «innsendt eller
// laast» og er utenfor den ansattes kontroll (admin eier de overgangene).
const REDIGERBAR = ['utkast', 'avvist'];
const SLETTBAR = ['utkast'];
// Kun disse teller i lonnsgrunnlaget — en ugodkjent time naar ALDRI lonn.
const TELLENDE = ['godkjent', 'laast'];

function utilgjengelig(res) {
  return res.status(503).json({ error: 'Min side er midlertidig utilgjengelig.' });
}

// YYYY-MM (streng). Returnerer strengen eller null.
function gyldigMaaned(m) {
  return typeof m === 'string' && /^\d{4}-\d{2}$/.test(m) ? m : null;
}

// Streng YYYY-MM-DD: format OG ekte kalenderdag (avviser 2026-13-40, 2026-02-30).
// Samme roundtrip-monster som routes/regnskap.js. Returnerer strengen eller null.
function gyldigDato(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === s ? s : null;
}

// Timer: NUMERIC, > 0, rimelig tak (<= 24t/dag). Returnerer tallet eller null.
function gyldigTimer(v) {
  const t = Number(v);
  if (!Number.isFinite(t) || t <= 0 || t > 24) return null;
  return t;
}

const TIMER_KOLONNER =
  'id, ansatt_id, dato, timer, aktivitet, notat, status, ' +
  'godkjent_tid, laast_tid, begrunnelse, endret_tid, opprettet';

// ---------- GET /timer (egne foringer, alle statuser) ----------
router.get('/timer', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const ansattId = req.ansatt.id;
  const maaned = gyldigMaaned(req.query.maaned);
  const verdier = [ansattId];
  let where = 'WHERE ansatt_id = $1';
  if (maaned) { verdier.push(maaned); where += ` AND to_char(dato,'YYYY-MM') = $${verdier.length}`; }
  try {
    const { rows } = await db.query(
      `SELECT ${TIMER_KOLONNER} FROM timeforinger ${where} ORDER BY dato DESC, id DESC`,
      verdier
    );
    res.json(rows);
  } catch (e) {
    console.error('min /timer GET feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente timer' });
  }
});

// ---------- POST /timer (ny foring — ALLTID utkast, ALLTID egen) ----------
router.post('/timer', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const b = req.body || {};
  const dato = gyldigDato(b.dato);
  if (!dato) return res.status(400).json({ error: 'Ugyldig dato (YYYY-MM-DD)' });
  const timer = gyldigTimer(b.timer);
  if (timer == null) return res.status(400).json({ error: 'Ugyldig timetall (> 0 og <= 24)' });

  // ansatt_id UTLEDES fra req.ansatt.id — ALDRI fra b.ansatt_id. status bindes
  // til konstanten 'utkast' server-side: klienten kan ikke sette den (selv om
  // b.status finnes, ignoreres den). opprettet_av = den innloggede brukeren.
  const ansattId = req.ansatt.id;
  try {
    const t = await db.one(
      `INSERT INTO timeforinger (ansatt_id, dato, timer, aktivitet, notat, status, opprettet_av)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${TIMER_KOLONNER}`,
      [ansattId, dato, timer, b.aktivitet || null, b.notat || null, 'utkast', req.user.id]
    );
    res.status(201).json({ timeforing: t });
  } catch (e) {
    console.error('min /timer POST feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke lagre timer' });
  }
});

// ---------- PATCH /timer/:id (rediger egen utkast/avvist) ----------
// 404-vs-403-valget: en rad som IKKE er ens egen (eller ikke finnes) gir 404 —
// vi bekrefter ALDRI at en annens rad eksisterer. En egen rad i feil tilstand
// (sendt_inn/godkjent/laast) gir 409. status settes ALDRI fra klient.
router.patch('/timer/:id', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  const b = req.body || {};

  // Bygg SET-lista av KUN redigerbare felt. status/ansatt_id er bevisst utelatt.
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

  // Sporbarhet: hvem endret + naar. Alltid med.
  verdier.push(req.user.id); felt.push(`endret_av = $${verdier.length}`);
  felt.push('endret_tid = now()');

  const ansattId = req.ansatt.id;
  try {
    // Les-sjekk-skriv i EN transaksjon med FOR UPDATE, saa to samtidige endringer
    // paa samme rad serialiseres (tilstands-sjekken kan ikke omgaas av et race).
    const utfall = await db.withTransaction(async (client) => {
      const rad = (await client.query(
        'SELECT id, status FROM timeforinger WHERE id = $1 AND ansatt_id = $2 FOR UPDATE',
        [id, ansattId]
      )).rows[0];
      if (!rad) return { kode: 404 };                       // andres rad ELLER finnes ikke
      if (!REDIGERBAR.includes(rad.status)) return { kode: 409 }; // sendt_inn/godkjent/laast
      verdier.push(id);
      const pId = verdier.length;
      verdier.push(ansattId);
      const pAns = verdier.length;
      const oppdatert = (await client.query(
        `UPDATE timeforinger SET ${felt.join(', ')}
          WHERE id = $${pId} AND ansatt_id = $${pAns}
         RETURNING ${TIMER_KOLONNER}`,
        verdier
      )).rows[0];
      return { kode: 200, timeforing: oppdatert };
    });

    if (utfall.kode === 404) return res.status(404).json({ error: 'Foring ikke funnet' });
    if (utfall.kode === 409) {
      return res.status(409).json({ error: 'Foringen er sendt inn eller laast og kan ikke endres.' });
    }
    res.json({ timeforing: utfall.timeforing });
  } catch (e) {
    console.error('min /timer PATCH feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke oppdatere foring' });
  }
});

// ---------- DELETE /timer/:id (slett egen utkast) ----------
// Samme 404-vs-409-monster som PATCH: andres/ikke-funnet -> 404, egen men ikke
// 'utkast' (allerede sendt inn/godkjent/laast) -> 409.
router.delete('/timer/:id', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig id' });
  const ansattId = req.ansatt.id;
  try {
    const utfall = await db.withTransaction(async (client) => {
      const rad = (await client.query(
        'SELECT id, status FROM timeforinger WHERE id = $1 AND ansatt_id = $2 FOR UPDATE',
        [id, ansattId]
      )).rows[0];
      if (!rad) return { kode: 404 };
      if (!SLETTBAR.includes(rad.status)) return { kode: 409 };
      await client.query('DELETE FROM timeforinger WHERE id = $1 AND ansatt_id = $2', [id, ansattId]);
      return { kode: 200 };
    });

    if (utfall.kode === 404) return res.status(404).json({ error: 'Foring ikke funnet' });
    if (utfall.kode === 409) {
      return res.status(409).json({ error: 'Kun utkast kan slettes. Innsendte foringer maa admin haandtere.' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('min /timer DELETE feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke slette foring' });
  }
});

// ---------- POST /timer/send-inn (send inn maanedens utkast+avvist) ----------
// Loefter egne utkast/avvist for maaneden til sendt_inn. Filteret paa
// ansatt_id = req.ansatt.id garanterer at kun egne rader roeres. Godkjenning/
// laasing er admin sin overgang — den skjer ikke her.
router.post('/timer/send-inn', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const b = req.body || {};
  const maaned = gyldigMaaned(b.maaned);
  if (!maaned) return res.status(400).json({ error: 'Mangler gyldig maaned (YYYY-MM)' });
  const ansattId = req.ansatt.id;
  try {
    const { rows } = await db.query(
      `UPDATE timeforinger
          SET status = 'sendt_inn', endret_av = $1, endret_tid = now()
        WHERE ansatt_id = $2
          AND to_char(dato,'YYYY-MM') = $3
          AND status IN ('utkast','avvist')
        RETURNING id`,
      [req.user.id, ansattId, maaned]
    );
    res.json({ oppdatert: rows.length, ids: rows.map((r) => r.id) });
  } catch (e) {
    console.error('min /timer/send-inn feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke sende inn timer' });
  }
});

// ---------- GET /lonn (egen sats + sum egne godkjente/laaste timer) ----------
// KUN egen sats (req.ansatt.timelonn_ore) og KUN sum av egne TELLENDE timer.
// Ingen andres tall naar noensinne hit — filteret er ansatt_id = req.ansatt.id.
router.get('/lonn', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  if (!maaned) return res.status(400).json({ error: 'Mangler gyldig maaned (YYYY-MM)' });
  const ansattId = req.ansatt.id;
  try {
    const rad = await db.one(
      `SELECT COALESCE(SUM(timer),0)::numeric AS sum_timer
         FROM timeforinger
        WHERE ansatt_id = $1
          AND to_char(dato,'YYYY-MM') = $2
          AND status IN ('godkjent','laast')`,
      [ansattId, maaned]
    );
    const sumTimer = Number(rad.sum_timer);
    // Satsen leses fra den ansattes egen rad (req.ansatt), ikke fra en spoerring
    // som kunne dratt med andres tall.
    const timelonnOre = Number(req.ansatt.timelonn_ore) || 0;
    res.json({
      maaned,
      ansatt_id: ansattId,
      navn: req.ansatt.navn,
      timelonn_ore: timelonnOre,
      sum_timer: sumTimer,
      brutto_ore: Math.round(sumTimer * timelonnOre),
      tellende_statuser: TELLENDE,
    });
  } catch (e) {
    console.error('min /lonn feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente lonnsgrunnlag' });
  }
});

// ---------- GET /kalender (egne foringer + apningstider + stengte dager) ----------
router.get('/kalender', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);
  const maaned = gyldigMaaned(req.query.maaned);
  if (!maaned) return res.status(400).json({ error: 'Mangler gyldig maaned (YYYY-MM)' });
  const ansattId = req.ansatt.id;
  try {
    const foringer = (await db.query(
      `SELECT id, dato, timer, aktivitet, notat, status
         FROM timeforinger
        WHERE ansatt_id = $1 AND to_char(dato,'YYYY-MM') = $2
        ORDER BY dato ASC, id ASC`,
      [ansattId, maaned]
    )).rows;
    // business_hours: fast ukentlig apningstid (ukedag 0=mandag .. 6=sondag).
    const apningstider = (await db.query(
      `SELECT ukedag, apner, stenger, stengt FROM business_hours ORDER BY ukedag`,
      []
    )).rows;
    // closed_dates: enkeltdatoer som overstyrer (helligdager/ferie) — kun maaneden.
    const stengteDager = (await db.query(
      `SELECT dato, grunn FROM closed_dates
        WHERE to_char(dato,'YYYY-MM') = $1
        ORDER BY dato ASC`,
      [maaned]
    )).rows;
    res.json({ maaned, foringer, apningstider, stengte_dager: stengteDager });
  } catch (e) {
    console.error('min /kalender feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente kalender' });
  }
});

module.exports = router;
