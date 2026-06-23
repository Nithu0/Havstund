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

-- ===== Kundeportal: prosjekter, media, kvitteringer, kunde-meldinger =====
CREATE TABLE IF NOT EXISTS projects (
    id          SERIAL PRIMARY KEY,
    bruker_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
    tittel      TEXT NOT NULL,
    type        TEXT,
    status      TEXT NOT NULL DEFAULT 'pabegynt',
    beskrivelse TEXT,
    opprettet   TIMESTAMPTZ DEFAULT now(),
    oppdatert   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS project_media (
    id         SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    bruker_id  INTEGER,
    url        TEXT NOT NULL,
    type       TEXT DEFAULT 'bilde',
    tittel     TEXT,
    opprettet  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS receipts (
    id          SERIAL PRIMARY KEY,
    bruker_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
    booking_id  INTEGER,
    belop       INTEGER NOT NULL DEFAULT 0,
    beskrivelse TEXT,
    betalt      BOOLEAN DEFAULT false,
    dato        DATE,
    opprettet   TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_messages (
    id        SERIAL PRIMARY KEY,
    bruker_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    avsender  TEXT NOT NULL,
    tekst     TEXT NOT NULL,
    pris      INTEGER,
    lest      BOOLEAN DEFAULT false,
    opprettet TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_media_project_id ON project_media(project_id);
CREATE INDEX IF NOT EXISTS idx_receipts_bruker_id ON receipts(bruker_id);
CREATE INDEX IF NOT EXISTS idx_customer_messages_bruker_id ON customer_messages(bruker_id);
CREATE INDEX IF NOT EXISTS idx_projects_bruker_id ON projects(bruker_id);

-- ===== Regnskap (Fiken-formet: belop i ore, norsk kontoplan, MVA-koder) =====
-- regnskap_poster = bokforte poster. type 'inntekt' (Fiken Salg) | 'utgift' (Fiken Kjop).
-- Lagres slik at en fremtidig integrasjon kan dytte rett inn i Fikens API.
CREATE TABLE IF NOT EXISTS regnskap_poster (
  id              SERIAL PRIMARY KEY,
  type            TEXT NOT NULL,                 -- 'inntekt' | 'utgift'
  dato            DATE NOT NULL,
  kontakt         TEXT,                          -- kunde/leverandor (Fiken Contact-navn)
  beskrivelse     TEXT NOT NULL,
  konto           INTEGER,                       -- Fiken kontoplan (3000, 5000, 6300 ...)
  mva_kode        INTEGER,                       -- Fiken MVA-kode (3=salg 25%, 1=kjop fradrag, 0=uten)
  mva_sats        INTEGER NOT NULL DEFAULT 0,    -- 0 | 12 | 15 | 25 (prosent)
  netto_ore       INTEGER NOT NULL DEFAULT 0,    -- nettobelop i ore
  mva_ore         INTEGER NOT NULL DEFAULT 0,    -- mva-belop i ore
  brutto_ore      INTEGER NOT NULL DEFAULT 0,    -- netto + mva i ore
  betalingsmetode TEXT,                          -- 'bank' | 'kontant' | 'kort'
  bilag           TEXT,                          -- referanse / vedlegg-URL
  vedlegg         TEXT,                          -- kvitteringsbilde som base64 data-URL (Railway-filsystem er flyktig)
  kilde           TEXT NOT NULL DEFAULT 'manuell',-- 'manuell' | 'booking' | 'butikk'
  booking_id      INTEGER REFERENCES bookings(id),
  fiken_status    TEXT NOT NULL DEFAULT 'ikke_sendt', -- 'ikke_sendt' | 'sendt'
  opprettet       TIMESTAMPTZ DEFAULT now()
);

-- Idempotent migrering: gir eksisterende databaser kvitteringsbilde-kolonnen
ALTER TABLE regnskap_poster ADD COLUMN IF NOT EXISTS vedlegg TEXT;

-- ansatte = lonnsmottakere (kobles valgfritt til en bruker)
CREATE TABLE IF NOT EXISTS ansatte (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id),
  navn         TEXT NOT NULL,
  epost        TEXT,
  stilling     TEXT,
  timelonn_ore INTEGER NOT NULL DEFAULT 0,       -- timelonn i ore
  konto        INTEGER NOT NULL DEFAULT 5000,    -- Fiken lonnskonto
  aktiv        BOOLEAN NOT NULL DEFAULT true,
  opprettet    TIMESTAMPTZ DEFAULT now()
);

-- timeforinger = registrerte timer (Fiken Timeforing) -> grunnlag for lonn
CREATE TABLE IF NOT EXISTS timeforinger (
  id         SERIAL PRIMARY KEY,
  ansatt_id  INTEGER NOT NULL REFERENCES ansatte(id) ON DELETE CASCADE,
  dato       DATE NOT NULL,
  timer      NUMERIC(5,2) NOT NULL DEFAULT 0,
  aktivitet  TEXT,                               -- prosjekt/aktivitet
  notat      TEXT,
  opprettet  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_poster_dato ON regnskap_poster(dato);
CREATE INDEX IF NOT EXISTS idx_poster_type ON regnskap_poster(type);
CREATE INDEX IF NOT EXISTS idx_timer_ansatt ON timeforinger(ansatt_id);
CREATE INDEX IF NOT EXISTS idx_timer_dato ON timeforinger(dato);
