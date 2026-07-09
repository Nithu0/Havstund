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
  -- F46: ingen ON DELETE her => Postgres-standard NO ACTION (restriktiv): en
  -- aktivitet med bookinger kan IKKE slettes. Dette er TILSIKTET. Aktiviteter
  -- slettes aldri hardt — de deaktiveres via aktiv=false (se routes/activities.js
  -- DELETE /:id, som gjor UPDATE activities SET aktiv=false). Historiske bookinger
  -- skal beholde sin aktivitets-referanse for regnskap/rapportering. Ikke endre.
  activity_id INTEGER REFERENCES activities(id),
  bruker_id   INTEGER REFERENCES users(id),     -- NULL hvis gjest
  navn        TEXT NOT NULL,
  epost       TEXT NOT NULL,
  tlf         TEXT,
  dato        DATE NOT NULL,
  tid         TEXT,
  antall      INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT 'forespurt', -- 'forespurt'|'bekreftet'|'avlyst'|'fullfort'|'ingen_oppmoete'
  belop       INTEGER NOT NULL DEFAULT 0,         -- antall * pris (kr)
  melding     TEXT,
  -- Fase 2 (2.3): strukturert kjoperadresse. Alle NULLABLE og additive —
  -- eksisterende + gjeste-bookinger har ingen adresse; skjemaet fylles senere.
  -- MERK: paa en EKSISTERENDE db legges disse til via ALTER TABLE ... ADD COLUMN
  -- IF NOT EXISTS i migrate() (db/index.js). Grunnen: CREATE TABLE IF NOT EXISTS
  -- hopper over hele tabellen naar den finnes, saa nye kolonner her naar ALDRI
  -- en levende db. Definisjonen her gjelder derfor kun ferske databaser.
  adr_gate     TEXT,
  adr_postnr   TEXT,
  adr_poststed TEXT,
  adr_land     TEXT,
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
-- F43: hot-path for kundeportal (mine bookinger) + GDPR-sletting (alle bookinger
-- for en bruker). Additivt og trygt — ren indeks, ingen atferdsendring.
CREATE INDEX IF NOT EXISTS idx_bookings_bruker_id ON bookings(bruker_id);
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

-- ===== Apningstider (Fase 2) =====
-- business_hours = fast ukentlig apningstid. ukedag 0=mandag .. 6=sondag.
CREATE TABLE IF NOT EXISTS business_hours (
  ukedag   SMALLINT PRIMARY KEY,            -- 0=mandag .. 6=sondag
  apner    TIME,
  stenger  TIME,
  stengt   BOOLEAN DEFAULT false
);

-- closed_dates = enkeltdatoer som overstyrer apningstid (helligdager, ferie).
CREATE TABLE IF NOT EXISTS closed_dates (
  dato   DATE PRIMARY KEY,
  grunn  TEXT
);

-- ===== Fase 3: revisjon, passord-reset, migrasjonslogg, GDPR/MFA, refusjon, MVA =====

-- audit_log = revisjonsspor for admin-/ansatt-handlinger (GDPR-ansvarlighet).
CREATE TABLE IF NOT EXISTS audit_log (
  id         SERIAL PRIMARY KEY,
  tid        TIMESTAMPTZ DEFAULT now(),
  actor_id   INTEGER,
  actor_navn TEXT,
  handling   TEXT,
  detaljer   JSONB
);

-- reset_tokens = engangs-tokens for passordtilbakestilling.
CREATE TABLE IF NOT EXISTS reset_tokens (
  token    TEXT PRIMARY KEY,
  user_id  INTEGER,
  utloper  TIMESTAMPTZ
);

-- schema_migrations = sporing av kjorte migrasjoner.
CREATE TABLE IF NOT EXISTS schema_migrations (
  versjon  TEXT PRIMARY KEY,
  kjort    TIMESTAMPTZ DEFAULT now()
);

-- users: utvalgt-admin-flagg for AI-agenten (idempotent). Kun admin med
-- ai_agent_enabled=true ser/bruker AI-brainen (se integrations/brain-shim.js).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_agent_enabled BOOLEAN DEFAULT false;

-- users: TOTP/MFA + GDPR-anonymisering (idempotent).
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret    TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled   BOOLEAN DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at  TIMESTAMPTZ;

-- bookings: refusjon (idempotent).
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_amount_ore INTEGER;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reason     TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_at       TIMESTAMPTZ;

-- activities: MVA-sats per aktivitet (idempotent; default 25%).
ALTER TABLE activities ADD COLUMN IF NOT EXISTS mva_sats SMALLINT DEFAULT 25;

CREATE INDEX IF NOT EXISTS idx_audit_log_tid ON audit_log(tid);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON reset_tokens(user_id);

-- ===== F44: unik slot i availability =====
-- Dedupe av availability + CREATE UNIQUE INDEX uq_availability_slot er FLYTTET
-- ut av dette skjemaet og inn i migrate() i db/index.js (2026-07-09).
--
-- Hvorfor flyttet: schema.sql kjores idempotent ved HVER boot (db.init()). En
-- ubetinget `DELETE FROM availability ...` her kjorer altsaa ved hver oppstart og
-- rydder kalenderplasser i prod UTEN aa si fra (etter forste kjoring sletter den
-- 0 rader, saa den er teknisk idempotent — men stille). Prosjektet har lart denne
-- leksa i PR #31: stille db-init skal vaere hoylytt. I migrate() (JS) kan vi telle
-- slettede rader via rowCount og logge naar noe faktisk ryddes.
--
-- Rekkefolge-krav: dedupe MAA kjore FOER unik-indeksen opprettes (indeksen feiler
-- ellers paa eksisterende duplikater). init() kjorer schema.sql FOER migrate(), saa
-- indeksen kan IKKE bli staaende her — den ville da kjort foer dedupen. Derfor er
-- BEGGE i migrate(): dedupe -> CREATE UNIQUE INDEX -> FK-ene.

-- ===== Fase 2: skjemafundament for dagsoppgjor + persondata-isolat =====

-- dagsoppgjor = ett dagsoppgjor per kalenderdag (2.1). APPEND-ONLY: en rad
-- opprettes for dagen og oppdateres kun til den LUKKES. Naar lukket_tid er satt
-- er dagen laast — en refusjon skal da ikke lenger kunne skrive om historikk.
-- (Selve laase-/append-only-handhevingen ligger i rute-laget i en senere fase;
-- her definerer vi kun tabellen.) Kontrollsummer lagres i ore for aa matche
-- regnskap_poster-konvensjonen (ingen flyttall).
CREATE TABLE IF NOT EXISTS dagsoppgjor (
  id           SERIAL PRIMARY KEY,
  dato         DATE NOT NULL UNIQUE,               -- en rad per dag
  lukket_av    TEXT,                               -- hvem som lukket dagen
  lukket_tid   TIMESTAMPTZ,                        -- satt = dagen er laast
  brutto_ore   INTEGER NOT NULL DEFAULT 0,         -- kontrollsum: brutto i ore
  mva_ore      INTEGER NOT NULL DEFAULT 0,         -- kontrollsum: mva i ore
  antall_bilag INTEGER NOT NULL DEFAULT 0,         -- kontrollsum: antall bilag
  opprettet    TIMESTAMPTZ DEFAULT now()
);

-- salgsdokument_arkiv = persondata-isolat (2.2). Dette er det ENESTE stedet
-- kjoperens persondata for regnskap skal ligge. ADMIN-ONLY. Skal ALDRI med i
-- en regnskapspakke-eksport — bilagslaget/Fiken ser kun bilag_ref (saleNumber),
-- aldri navn/adresse. Bokforingsforskriften §5-1-2 krever kjopers navn + adresse
-- for salg over 1000 kr; derfor 5-aars lovpalagt bevaring her, isolert fra det
-- PII-frie bilagslaget. (Tilgangskontrollen bygges i rute-laget i en senere
-- fase — her definerer vi kun tabellen.)
CREATE TABLE IF NOT EXISTS salgsdokument_arkiv (
  id             SERIAL PRIMARY KEY,
  booking_id     INTEGER REFERENCES bookings(id),
  kjoper_navn    TEXT,
  kjoper_gate    TEXT,                             -- strukturert adresse
  kjoper_postnr  TEXT,
  kjoper_poststed TEXT,
  kjoper_land    TEXT DEFAULT 'NO',
  bilag_ref      TEXT,                             -- kobling til bilagslaget/Fiken saleNumber
  opprettet      TIMESTAMPTZ DEFAULT now()
);
