/* Havstund — databaselag (PostgreSQL via pg).
   Bruker DATABASE_URL (Railway Postgres). Uten den booter serveren,
   men DB-funksjoner er av (offentlig side virker fortsatt). */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const sentry = require('../lib/sentry');

const url = process.env.DATABASE_URL;
let pool = null;

if (url) {
  pool = new Pool({
    connectionString: url,
    // Railway/managed Postgres bruker ofte selvsignert sert.
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (e) => console.error('PG pool-feil:', e.message));
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
    console.log('✓ Database klar (skjema + seed)');
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

module.exports = { pool, query, one, init, isConfigured, ping, withTransaction, isDegraded };
