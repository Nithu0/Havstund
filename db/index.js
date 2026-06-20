/* Havstund — databaselag (PostgreSQL via pg).
   Bruker DATABASE_URL (Railway Postgres). Uten den booter serveren,
   men DB-funksjoner er av (offentlig side virker fortsatt). */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

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

function isConfigured() {
  return !!pool;
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
    console.error('✗ DB-init feilet:', e.message);
  }
}

module.exports = { pool, query, one, init, isConfigured };
