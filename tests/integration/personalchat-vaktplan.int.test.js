// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// EKTE DB-INTEGRASJONSTEST (bolge 98-justering): personal_meldinger + den delte
// vaktplan-spoerringen. Laster db/schema.sql raatt inn i pg-mem og kjorer EKTE SQL.
//
// ── pg-mem-begrensninger (aerlig dokumentert) ────────────────────────────────
//   1. CREATE TABLE IF NOT EXISTS + FK + INDEX for personal_meldinger LASTER og
//      HAANDHEVES av pg-mem (FK mot ansatte avvist under). Dekker fresh + idempotent
//      (IF NOT EXISTS er en no-op ved 2. lasting).
//   2. to_char(dato,'YYYY-MM') (maaneds-filteret i den EKTE ruta) stottes IKKE av
//      pg-mem for DATE (kaster «execution error»). Ekte Postgres i prod har det
//      (min.js bruker to_char overalt). Her beviser vi PERSONVERN-egenskapen —
//      hvitliste-kolonnene / ingen lonn — som IKKE avhenger av WHERE-klausulen, saa
//      testen bruker et range-filter (dato >= .. AND < ..) som pg-mem stotter. Den
//      leverer NØYAKTIG samme rader/kolonner for juli-dataene under.
//   3. Ingen JSONB/DO-blokk beroeres — schema.sql har ingen plpgsql, saa lastingen
//      er ren (samme grunn som fase4-testen dokumenterer).

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

function nyDb() {
  const mem = newDb();
  mem.public.none(schema); // kaster hvis schemaet ikke laster (DDL-roundtrip)
  return mem;
}
function poolFra(mem) {
  const pg = mem.adapters.createPg();
  return new pg.Pool();
}

async function seedAnsatte(pool) {
  // timelonn_ore settes BEVISST (ulikt) — vaktplan-spoerringen skal ALDRI dra det med.
  await pool.query(
    `INSERT INTO ansatte (navn, timelonn_ore) VALUES ('Ola', 20000), ('Kari', 99999)`
  );
}

describe('bolge98 — personal_meldinger schema laster i pg-mem', () => {
  it('tabellen finnes og er tom', async () => {
    const pool = poolFra(nyDb());
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM personal_meldinger');
    expect(rows[0].n).toBe(0);
  });

  it('FK mot ansatte haandheves (ukjent ansatt_id avvises)', async () => {
    const pool = poolFra(nyDb());
    await expect(
      pool.query(`INSERT INTO personal_meldinger (ansatt_id, avsender, tekst) VALUES (99999,'ansatt','x')`)
    ).rejects.toThrow();
  });

  it('en traad kan lagres og markeres lest — avsender ansatt/admin', async () => {
    const mem = nyDb();
    const pool = poolFra(mem);
    await seedAnsatte(pool);
    await pool.query(`INSERT INTO personal_meldinger (ansatt_id, avsender, tekst) VALUES (1,'ansatt','Hei sjef')`);
    await pool.query(`INSERT INTO personal_meldinger (ansatt_id, avsender, tekst) VALUES (1,'admin','Hei tilbake')`);
    // Ansatt aapner -> admins meldinger merkes lest.
    const upd = await pool.query(
      `UPDATE personal_meldinger SET lest=true WHERE ansatt_id=1 AND avsender='admin' AND lest=false`
    );
    expect(upd.rowCount).toBe(1);
    const { rows } = await pool.query(
      `SELECT avsender, lest FROM personal_meldinger WHERE ansatt_id=1 ORDER BY id`
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.avsender === 'admin').lest).toBe(true);
    expect(rows.find((r) => r.avsender === 'ansatt').lest).toBe(false);
  });
});

describe('bolge98 — delt vaktplan-spoerring lekker ALDRI lonn', () => {
  it('JOIN gir flere ansatte men SELECT-en har ingen lonns-kolonne', async () => {
    const mem = nyDb();
    const pool = poolFra(mem);
    await seedAnsatte(pool);
    // Foeringer for BEGGE ansatte i samme maaned.
    await pool.query(`INSERT INTO timeforinger (ansatt_id, dato, timer) VALUES (1,'2026-07-03',6)`);
    await pool.query(`INSERT INTO timeforinger (ansatt_id, dato, timer) VALUES (2,'2026-07-04',8)`);

    // Samme SELECT-hvitliste + JOIN som routes/min.js GET /vaktplan. Maaneds-
    // filteret er range-basert her (pg-mem mangler to_char for DATE — se topp-notat);
    // den EKTE ruta bruker to_char(...) = '2026-07', som gir samme utvalg i Postgres.
    const { rows } = await pool.query(
      `SELECT t.ansatt_id, a.navn, t.dato, t.timer
         FROM timeforinger t
         JOIN ansatte a ON a.id = t.ansatt_id
        WHERE t.dato >= $1 AND t.dato < $2
        ORDER BY t.dato ASC, a.navn ASC, t.id ASC`,
      ['2026-07-01', '2026-08-01']
    );
    // Begge ansatte synlige (delt plan).
    expect(rows.map((r) => r.ansatt_id).sort()).toEqual([1, 2]);
    // Ingen rad har en lonns-kolonne — nøklene er en lukket hvitliste.
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['ansatt_id', 'dato', 'navn', 'timer']);
      expect('timelonn_ore' in r).toBe(false);
    }
    // Negativ assert paa serialisert svar (samme som rute-testen).
    const serialisert = JSON.stringify(rows);
    expect(serialisert).not.toMatch(/lonn|sats|_ore|belop/i);
    // De ulike satsene (20000 vs 99999) finnes i DB men ALDRI i svaret.
    expect(serialisert).not.toContain('20000');
    expect(serialisert).not.toContain('99999');
  });
});
