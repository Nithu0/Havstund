// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// EKTE DB-INTEGRASJONSTEST for Fase 4: refusjoner + gavekort + Fiken-kolonner.
// Laster db/schema.sql inn i pg-mem og kjorer EKTE SQL — ingen mocking av DDL/DML.
//
// ── pg-mem-begrensninger (aerlig dokumentert) ────────────────────────────────
//   1. `SELECT ... FOR UPDATE` PARSER, men pg-mem er ett-tradet og HAANDHEVER
//      ingen rad-laasing. Vi kan derfor ikke bevise at to SAMTIDIGE delrefusjoner
//      serialiseres av FOR UPDATE — kun at invariant-SUMMERINGEN og den betingede
//      dobbeltinnloesnings-UPDATE-en gir rett tall/rowCount. Den EKTE
//      samtidighets-serialiseringen krever ekte Postgres (produksjon).
//   2. UNIQUE + CHECK HAANDHEVES av pg-mem (verifisert) — dobbel `kode` og
//      belop_ore<=0 avvises som i ekte Postgres.

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const { migrate } = require('../../db');

const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

function nyDb() {
  const mem = newDb();
  mem.public.none(schema); // kaster hvis schemaet ikke laster
  return mem;
}
function qFra(mem) {
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  return { pool, q: (text, params) => pool.query(text, params) };
}

async function seedBooking(pool) {
  await pool.query(`INSERT INTO activities (slug,navn,pris,kapasitet) VALUES ('drop-in','Drop-in',500,8)`);
  await pool.query(
    `INSERT INTO bookings (activity_id,navn,epost,dato,tid,antall,belop,status)
     VALUES (1,'Kari','kari@x.no','2026-07-09','10:00',1,500,'forespurt')`
  );
}

describe('Fase 4 — schema laster med refusjoner + gavekort', () => {
  it('nye tabeller finnes og er tomme', async () => {
    const { pool } = qFra(nyDb());
    for (const t of ['refusjoner', 'gavekort']) {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${t}`);
      expect(rows[0].n).toBe(0);
    }
  });
});

describe('Fase 4 — migrate() legger Fiken-kolonner idempotent', () => {
  it('fiken_id/fiken_sale_id/fiken_sale_number finnes etter migrate(), 2. kjoring kaster ikke', async () => {
    const mem = nyDb();
    const { pool, q } = qFra(mem);
    await migrate(q);
    // Kolonnene er brukbare (INSERT som setter dem eksplisitt).
    await seedBooking(pool);
    await pool.query(
      `INSERT INTO regnskap_poster (type,dato,beskrivelse,netto_ore,mva_ore,brutto_ore,fiken_id)
       VALUES ('inntekt','2026-07-09','x',100,25,125,'sale-123')`
    );
    const { rows } = await pool.query(`SELECT fiken_id FROM regnskap_poster`);
    expect(rows[0].fiken_id).toBe('sale-123');
    await pool.query(`UPDATE bookings SET fiken_sale_id='s1', fiken_sale_number='HAV-booking-1-v1' WHERE id=1`);
    const { rows: b } = await pool.query(`SELECT fiken_sale_id, fiken_sale_number FROM bookings WHERE id=1`);
    expect(b[0].fiken_sale_id).toBe('s1');
    expect(b[0].fiken_sale_number).toBe('HAV-booking-1-v1');
    // Idempotent: 2. migrate() kaster ikke.
    await expect(migrate(q)).resolves.toBeUndefined();
  });
});

describe('Fase 4 — refusjons-invariant (summering)', () => {
  it('N delrefusjoner summerer korrekt og CHECK avviser belop_ore <= 0', async () => {
    const mem = nyDb();
    const { pool } = qFra(mem);
    await seedBooking(pool);
    // Booking 500 kr = 50000 ore. Tre delrefusjoner: 20000 + 20000 + 10000 = 50000.
    for (const b of [20000, 20000, 10000]) {
      await pool.query('INSERT INTO refusjoner (booking_id, belop_ore) VALUES (1, $1)', [b]);
    }
    const { rows } = await pool.query(
      'SELECT COALESCE(SUM(belop_ore),0)::bigint AS sum FROM refusjoner WHERE booking_id = 1'
    );
    expect(Number(rows[0].sum)).toBe(50000);
    // Invariant-logikken i ruten: gjenstaende = 50000 - 50000 = 0; ny 1 > 0 -> avvist.
    const gjenstaende = 50000 - Number(rows[0].sum);
    expect(gjenstaende).toBe(0);
    expect(1 > gjenstaende).toBe(true); // enhver videre refusjon sprenger invarianten

    // CHECK (belop_ore > 0) haandheves.
    await expect(
      pool.query('INSERT INTO refusjoner (booking_id, belop_ore) VALUES (1, 0)')
    ).rejects.toThrow();
  });

  it('refusjoner.booking_id FK avviser ukjent booking', async () => {
    const mem = nyDb();
    const { pool } = qFra(mem);
    await seedBooking(pool);
    await expect(
      pool.query('INSERT INTO refusjoner (booking_id, belop_ore) VALUES (99999, 100)')
    ).rejects.toThrow();
  });
});

describe('Fase 4 — gavekort dobbeltinnloesnings-vern', () => {
  it('unik kode avvises, og betinget UPDATE innloeser kun EN gang (rowCount 1 -> 0)', async () => {
    const mem = nyDb();
    const { pool } = qFra(mem);
    await pool.query(`INSERT INTO gavekort (kode, verdi_ore) VALUES ('HAV-GK-AAA', 20000)`);
    // Dobbel kode avvist (UNIQUE).
    await expect(
      pool.query(`INSERT INTO gavekort (kode, verdi_ore) VALUES ('HAV-GK-AAA', 5000)`)
    ).rejects.toThrow();

    // Innloesning: betinget UPDATE (WHERE innlost=false) er den race-trygge
    // korrekthets-garden — andre forsoek treffer 0 rader selv uten rad-laasing.
    const u1 = await pool.query(
      `UPDATE gavekort SET innlost=true, innlost_tid=now() WHERE kode=$1 AND innlost=false`,
      ['HAV-GK-AAA']
    );
    expect(u1.rowCount).toBe(1);
    const u2 = await pool.query(
      `UPDATE gavekort SET innlost=true, innlost_tid=now() WHERE kode=$1 AND innlost=false`,
      ['HAV-GK-AAA']
    );
    expect(u2.rowCount).toBe(0); // allerede innloest -> ingen dobbel innloesning
  });

  it('CHECK (verdi_ore > 0) haandheves', async () => {
    const mem = nyDb();
    const { pool } = qFra(mem);
    await expect(
      pool.query(`INSERT INTO gavekort (kode, verdi_ore) VALUES ('HAV-GK-NEG', -1)`)
    ).rejects.toThrow();
  });
});
