// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
//
// F47: db.ping() er den EKTE helsesjekken bak /api/health. Den skal bevise to
// ting, ikke bare ett: (1) at DB-motoren svarer (SELECT 1), og (2) at
// kjerneskjemaet faktisk er lastet (kjernetabellen `users` finnes). En db der
// migrasjonen feilet svarer glatt på SELECT 1 mens appen er ødelagt — derfor
// skjema-sjekken.
//
// ── pg-mem-begrensning (ærlig dokumentert) ───────────────────────────────────
// Skjema-sjekken bruker `to_regclass('public.users')`. pg-mem (integrasjons-
// testenes in-memory Postgres) implementerer IKKE to_regclass — den kaster
// "function to_regclass(text) does not exist". Vi kan derfor ikke drive den
// EKSAKTE spørringen mot pg-mem her. I stedet muterer vi pool.query på db-
// singletonen (samme mønster som transaction.test.js) og verifiserer ping()-
// LOGIKKEN: hvilke spørringer den kjører, og hvordan den tolker svaret.
// to_regclass' faktiske Postgres-semantikk (NULL når tabell mangler) er dekket
// ved at vi mater inn nettopp det svaret. Produksjonssemantikken (mot ekte
// Postgres/Railway) kan ikke bevises i denne suiten.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://stub:stub@localhost:5432/stub';

const db = require('../../db');

describe('db.ping (F47 — skjema-aware helsesjekk)', () => {
  let origQuery;

  beforeEach(() => {
    origQuery = db.pool.query;
  });

  afterEach(() => {
    db.pool.query = origQuery;
  });

  it('returnerer true når DB svarer OG kjernetabellen users finnes', async () => {
    const sett = [];
    db.pool.query = vi.fn(async (sql) => {
      sett.push(sql);
      if (/to_regclass/.test(sql)) return { rows: [{ finnes: 'users' }] };
      return { rows: [{ '?column?': 1 }] };
    });

    await expect(db.ping()).resolves.toBe(true);
    // Beviser at BEGGE lagene sjekkes: liveness (SELECT 1) + skjema (to_regclass)
    expect(sett.some((s) => /SELECT 1/.test(s))).toBe(true);
    expect(sett.some((s) => /to_regclass\('public\.users'\)/.test(s))).toBe(true);
  });

  it('kaster når kjernetabellen mangler (to_regclass -> NULL)', async () => {
    db.pool.query = vi.fn(async (sql) => {
      if (/to_regclass/.test(sql)) return { rows: [{ finnes: null }] };
      return { rows: [{ '?column?': 1 }] };
    });
    // Kaster -> /api/health oversetter til 503. SELECT 1 alene ville (feilaktig)
    // sagt "oppe".
    await expect(db.ping()).rejects.toThrow(/Kjerneskjema mangler/);
  });

  it('kaster når to_regclass-svaret er tomt (ingen rader)', async () => {
    db.pool.query = vi.fn(async (sql) => {
      if (/to_regclass/.test(sql)) return { rows: [] };
      return { rows: [{ '?column?': 1 }] };
    });
    await expect(db.ping()).rejects.toThrow(/Kjerneskjema mangler/);
  });

  it('kaster (DB nede) når SELECT 1 selv feiler — og sjekker ALDRI skjemaet da', async () => {
    let skjemaSjekket = false;
    db.pool.query = vi.fn(async (sql) => {
      if (/to_regclass/.test(sql)) {
        skjemaSjekket = true;
        return { rows: [{ finnes: 'users' }] };
      }
      throw new Error('ECONNREFUSED — ingen DB');
    });
    await expect(db.ping()).rejects.toThrow(/ECONNREFUSED/);
    // Uendret DB-nede-atferd: kaster på liveness før skjema-sjekken nås.
    expect(skjemaSjekket).toBe(false);
  });
});
