// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
// Tester Fase 3-delta i schema.sql: revisjon, reset-tokens, migrasjonslogg,
// GDPR/MFA-kolonner, refusjon, MVA-sats. Verifiserer idempotent SQL.
const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

describe('schema.sql — Fase 3 nye tabeller', () => {
  it('oppretter audit_log idempotent med riktige kolonner', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS audit_log');
    expect(schema).toMatch(/id\s+SERIAL PRIMARY KEY/);
    expect(schema).toMatch(/tid\s+TIMESTAMPTZ DEFAULT now\(\)/);
    expect(schema).toMatch(/actor_id\s+INTEGER/);
    expect(schema).toMatch(/actor_navn\s+TEXT/);
    expect(schema).toMatch(/handling\s+TEXT/);
    expect(schema).toMatch(/detaljer\s+JSONB/);
  });

  it('oppretter reset_tokens idempotent med token PRIMARY KEY', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS reset_tokens');
    expect(schema).toMatch(/token\s+TEXT PRIMARY KEY/);
    expect(schema).toMatch(/user_id\s+INTEGER/);
    expect(schema).toMatch(/utloper\s+TIMESTAMPTZ/);
  });

  it('oppretter schema_migrations idempotent med versjon PRIMARY KEY', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS schema_migrations');
    expect(schema).toMatch(/versjon\s+TEXT PRIMARY KEY/);
    expect(schema).toMatch(/kjort\s+TIMESTAMPTZ DEFAULT now\(\)/);
  });

  it('bruker IF NOT EXISTS for alle tre nye tabeller (idempotent re-kjoring)', () => {
    const creates =
      schema.match(
        /CREATE TABLE (IF NOT EXISTS )?(audit_log|reset_tokens|schema_migrations)/g
      ) || [];
    expect(creates.length).toBe(3);
    creates.forEach((c) => expect(c).toContain('IF NOT EXISTS'));
  });
});

describe('schema.sql — Fase 3 ALTER ADD COLUMN (idempotent)', () => {
  it('legger til users GDPR/MFA-kolonner med IF NOT EXISTS', () => {
    expect(schema).toMatch(
      /ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret\s+TEXT/
    );
    expect(schema).toMatch(
      /ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled\s+BOOLEAN DEFAULT false/
    );
    expect(schema).toMatch(
      /ALTER TABLE users ADD COLUMN IF NOT EXISTS anonymized_at\s+TIMESTAMPTZ/
    );
  });

  it('legger til bookings refusjon-kolonner med IF NOT EXISTS', () => {
    expect(schema).toMatch(
      /ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_amount_ore\s+INTEGER/
    );
    expect(schema).toMatch(
      /ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reason\s+TEXT/
    );
    expect(schema).toMatch(
      /ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_at\s+TIMESTAMPTZ/
    );
  });

  it('legger til activities.mva_sats med IF NOT EXISTS + default 25', () => {
    expect(schema).toMatch(
      /ALTER TABLE activities ADD COLUMN IF NOT EXISTS mva_sats SMALLINT DEFAULT 25/
    );
  });

  it('alle Fase 3 ALTER-setninger bruker ADD COLUMN IF NOT EXISTS', () => {
    // Plukk ut ALTER-linjer for de tre tabellene vi rorer i Fase 3.
    const alters =
      schema.match(/ALTER TABLE (users|bookings|activities) ADD COLUMN[^\n;]*/g) ||
      [];
    expect(alters.length).toBeGreaterThanOrEqual(7);
    alters.forEach((a) => expect(a).toContain('IF NOT EXISTS'));
  });
});
