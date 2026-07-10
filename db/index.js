/* Havstund — databaselag (PostgreSQL via pg).
   Bruker DATABASE_URL (Railway Postgres). Uten den booter serveren,
   men DB-funksjoner er av (offentlig side virker fortsatt). */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sentry = require('../lib/sentry');
const { logger } = require('../lib/logger');

const url = process.env.DATABASE_URL;
let pool = null;

if (url) {
  pool = new Pool({
    connectionString: url,
    // Railway/managed Postgres bruker ofte selvsignert sert.
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });
  // F51: idle-client-feil fra poolen rutes via strukturert logger + Sentry
  // (ikke raa console.error). Handleren maa ALDRI kaste — en feil her ville
  // ellers boble opp som en uncaught 'error' paa poolen. Derfor try/catch rundt
  // begge kall (bade logger og sentry er allerede definert som kaster-aldri).
  pool.on('error', (e) => {
    try {
      logger.error({ err: e }, 'PG pool-feil (idle client)');
    } catch (_) {
      // logging skal aldri velte prosessen
    }
    try {
      sentry.captureException(e, { tags: { scope: 'pg-pool' } });
    } catch (_) {
      // Sentry skal aldri velte prosessen
    }
  });
}

// Intern degradert-tilstand: settes hvis DB svarer, men skjema/seed-init feilet.
// Lekkes ALDRI i det offentlige /api/health-svaret (kun generisk "degraded").
let degradert = false;
let initFeilmelding = null;

function isConfigured() {
  return !!pool;
}

// True hvis init() feilet mens DB ellers er pingbar (skjema/seed-feil).
function isDegraded() {
  return degradert;
}

// Ekte helsesjekk: pinger databasen OG verifiserer at kjerneskjemaet finnes.
// Kaster ved DB-feil (eller hvis DATABASE_URL mangler), slik at /api/health
// kan svare 503. Returnerer true når databasen svarer OG kjernetabellen finnes.
//
// F47: `SELECT 1` beviser bare at DB-motoren svarer — den sier INGENTING om at
// skjemaet er lastet. En db der migrasjonen feilet (ingen tabeller) svarer glatt
// på SELECT 1, og en shallow helsesjekk ville da rapportert "oppe" mens appen i
// praksis er ødelagt. Derfor sjekker vi at kjernetabellen `users` finnes via
// `to_regclass('public.users')`: et billig katalog-oppslag som returnerer NULL
// (i stedet for å kaste) når tabellen mangler. NULL => skjema ikke initialisert
// => kast, slik at /api/health kan svare 503. to_regclass er en O(1) systeminfo-
// oppslag — den skanner ingen data og holder Railway-healthchecken rask.
async function ping() {
  await pool.query('SELECT 1');
  const { rows } = await pool.query("SELECT to_regclass('public.users') AS finnes");
  if (!rows.length || rows[0].finnes == null) {
    // Generisk feil — ping()-kasteren fanges av /api/health og oversettes til et
    // generisk offentlig svar; skjema-detaljer lekkes aldri (se linje 38).
    throw new Error('Kjerneskjema mangler: tabellen users finnes ikke');
  }
  return true;
}

async function query(text, params) {
  if (!pool) throw new Error('Database ikke konfigurert. Sett DATABASE_URL (Railway Postgres).');
  return pool.query(text, params);
}

// Henter én rad (eller null)
async function one(text, params) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

// Kjører fn(client) inne i en transaksjon på ÉN connection fra poolen.
// BEGIN → fn → COMMIT ved suksess; ROLLBACK + re-kast ved feil; alltid release.
// Klienten holder samme connection, så SELECT ... FOR UPDATE-låser består
// gjennom hele transaksjonen.
async function withTransaction(fn) {
  if (!pool) throw new Error('Database ikke konfigurert. Sett DATABASE_URL (Railway Postgres).');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // svelg rollback-feil; den opprinnelige feilen re-kastes under
    }
    throw e;
  } finally {
    client.release();
  }
}

// F45: manglende fremmednokler som legges paa idempotent ETTER at schema.sql er
// lastet. Ligger HER (i JS) og ikke i schema.sql med vilje: Postgres har ingen
// `ADD CONSTRAINT IF NOT EXISTS` for FK-er, saa idempotens krever en betinget
// `pg_constraint`-sjekk. I ren SQL ville det krevd en `DO $$ ... $$`-blokk
// (plpgsql) — og pg-mem (som integrasjonstesten laster hele schema.sql inn i)
// stotter IKKE plpgsql. Aa legge en DO-blokk i schema.sql ville dermed brutt den
// eksisterende booking-db.int.test.js. JS-guarden gir samme idempotens uten aa
// roere schemaet.
//
// Hver FK ryddes foreldreloest FORST (ellers feiler ADD CONSTRAINT paa levende
// data). Opprydding kjores kun naar constrainten faktisk mangler.
const FK_MIGRASJONER = [
  {
    navn: 'fk_project_media_bruker',
    tabell: 'project_media',
    kolonne: 'bruker_id',
    referanse: 'users(id)',
    onDelete: 'SET NULL',
    // foreldreloese: bruker_id peker paa en slettet/ikke-eksisterende bruker.
    opprydding:
      'UPDATE project_media SET bruker_id = NULL ' +
      'WHERE bruker_id IS NOT NULL AND bruker_id NOT IN (SELECT id FROM users)',
  },
  {
    navn: 'fk_receipts_booking',
    tabell: 'receipts',
    kolonne: 'booking_id',
    referanse: 'bookings(id)',
    onDelete: 'SET NULL',
    opprydding:
      'UPDATE receipts SET booking_id = NULL ' +
      'WHERE booking_id IS NOT NULL AND booking_id NOT IN (SELECT id FROM bookings)',
  },
  {
    navn: 'fk_reset_tokens_user',
    tabell: 'reset_tokens',
    kolonne: 'user_id',
    referanse: 'users(id)',
    onDelete: 'CASCADE',
    // CASCADE: token skal ryddes naar brukeren slettes. Foreldreloese tokens
    // (bruker finnes ikke) OG utloepte tokens slettes foer FK legges paa.
    opprydding:
      'DELETE FROM reset_tokens ' +
      'WHERE (user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)) ' +
      'OR (utloper IS NOT NULL AND utloper < now())',
  },
];

// Legger paa FK_MIGRASJONER idempotent. Tar en query-funksjon (q) slik at den
// kan drives bade av produksjonspoolen og av pg-mem i test. Kaster videre ved
// feil — init() sin try/catch fanger og markerer degradert (appen serves videre).
async function migrate(q) {
  // F44: dedupe availability FORST, deretter unik-indeksen. Flyttet hit fra
  // schema.sql (2026-07-09): en ubetinget DELETE i schema.sql kjorte ved HVER
  // boot og ryddet kalenderplasser i prod uten aa si fra. Her i JS teller vi
  // faktisk-slettede rader (rowCount) og logger kun naar noe ble ryddet.
  //
  // Dedupe-strategi: behold raden med LAVEST id per (activity_id, dato, tid).
  // Deterministisk og natur-idempotent (andre kjoring sletter 0). Ingen andre
  // tabeller peker paa availability.id, saa det river ingen bookinger; en admin
  // kan uansett re-lagre slotene via PUT /api/availability.
  //
  // MERK NULL-asymmetri: availability.activity_id er NULLABLE. Postgres teller
  // NULL som DISTINCT i en unik-indeks, saa uq_availability_slot hindrer IKKE
  // duplikate rader der activity_id IS NULL — men GROUP BY-dedupen under
  // grupperer NULL-ene sammen og fjerner dem likevel. (Rapportert til operator:
  // vurder NOT NULL paa activity_id — men det er en atferdsendring paa levende
  // data og gjores ikke her.)
  const dedupe = await q(
    'DELETE FROM availability WHERE id NOT IN (' +
      'SELECT keep_id FROM (' +
      'SELECT MIN(id) AS keep_id FROM availability GROUP BY activity_id, dato, tid' +
      ') q)'
  );
  const slettet = dedupe && typeof dedupe.rowCount === 'number' ? dedupe.rowCount : 0;
  if (slettet > 0) {
    logger.warn(
      { antall: slettet, tabell: 'availability' },
      'F44 dedupe: fjernet duplikate availability-slots for unik-indeks'
    );
  } else {
    logger.debug({ tabell: 'availability' }, 'F44 dedupe: ingen duplikater');
  }
  await q(
    'CREATE UNIQUE INDEX IF NOT EXISTS uq_availability_slot ' +
      'ON availability(activity_id, dato, tid)'
  );

  // Fase 2 (2.3): strukturert kjoperadresse paa bookings. Additive og NULLABLE.
  // Ligger HER og ikke i schema.sql fordi `CREATE TABLE IF NOT EXISTS bookings`
  // hopper over hele tabellen naar den finnes — nye kolonner i definisjonen naar
  // dermed aldri en levende db. `ADD COLUMN IF NOT EXISTS` er idempotent i
  // Postgres (kaster ikke 2. gang) og krever ingen DO-blokk, saa pg-mem takler
  // det. init() kjorer schema.sql FOER migrate(), saa kolonnene finnes uansett
  // for ferske databaser (via CREATE TABLE) naar denne kjorer.
  await q('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS adr_gate TEXT');
  await q('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS adr_postnr TEXT');
  await q('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS adr_poststed TEXT');
  await q('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS adr_land TEXT');

  // Fase 4: Fiken-reverserbarhet. Nye kolonner paa EKSISTERENDE tabeller maa
  // ligge her (ikke i schema.sql) — CREATE TABLE IF NOT EXISTS hopper over hele
  // tabellen naar den finnes, saa en ny kolonne i definisjonen naar aldri en
  // levende db. ADD COLUMN IF NOT EXISTS er idempotent uten DO-blokk (pg-mem OK).
  //   - regnskap_poster.fiken_id: saleId fra Fiken (Location-header ved send).
  //     Uten persistert saleId kan et bilag ikke reverseres (Fiken-delete krever
  //     saleId). Kalleren (routes/regnskap.js /fiken/send) lagrer den.
  //   - bookings.fiken_sale_id / fiken_sale_number: gjeldende aktive bilag +
  //     versjonert idempotens-noekkel (HAV-booking-<id>-v<n>) for delete+repost.
  //     Additive og NULLABLE; inerte til Fiken-adapteren aktiveres (isConfigured).
  await q('ALTER TABLE regnskap_poster ADD COLUMN IF NOT EXISTS fiken_id TEXT');
  await q('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fiken_sale_id TEXT');
  await q('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fiken_sale_number TEXT');

  for (const fk of FK_MIGRASJONER) {
    const { rows } = await q('SELECT 1 FROM pg_constraint WHERE conname = $1', [fk.navn]);
    if (rows.length) continue; // constrainten finnes allerede — hopp over
    await q(fk.opprydding); // rydd foreldreloese FORST
    await q(
      `ALTER TABLE ${fk.tabell} ADD CONSTRAINT ${fk.navn} ` +
        `FOREIGN KEY (${fk.kolonne}) REFERENCES ${fk.referanse} ON DELETE ${fk.onDelete}`
    );
  }

  // ===== Bolge 98: ansatt-timeforing FUNDAMENT (lonns-sti) =====
  // Lukker 2 av 3 verifiserte blockere: (1) entydig bruker<->ansatt-kobling,
  // (3) status-maskin paa timeforinger slik at en UGODKJENT time ALDRI naar
  // Fiken-lonn. Alt additivt/idempotent; INGEN eksisterende demorad forsvinner.

  // --- Blocker 3 (del): status-maskin-kolonner paa timeforinger.
  // Rekkefolge: kolonnene FORST (kjerne-pengesti), deretter unik-indeks +
  // epost-kobling. ADD COLUMN IF NOT EXISTS kan ikke feile paa skitne data, saa
  // en uventet feil i kobling-loopen under blokkerer aldri disse.
  //
  // Tilstander (status-maskin):
  //   utkast -> sendt_inn -> godkjent -> laast   (normalflyt)
  //   avvist = sidespor tilbake til utkast (avvist foring redigeres og sendes paa nytt)
  // Kun 'godkjent' og 'laast' teller i lonnsgrunnlaget (se byggTimegrunnlag).
  //
  // KRITISK default: status DEFAULT 'godkjent'. Eksisterende demorader har ingen
  // status; med default 'utkast' ville de FORSVINNE ut av lonnsgrunnlaget etter
  // at filteret i regnskapspakke slaar til. 'godkjent' beskytter historikken —
  // nye foringer settes eksplisitt til 'utkast' av rute-laget (annen agent).
  await q("ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'godkjent'");
  await q('ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS godkjent_av INTEGER REFERENCES users(id)');
  await q('ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS godkjent_tid TIMESTAMPTZ');
  await q('ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS begrunnelse TEXT');
  await q('ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS laast_tid TIMESTAMPTZ');
  await q('ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS korrigerer_id INTEGER REFERENCES timeforinger(id)');
  await q('ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS opprettet_av INTEGER REFERENCES users(id)');
  await q('ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS endret_av INTEGER REFERENCES users(id)');
  await q('ALTER TABLE timeforinger ADD COLUMN IF NOT EXISTS endret_tid TIMESTAMPTZ');
  await q('CREATE INDEX IF NOT EXISTS idx_timer_status ON timeforinger(status)');

  // --- Blocker 1 (del): unik ansatte.user_id.
  // VALG: CREATE UNIQUE INDEX (ikke ADD CONSTRAINT ... UNIQUE). Begrunnelse:
  //   * Enforcement-ekvivalent i Postgres — hindrer to ansatte fra aa dele samme
  //     user_id, og tillater flere NULL (Postgres teller NULL som DISTINCT i unik-
  //     indeks; ukoblede rader forblir NULL). Verifisert i pg-mem.
  //   * Natur-idempotent via IF NOT EXISTS — trenger INGEN pg_constraint-guard.
  //     VIKTIG: `ADD CONSTRAINT ... UNIQUE` er IKKE re-kjorbar i pg-mem (kaster
  //     "relation already exists" ved 2. kjoring, siden UNIQUE lager en backing-
  //     indeks-relasjon), og pg_constraint-guarden er inert i pg-mem (returnerer
  //     0). En ADD CONSTRAINT her ville dermed brutt migrate()-2x-idempotensen
  //     som hele int-testsuiten hviler paa. (FK-ene taaler re-add i pg-mem; UNIQUE
  //     gjor det ikke — derfor avviker denne fra F45-monsteret med vilje.)
  //   * Samme monster som F44 uq_availability_slot rett over.
  //
  // DEFENSIVT (lonns-sti, konservativt): hvis levende data ALLEREDE har duplikate
  // ikke-NULL user_id, ville CREATE UNIQUE INDEX KASTE og velte hele migrate()
  // (=> degradert drift). Vi deduper IKKE ansatte automatisk (aa slette/omskrive
  // en lonnsmottaker er destruktivt og feil). I stedet: oppdag, LOGG hoylytt, og
  // hopp over indeksen. Operator rydder manuelt. Ingen stille auto-handling.
  // Dup-deteksjon UTEN `HAVING` (pg-mem stotter ikke HAVING): sammenlign antall
  // ikke-NULL user_id mot antall DISTINCT user_id. total > distinct => duplikater.
  // Subquery-med-GROUP-BY-monsteret speiler availability-dedupen over og virker i
  // bade pg-mem og ekte Postgres.
  const totalRes = await q(
    'SELECT COUNT(*)::int AS n FROM ansatte WHERE user_id IS NOT NULL'
  );
  const distinctRes = await q(
    'SELECT COUNT(*)::int AS n FROM ' +
      '(SELECT user_id FROM ansatte WHERE user_id IS NOT NULL GROUP BY user_id) g'
  );
  const total = (totalRes.rows[0] && totalRes.rows[0].n) || 0;
  const distinct = (distinctRes.rows[0] && distinctRes.rows[0].n) || 0;
  if (total > distinct) {
    logger.warn(
      { total, distinct, tabell: 'ansatte' },
      'ansatte.user_id har duplikate ikke-NULL verdier — uq_ansatte_user_id IKKE opprettet. Operator maa rydde manuelt.'
    );
  } else {
    await q('CREATE UNIQUE INDEX IF NOT EXISTS uq_ansatte_user_id ON ansatte(user_id)');
  }

  // --- Blocker 1 (del): engangs-kobling ansatte.user_id via ENTYDIG epost-match.
  // Kjorer ETTER unik-indeksen. For hver ukoblet ansatt (user_id IS NULL) med
  // epost: sett user_id til den ENE users-raden med samme epost (case-insensitivt)
  // — men KUN naar treffet er entydig i BEGGE retninger:
  //   (a) noyaktig 1 users-rad matcher eposten, OG
  //   (b) noyaktig 1 ukoblet ansatt har den eposten (ellers ville to ansatte
  //       kjempe om samme user_id og bryte unik-indeksen), OG
  //   (c) den brukeren er ikke allerede koblet til en annen ansatt.
  // Tvetydige (0 eller >1 match) GJETTES ALDRI — NULL staar, og antall uklarte
  // logges. Idempotent: 2. kjoring finner faerre ukoblede (allerede-satte har
  // user_id != NULL) og setter samme resultat. JS-loop (ikke UPDATE...FROM) for
  // eksplisitt entydighets-kontroll og forutsigbar oppforsel mot levende data.
  const ukoblede = await q(
    "SELECT id, epost FROM ansatte WHERE user_id IS NULL AND epost IS NOT NULL AND epost <> ''"
  );
  let koblet = 0;
  let uklare = 0;
  for (const rad of (ukoblede && ukoblede.rows) || []) {
    const epostLower = String(rad.epost).toLowerCase();
    // (b) entydig paa ansatte-siden: ingen annen ukoblet ansatt deler eposten.
    const ansattTreff = await q(
      'SELECT COUNT(*)::int AS n FROM ansatte WHERE user_id IS NULL AND LOWER(epost) = $1',
      [epostLower]
    );
    if (((ansattTreff.rows[0] && ansattTreff.rows[0].n) || 0) !== 1) {
      uklare++;
      continue;
    }
    // (a) entydig paa users-siden: noyaktig 1 bruker med denne eposten.
    const brukerTreff = await q('SELECT id FROM users WHERE LOWER(epost) = $1', [epostLower]);
    if (!brukerTreff.rows || brukerTreff.rows.length !== 1) {
      uklare++;
      continue;
    }
    const uid = brukerTreff.rows[0].id;
    // (c) brukeren maa ikke allerede vaere koblet (verner unik-indeksen).
    const alt = await q('SELECT 1 FROM ansatte WHERE user_id = $1', [uid]);
    if (alt.rows && alt.rows.length) {
      uklare++;
      continue;
    }
    await q('UPDATE ansatte SET user_id = $1 WHERE id = $2 AND user_id IS NULL', [uid, rad.id]);
    koblet++;
  }
  if (koblet > 0) {
    logger.info(
      { koblet, tabell: 'ansatte' },
      'Bolge98 engangs-kobling: satte ansatte.user_id via entydig epost-match'
    );
  }
  if (uklare > 0) {
    logger.warn(
      { uklare, tabell: 'ansatte' },
      'Bolge98 engangs-kobling: uklare epost-treff (0 eller >1) — user_id forblir NULL, ingen gjetting'
    );
  }
}

async function init() {
  if (!pool) {
    console.warn('\n⚠  DATABASE_URL mangler — databasefunksjoner er AV.');
    console.warn('   Offentlig side virker. Legg til Postgres i Railway for full funksjon.\n');
    return;
  }
  try {
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await pool.query(schema);
    const seed = require('./seed');
    await seed({ query, one });
    await migrate(query); // F45: idempotente FK-migrasjoner (guardet mot ny kjoring)
    console.log('✓ Database klar (skjema + seed + migrasjoner)');
  } catch (e) {
    // DB svarer (poolen finnes), men skjema/seed gikk galt. Marker degradert
    // slik at /api/health kan rapportere det — men appen fortsetter å serve,
    // og vi utløser IKKE 503/restart-loop for en ren init-detalj.
    degradert = true;
    initFeilmelding = e && e.message ? e.message : String(e);
    console.error('✗ DB-init feilet (DB svarer — degradert drift):', initFeilmelding);
    try {
      sentry.captureException(e, { tags: { scope: 'db-init' } });
    } catch (_) {
      // Sentry skal aldri velte oppstart
    }
  }
}

module.exports = { pool, query, one, init, isConfigured, ping, withTransaction, isDegraded, migrate };
