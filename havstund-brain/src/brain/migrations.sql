-- Havstund Brain — egne tabeller (brain-eide, separat fra nettsidens skjema).
-- Idempotent: kjøres ved oppstart av PgStore. Kan peke på samme database som
-- nettsiden uten å kollidere (egne tabellnavn med brain_-prefiks).

-- pending_actions: foreslåtte skrivinger som venter på bekreftelse (design §6/§8).
-- Lagres i Postgres (IKKE minne) så de overlever omstart og dobbel-confirm
-- fanges av unik idempotency_key + status-sjekk.
CREATE TABLE IF NOT EXISTS brain_pending_actions (
  tool_use_id     TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  input           JSONB NOT NULL,
  confirm_token   TEXT NOT NULL,
  idempotency_key TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','executed','expired','cancelled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  executed_at     TIMESTAMPTZ,
  result          JSONB
);

-- Unik på idempotency_key for utførte handlinger: confirm 2× ≠ 2 bookinger.
-- Partial unique index så NULL-nøkler (ingen idempotens) ikke kolliderer.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_brain_pending_idem
  ON brain_pending_actions (idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status = 'executed';

CREATE INDEX IF NOT EXISTS idx_brain_pending_conv ON brain_pending_actions (conversation_id);

-- audit: 2 rader per handling (proposed + executed), hvem/hva/når/diff (design §8).
CREATE TABLE IF NOT EXISTS brain_audit (
  id              BIGSERIAL PRIMARY KEY,
  phase           TEXT NOT NULL CHECK (phase IN ('proposed','executed')),
  tool_use_id     TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  actor           TEXT NOT NULL,
  input           JSONB,
  result          JSONB,
  error           TEXT,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_audit_conv ON brain_audit (conversation_id);
CREATE INDEX IF NOT EXISTS idx_brain_audit_at ON brain_audit (at);

-- lessons: lærings-/minne-hjerne. Maskinhåndhevet domene-separasjon via CHECK,
-- versjonering (version/supersedes), soft-delete (status), FK-løs entity_ref.
-- Minnet bærer ERFARING, ALDRI fersk tilstand (assertNoHardState i koden).
CREATE TABLE IF NOT EXISTS brain_lessons (
  id          BIGSERIAL PRIMARY KEY,
  domain      TEXT NOT NULL
                CHECK (domain IN ('booking','timesheet','calendar','customer','global')),
  type        TEXT NOT NULL,
  entity_ref  TEXT,
  payload     JSONB NOT NULL,
  confidence  REAL NOT NULL DEFAULT 0.7 CHECK (confidence >= 0 AND confidence <= 1),
  source      TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  supersedes  BIGINT REFERENCES brain_lessons(id),
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','retired','superseded')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_brain_lessons_lookup
  ON brain_lessons (domain, entity_ref, status);
