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

// Ekte helsesjekk: pinger databasen med en triviell SELECT 1.
// Kaster ved DB-feil (eller hvis DATABASE_URL mangler), slik at /api/health
// kan svare 503. Returnerer true når databasen faktisk svarer.
async function ping() {
  await pool.query('SELECT 1');
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
