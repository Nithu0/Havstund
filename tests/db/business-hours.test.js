// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
// Tester Fase 2-delta: business_hours/closed_dates-skjema + apningstid-seed.
const fs = require('fs');
const path = require('path');
const seed = require('../../db/seed');

const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

describe('schema.sql — Fase 2 apningstider', () => {
  it('oppretter business_hours idempotent med riktige kolonner', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS business_hours');
    expect(schema).toContain('ukedag   SMALLINT PRIMARY KEY');
    expect(schema).toMatch(/apner\s+TIME/);
    expect(schema).toMatch(/stenger\s+TIME/);
    expect(schema).toMatch(/stengt\s+BOOLEAN DEFAULT false/);
  });

  it('oppretter closed_dates idempotent med dato PRIMARY KEY + grunn', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS closed_dates');
    expect(schema).toMatch(/dato\s+DATE PRIMARY KEY/);
    expect(schema).toMatch(/grunn\s+TEXT/);
  });

  it('bruker IF NOT EXISTS for begge nye tabeller (idempotent re-kjoring)', () => {
    const creates = schema.match(/CREATE TABLE (IF NOT EXISTS )?(business_hours|closed_dates)/g) || [];
    expect(creates.length).toBe(2);
    creates.forEach((c) => expect(c).toContain('IF NOT EXISTS'));
  });
});

// Hjelper: fanger alle query-kall slik seed gjor dem, uten ekte DB.
function fakeDb() {
  const calls = [];
  const counts = {}; // tabellnavn -> antall (0 default => seed kjorer alltid)
  async function query(text, params) {
    calls.push({ text, params });
    return { rows: [] };
  }
  async function one(text, params) {
    // COUNT(*)-sporringer returnerer n=0 saa alle seed-grener kjorer
    if (/COUNT\(\*\)/i.test(text)) return { n: 0 };
    // RETURNING id -> gi en falsk id slik at portal-seed gar videre
    if (/RETURNING id/i.test(text)) return { id: 1 };
    // SELECT id FROM users WHERE epost -> ikke funnet (ny kunde)
    return null;
  }
  return { query, one, calls };
}

describe('seed.js — apningstid-seed (Fase 2)', () => {
  it('seeder 7 business_hours-rader idempotent med ON CONFLICT DO NOTHING', async () => {
    const db = fakeDb();
    await seed(db);

    const bhCalls = db.calls.filter((c) => /INSERT INTO business_hours/i.test(c.text));
    expect(bhCalls.length).toBe(7);
    bhCalls.forEach((c) => {
      expect(c.text).toMatch(/ON CONFLICT \(ukedag\) DO NOTHING/i);
    });

    // Verifiser ukedag-dekning 0..6 (alle dager nettopp en gang)
    const ukedager = bhCalls.map((c) => c.params[0]).sort((a, b) => a - b);
    expect(ukedager).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('setter man-fre 10:00-16:00, lor 10:00-14:00, son stengt', async () => {
    const db = fakeDb();
    await seed(db);
    const bh = {};
    db.calls
      .filter((c) => /INSERT INTO business_hours/i.test(c.text))
      .forEach((c) => {
        const [ukedag, apner, stenger, stengt] = c.params;
        bh[ukedag] = { apner, stenger, stengt };
      });

    for (let d = 0; d <= 4; d++) {
      expect(bh[d]).toEqual({ apner: '10:00', stenger: '16:00', stengt: false });
    }
    expect(bh[5]).toEqual({ apner: '10:00', stenger: '14:00', stengt: false });
    expect(bh[6]).toEqual({ apner: null, stenger: null, stengt: true });
  });
});
