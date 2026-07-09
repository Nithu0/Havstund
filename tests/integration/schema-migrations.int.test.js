// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// EKTE DB-INTEGRASJONSTEST for schema-migrasjonene F43/F44/F45.
// Som booking-db.int.test.js laster denne db/schema.sql inn i en in-memory
// PostgreSQL (pg-mem) og kjorer EKTE SQL — ingen mocking av selve DDL/DML-en.
//
// ── pg-mem-begrensninger (aerlig dokumentert) ────────────────────────────────
//   1. `CREATE TABLE IF NOT EXISTS <finnes allerede>` kaster i pg-mem ved
//      ANDRE kjoring ("AST parts have not been read by the query planner").
//      Det er en pg-mem-begrensning, IKKE en ekte-Postgres-feil (ekte Postgres
//      hopper over og fortsetter). Derfor kan vi IKKE bevise "kjor HELE
//      schema.sql to ganger" mot pg-mem. Vi beviser i stedet at (a) schemaet
//      laster rent EN gang med F43/F46-tilleggene, og (b) at migrate() (som naa
//      eier F44-dedupe + unik-indeks + F45-FK-ene) er trygg aa kjore to ganger.
//      MERK: F44-dedupe/unik-indeks ble flyttet fra schema.sql til migrate()
//      (2026-07-09) slik at prod-slettingen kan telles (rowCount) og logges i
//      stedet for aa skje stille ved hver boot.
//
//   2. pg-mem populerer IKKE `pg_constraint` for constraints lagt til via
//      `ALTER TABLE ... ADD CONSTRAINT`. Derfor kan vi ikke bevise at F45-
//      guarden ("skip hvis constrainten finnes") faktisk hopper over paa andre
//      kjoring — den grenen er ekte-Postgres-only. Vi beviser i stedet at
//      migrate() (a) rydder foreldreloese rader korrekt, (b) legger paa FK-ene,
//      og (c) er trygg aa kjore to ganger uten aa kaste.
//
//   3. plpgsql / `DO $$ ... $$` stottes ikke av pg-mem. Derfor ligger F45-FK-ene
//      i db/index.js migrate() (JS-guard) og ikke i schema.sql (som ville krevd
//      en DO-blokk og brutt schema-lastingen i booking-db.int.test.js).

const fs = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');
const { migrate } = require('../../db');
const { logger } = require('../../lib/logger');

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

describe('schema-migrasjoner (pg-mem, ekte SQL)', () => {
  // ── F43 ────────────────────────────────────────────────────────────────────
  describe('F43: idx_bookings_bruker_id', () => {
    it('schema laster med indeksen, og CREATE INDEX IF NOT EXISTS er re-kjorbar', () => {
      const mem = nyDb();
      // Re-kjoring av den additive indeks-setningen skal ikke kaste (idempotent).
      expect(() =>
        mem.public.none(
          'CREATE INDEX IF NOT EXISTS idx_bookings_bruker_id ON bookings(bruker_id);'
        )
      ).not.toThrow();
    });
  });

  // ── F44 ────────────────────────────────────────────────────────────────────
  // Dedupe + unik-indeks ligger naa i migrate() (db/index.js), IKKE i schema.sql
  // (flyttet 2026-07-09 for aa gjore den stille prod-slettingen hoylytt/loggbar).
  // Derfor drives F44 her gjennom migrate(), ikke ved ren schema-last.
  describe('F44: dedupe + unik slot via migrate()', () => {
    it('migrate() dedupe beholder LAVEST id, logger antall, og 2. kjoring sletter 0', async () => {
      const mem = nyDb();
      // To aktiviteter (FK availability.activity_id -> activities(id) krever at
      // begge finnes).
      mem.public.none(
        "INSERT INTO activities (slug,navn,pris,kapasitet) VALUES " +
          "('drop-in','Drop-in',650,8),('kurs','Kurs',900,6);"
      );
      // 4 rader: id=2 er duplikat av id=1 (samme activity_id, dato, tid).
      mem.public.none(
        "INSERT INTO availability (activity_id,dato,tid,kapasitet) VALUES " +
          "(1,'2026-07-01','10:00',8),(1,'2026-07-01','10:00',12)," +
          "(1,'2026-07-01','12:00',5),(2,'2026-07-01','10:00',8);"
      );
      const q = qFra(mem);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await migrate(q);

        // id=2 (duplikat av id=1) er borte; id=1,3,4 bestar.
        const etter = mem.public.many('SELECT id FROM availability ORDER BY id');
        expect(etter.map((r) => r.id)).toEqual([1, 3, 4]);

        // warn logget EN gang med antall=1 og tabell=availability.
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toMatchObject({ antall: 1, tabell: 'availability' });

        // Andre kjoring: ingen duplikater -> ingen ny warn, ingen rader slettet.
        warnSpy.mockClear();
        await migrate(q);
        expect(warnSpy).not.toHaveBeenCalled();
        const etter2 = mem.public.many('SELECT id FROM availability ORDER BY id');
        expect(etter2.map((r) => r.id)).toEqual([1, 3, 4]);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('unik-indeksen (activity_id, dato, tid) haandheves etter migrate()', async () => {
      const mem = nyDb();
      mem.public.none(
        "INSERT INTO activities (slug,navn,pris,kapasitet) VALUES ('drop-in','Drop-in',650,8);"
      );
      await migrate(qFra(mem));
      mem.public.none(
        "INSERT INTO availability (activity_id,dato,tid,kapasitet) VALUES (1,'2026-07-01','10:00',8);"
      );
      // Samme (activity_id, dato, tid) igjen skal avvises av unik-indeksen.
      expect(() =>
        mem.public.none(
          "INSERT INTO availability (activity_id,dato,tid,kapasitet) VALUES (1,'2026-07-01','10:00',12);"
        )
      ).toThrow();
      // Ulik tid er lov.
      expect(() =>
        mem.public.none(
          "INSERT INTO availability (activity_id,dato,tid,kapasitet) VALUES (1,'2026-07-01','12:00',5);"
        )
      ).not.toThrow();
    });
  });

  // ── F45 ────────────────────────────────────────────────────────────────────
  describe('F45: manglende fremmednokler via db/index.js migrate()', () => {
    function seedForFk(mem) {
      mem.public.none(
        "INSERT INTO users (navn, epost, passord_hash) VALUES ('A','a@x.no','h');" // id 1
      );
      mem.public.none(
        "INSERT INTO activities (slug,navn,pris,kapasitet) VALUES ('drop-in','Drop-in',650,8);"
      );
      mem.public.none(
        "INSERT INTO bookings (activity_id,navn,epost,dato,tid,antall,belop,status) " +
          "VALUES (1,'A','a@x.no','2026-07-01','10:00',1,650,'forespurt');" // id 1
      );
      // prosjekt for project_media (project_id har FK ON DELETE CASCADE fra schema).
      mem.public.none("INSERT INTO projects (bruker_id, tittel) VALUES (1,'P');"); // id 1
      // Gyldig + foreldreloes project_media (bruker_id=999 finnes ikke).
      mem.public.none(
        "INSERT INTO project_media (project_id, bruker_id, url) VALUES (1,1,'ok'),(1,999,'orphan');"
      );
      // Gyldig + foreldreloes receipt (booking_id=888 finnes ikke).
      mem.public.none(
        "INSERT INTO receipts (bruker_id, booking_id, belop) VALUES (1,1,100),(1,888,200);"
      );
      // Gyldig, foreldreloes (777), og utloept token.
      mem.public.none(
        "INSERT INTO reset_tokens (token,user_id,utloper) VALUES " +
          "('t1',1, now() + interval '1 hour')," +
          "('t2',777, now() + interval '1 hour')," +
          "('t3',1, now() - interval '1 hour');"
      );
    }

    it('rydder foreldreloese rader og legger paa FK-ene', async () => {
      const mem = nyDb();
      seedForFk(mem);
      await migrate(qFra(mem));

      // project_media: foreldreloes bruker_id nullet, gyldig bevart.
      const pm = mem.public.many('SELECT id, bruker_id FROM project_media ORDER BY id');
      expect(pm).toEqual([
        { id: 1, bruker_id: 1 },
        { id: 2, bruker_id: null },
      ]);

      // receipts: foreldreloes booking_id nullet, gyldig bevart.
      const rc = mem.public.many('SELECT id, booking_id FROM receipts ORDER BY id');
      expect(rc).toEqual([
        { id: 1, booking_id: 1 },
        { id: 2, booking_id: null },
      ]);

      // reset_tokens: foreldreloes (777) OG utloept (t3) slettet; kun t1 bestar.
      const rt = mem.public.many('SELECT token FROM reset_tokens ORDER BY token');
      expect(rt.map((r) => r.token)).toEqual(['t1']);
    });

    it('FK-ene er faktisk paa: ny foreldreloes rad avvises etter migrasjon', async () => {
      const mem = nyDb();
      seedForFk(mem);
      await migrate(qFra(mem));
      // project_media.bruker_id -> users(id): ukjent bruker skal avvises.
      expect(() =>
        mem.public.none("INSERT INTO project_media (project_id, bruker_id, url) VALUES (1, 424242, 'x');")
      ).toThrow();
    });

    it('migrate() er trygg aa kjore to ganger (kaster ikke)', async () => {
      const mem = nyDb();
      seedForFk(mem);
      const q = qFra(mem);
      await migrate(q);
      // MERK: pg-mem populerer ikke pg_constraint, saa "skip"-grenen kan ikke
      // observeres her — men andre kjoring skal uansett ikke kaste.
      await expect(migrate(q)).resolves.toBeUndefined();
    });
  });
});
