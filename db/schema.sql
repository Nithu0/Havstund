-- Havstund — databaseskjema (PostgreSQL). Kjøres ved oppstart (idempotent).

CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  navn         TEXT NOT NULL,
  epost        TEXT UNIQUE NOT NULL,
  passord_hash TEXT NOT NULL,
  rolle        TEXT NOT NULL DEFAULT 'kunde',   -- 'kunde' | 'ansatt' | 'admin'
  opprettet    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activities (
  id          SERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  navn        TEXT NOT NULL,
  beskrivelse TEXT,
  varighet    TEXT,
  pris        INTEGER NOT NULL DEFAULT 0,       -- kr per person
  kapasitet   INTEGER NOT NULL DEFAULT 8,
  bilde       TEXT,
  aktiv       BOOLEAN NOT NULL DEFAULT true,
  sortering   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS availability (
  id          SERIAL PRIMARY KEY,
  activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
  dato        DATE NOT NULL,
  tid         TEXT NOT NULL,
  kapasitet   INTEGER NOT NULL DEFAULT 8
);

CREATE TABLE IF NOT EXISTS bookings (
  id          SERIAL PRIMARY KEY,
  activity_id INTEGER REFERENCES activities(id),
  bruker_id   INTEGER REFERENCES users(id),     -- NULL hvis gjest
  navn        TEXT NOT NULL,
  epost       TEXT NOT NULL,
  tlf         TEXT,
  dato        DATE NOT NULL,
  tid         TEXT,
  antall      INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'forespurt', -- 'forespurt'|'bekreftet'|'avlyst'|'fullfort'
  belop       INTEGER NOT NULL DEFAULT 0,         -- antall * pris (kr)
  melding     TEXT,
  opprettet   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_threads (
  id         SERIAL PRIMARY KEY,
  navn       TEXT,
  epost      TEXT,
  bruker_id  INTEGER REFERENCES users(id),
  status     TEXT NOT NULL DEFAULT 'apen',        -- 'apen'|'ansatt'|'lukket'
  opprettet  TIMESTAMPTZ DEFAULT now(),
  sist       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         SERIAL PRIMARY KEY,
  thread_id  INTEGER REFERENCES chat_threads(id) ON DELETE CASCADE,
  avsender   TEXT NOT NULL,                       -- 'kunde'|'ai'|'ansatt'
  tekst      TEXT NOT NULL,
  opprettet  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pageviews (
  id         SERIAL PRIMARY KEY,
  sti        TEXT,
  referrer   TEXT,
  anon_id    TEXT,
  opprettet  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content (
  nokkel     TEXT PRIMARY KEY,
  verdi      TEXT,
  oppdatert  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_scenarios (
  id         SERIAL PRIMARY KEY,
  bruker_id  INTEGER REFERENCES users(id),
  navn       TEXT NOT NULL,
  data       JSONB NOT NULL,
  oppdatert  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bookings_dato ON bookings(dato);
CREATE INDEX IF NOT EXISTS idx_pageviews_tid ON pageviews(opprettet);
CREATE INDEX IF NOT EXISTS idx_msg_thread ON chat_messages(thread_id);
