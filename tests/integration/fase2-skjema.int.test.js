// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// EKTE DB-INTEGRASJONSTEST for Fase 2 skjemafundament (2.1/2.2/2.3).
// Som de andre *.int.test.js laster denne db/schema.sql inn i en in-memory
// PostgreSQL (pg-mem) og kjorer EKTE SQL — ingen mocking av DDL/DML.
//
// Fase 2 legger til:
//   2.1  dagsoppgjor          — ett dagsoppgjor per dag (dato UNIQUE), laasbar.
//   2.2  salgsdokument_arkiv  — persondata-isolat, kan referere en booking.
//   2.3  bookings.adr_*       — strukturert kjoperadresse. Definert i CREATE
//        TABLE for ferske db-er OG lagt paa via ALTER ... ADD COLUMN IF NOT
//        EXISTS i migrate() for eksisterende db-er.
//
// ── pg-mem-begrensninger (aerlig dokumentert) ────────────────────────────────
//   1. `CREATE TABLE IF NOT EXISTS <finnes allerede>` kaster i pg-mem ved ANDRE
//      kjoring ("AST parts have not been read by the query planner"). Det er en
//      pg-mem-begrensning (ekte Postgres hopper over). Derfor kan vi IKKE bevise
//      "kjor HELE schema.sql to ganger" mot pg-mem — vi beviser at schemaet
//      laster rent EN gang med de nye tabellene, og at migrate() er trygg aa
//      kjore to ganger.
//   2. pg-mem populerer IKKE `pg_constraint`, saa "skip"-grenen i FK-migrasjonene
//      (F45) kan ikke observeres her. Det er dekket/dokumentert i
//      schema-migrations.int.test.js; her fokuserer vi paa Fase 2-tilleggene.

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const { migrate } = require('../../db');

// Adapter: gjor pg-mem-poolen kompatibel med migrate(q)-signaturen.
function qFra(mem) {
  const pg = mem.adapters.createPg();
  const pool = new pg.Pool();
  return (text, params) => pool.query(text, params);
}

const schemaPath = path.join(__dirname, '..', '..', 'db', 'schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

function nyDb() {
  const mem = newDb();
  mem.public.none(schema); // kaster hvis schemaet ikke laster
  return mem;
}

describe('Fase 2 skjemafundament (pg-mem, ekte SQL)', () => {
  it('schema.sql laster rent med de nye tabellene (dagsoppgjor + salgsdokument_arkiv)', () => {
    const mem = nyDb();
    // At nyDb() ikke kastet er allerede beviset; vi bekrefter at tabellene finnes
    // ved aa spsorre dem (tomme).
    for (const tabell of ['dagsoppgjor', 'salgsdokument_arkiv']) {
      const rad = mem.public.one(`SELECT COUNT(*)::int AS n FROM ${tabell}`);
      expect(rad.n).toBe(0);
    }
  });

  // ── 2.1 dagsoppgjor ─────────────────────────────────────────────────────────
  describe('2.1 dagsoppgjor', () => {
    it('dato er UNIQUE: to INSERT paa samme dato kaster', () => {
      const mem = nyDb();
      expect(() =>
        mem.public.none("INSERT INTO dagsoppgjor (dato) VALUES ('2026-07-09')")
      ).not.toThrow();
      // Samme dato igjen skal avvises av UNIQUE-constrainten.
      expect(() =>
        mem.public.none("INSERT INTO dagsoppgjor (dato) VALUES ('2026-07-09')")
      ).toThrow();
      // Annen dato er lov.
      expect(() =>
        mem.public.none("INSERT INTO dagsoppgjor (dato) VALUES ('2026-07-10')")
      ).not.toThrow();
    });

    it('kontrollsum-defaults er 0 og lukket_tid er NULL for en aapen dag', () => {
      const mem = nyDb();
      mem.public.none("INSERT INTO dagsoppgjor (dato) VALUES ('2026-07-09')");
      const rad = mem.public.one(
        'SELECT brutto_ore, mva_ore, antall_bilag, lukket_tid, lukket_av FROM dagsoppgjor'
      );
      expect(rad.brutto_ore).toBe(0);
      expect(rad.mva_ore).toBe(0);
      expect(rad.antall_bilag).toBe(0);
      expect(rad.lukket_tid).toBeNull();
      expect(rad.lukket_av).toBeNull();
    });

    it('en dag kan lukkes (lukket_av + lukket_tid + kontrollsummer settes)', () => {
      const mem = nyDb();
      mem.public.none(
        "INSERT INTO dagsoppgjor (dato, lukket_av, lukket_tid, brutto_ore, mva_ore, antall_bilag) " +
          "VALUES ('2026-07-09','admin@havstund.no', now(), 130000, 26000, 3)"
      );
      const rad = mem.public.one(
        'SELECT lukket_av, lukket_tid, brutto_ore, mva_ore, antall_bilag FROM dagsoppgjor'
      );
      expect(rad.lukket_av).toBe('admin@havstund.no');
      expect(rad.lukket_tid).not.toBeNull();
      expect(rad.brutto_ore).toBe(130000);
      expect(rad.mva_ore).toBe(26000);
      expect(rad.antall_bilag).toBe(3);
    });
  });

  // ── 2.2 salgsdokument_arkiv ────────────────────────────────────────────────
  describe('2.2 salgsdokument_arkiv', () => {
    it('kan referere en booking og lagre strukturert persondata; kjoper_land default NO', () => {
      const mem = nyDb();
      mem.public.none(
        "INSERT INTO activities (slug,navn,pris,kapasitet) VALUES ('drop-in','Drop-in',650,8)"
      );
      mem.public.none(
        "INSERT INTO bookings (activity_id,navn,epost,dato,tid,antall,belop,status) " +
          "VALUES (1,'Ola','ola@x.no','2026-07-01','10:00',2,1300,'forespurt')" // id 1
      );
      mem.public.none(
        "INSERT INTO salgsdokument_arkiv " +
          "(booking_id, kjoper_navn, kjoper_gate, kjoper_postnr, kjoper_poststed, bilag_ref) " +
          "VALUES (1,'Ola Nordmann','Storgata 1','0155','Oslo','SALE-1001')"
      );
      const rad = mem.public.one(
        'SELECT booking_id, kjoper_navn, kjoper_gate, kjoper_postnr, kjoper_poststed, kjoper_land, bilag_ref ' +
          'FROM salgsdokument_arkiv'
      );
      expect(rad.booking_id).toBe(1);
      expect(rad.kjoper_navn).toBe('Ola Nordmann');
      expect(rad.kjoper_gate).toBe('Storgata 1');
      expect(rad.kjoper_postnr).toBe('0155');
      expect(rad.kjoper_poststed).toBe('Oslo');
      expect(rad.kjoper_land).toBe('NO'); // schema-default
      expect(rad.bilag_ref).toBe('SALE-1001');
    });

    it('booking_id er nullable (arkivrad uten booking-kobling er lov)', () => {
      const mem = nyDb();
      expect(() =>
        mem.public.none(
          "INSERT INTO salgsdokument_arkiv (kjoper_navn, bilag_ref) VALUES ('Kari','SALE-2002')"
        )
      ).not.toThrow();
      const rad = mem.public.one('SELECT booking_id, kjoper_navn FROM salgsdokument_arkiv');
      expect(rad.booking_id).toBeNull();
      expect(rad.kjoper_navn).toBe('Kari');
    });
  });

  // ── 2.3 bookings.adr_* ─────────────────────────────────────────────────────
  describe('2.3 bookings strukturert adresse', () => {
    it('adr_*-kolonnene finnes i CREATE TABLE (fersk db) og er NULL for en booking uten adresse', () => {
      const mem = nyDb();
      mem.public.none(
        "INSERT INTO activities (slug,navn,pris,kapasitet) VALUES ('drop-in','Drop-in',650,8)"
      );
      mem.public.none(
        "INSERT INTO bookings (activity_id,navn,epost,dato,tid,antall,belop,status) " +
          "VALUES (1,'Ola','ola@x.no','2026-07-01','10:00',2,1300,'forespurt')"
      );
      const rad = mem.public.one(
        'SELECT adr_gate, adr_postnr, adr_poststed, adr_land FROM bookings'
      );
      expect(rad.adr_gate).toBeNull();
      expect(rad.adr_postnr).toBeNull();
      expect(rad.adr_poststed).toBeNull();
      expect(rad.adr_land).toBeNull();
    });

    it('adr_*-kolonnene kan fylles', () => {
      const mem = nyDb();
      mem.public.none(
        "INSERT INTO activities (slug,navn,pris,kapasitet) VALUES ('drop-in','Drop-in',650,8)"
      );
      mem.public.none(
        "INSERT INTO bookings (activity_id,navn,epost,dato,tid,antall,belop,status,adr_gate,adr_postnr,adr_poststed,adr_land) " +
          "VALUES (1,'Ola','ola@x.no','2026-07-01','10:00',2,1300,'forespurt','Storgata 1','0155','Oslo','NO')"
      );
      const rad = mem.public.one(
        'SELECT adr_gate, adr_postnr, adr_poststed, adr_land FROM bookings'
      );
      expect(rad.adr_gate).toBe('Storgata 1');
      expect(rad.adr_postnr).toBe('0155');
      expect(rad.adr_poststed).toBe('Oslo');
      expect(rad.adr_land).toBe('NO');
    });
  });

  // ── migrate() idempotens (2.3 ALTER ... ADD COLUMN IF NOT EXISTS) ───────────
  describe('migrate() er idempotent for Fase 2-ALTER-ene', () => {
    it('migrate() kjort to ganger kaster ikke (ADD COLUMN IF NOT EXISTS er trygg)', async () => {
      const mem = nyDb();
      const q = qFra(mem);
      // Forste kjoring legger paa adr_*-kolonnene (som allerede finnes fra CREATE
      // TABLE i pg-mem — ADD COLUMN IF NOT EXISTS skal da vaere en no-op).
      await migrate(q);
      // Andre kjoring skal heller ikke kaste.
      await expect(migrate(q)).resolves.toBeUndefined();
      // Kolonnene er (fortsatt) sporrbare etter to migrate()-kjoringer.
      const q2 = qFra(mem);
      const { rows } = await q2(
        'SELECT adr_gate, adr_postnr, adr_poststed, adr_land FROM bookings',
        undefined
      );
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});
