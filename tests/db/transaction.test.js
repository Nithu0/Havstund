// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
// Tester db.withTransaction: commit ved suksess, ROLLBACK + re-kast ved feil,
// og at client.release() ALLTID kalles.
//
// vi.mock fanger ikke require() i db/index.js, så vi muterer db-singletonens
// pool i stedet. withTransaction closer over modulens pool-objekt, så å
// overstyre pool.connect på det eksporterte objektet treffer samme referanse.
// DATABASE_URL settes før require slik at en (ekte) pg Pool opprettes — ingen
// faktisk tilkobling skjer fordi vi stubber connect().

process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://stub:stub@localhost:5432/stub';

const db = require('../../db');

function makeClient() {
  const calls = [];
  return {
    calls,
    released: 0,
    query: vi.fn(async (sql) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(function () {
      this.released += 1;
    }),
  };
}

describe('db.withTransaction', () => {
  let origConnect;

  beforeEach(() => {
    origConnect = db.pool.connect;
  });

  afterEach(() => {
    db.pool.connect = origConnect;
  });

  it('committer ved suksess og returnerer fn-resultatet', async () => {
    const client = makeClient();
    db.pool.connect = vi.fn(async () => client);

    const result = await db.withTransaction(async (c) => {
      await c.query('SELECT * FROM bookinger WHERE id = $1 FOR UPDATE', [1]);
      await c.query('INSERT INTO bookinger DEFAULT VALUES');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(client.calls[0]).toBe('BEGIN');
    expect(client.calls).toContain('COMMIT');
    expect(client.calls).not.toContain('ROLLBACK');
    expect(client.released).toBe(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('kjorer SELECT FOR UPDATE og INSERT paa SAMME client (samme connection)', async () => {
    const client = makeClient();
    db.pool.connect = vi.fn(async () => client);

    let seenSelect = null;
    let seenInsert = null;
    await db.withTransaction(async (c) => {
      seenSelect = c;
      await c.query('SELECT 1 FOR UPDATE');
      seenInsert = c;
      await c.query('INSERT INTO t DEFAULT VALUES');
    });

    expect(seenSelect).toBe(client);
    expect(seenInsert).toBe(client);
    // connect kalt nøyaktig én gang -> én connection for hele transaksjonen
    expect(db.pool.connect).toHaveBeenCalledTimes(1);
  });

  it('ROLLBACK og re-kaster feilen naar fn kaster', async () => {
    const client = makeClient();
    db.pool.connect = vi.fn(async () => client);

    const boom = new Error('fn feilet');
    await expect(
      db.withTransaction(async (c) => {
        await c.query('SELECT 1 FOR UPDATE');
        throw boom;
      })
    ).rejects.toBe(boom);

    expect(client.calls[0]).toBe('BEGIN');
    expect(client.calls).toContain('ROLLBACK');
    expect(client.calls).not.toContain('COMMIT');
    expect(client.released).toBe(1);
  });

  it('release() kalles ALLTID — ogsaa naar COMMIT selv kaster', async () => {
    const client = makeClient();
    const commitErr = new Error('commit feilet');
    client.query = vi.fn(async (sql) => {
      client.calls.push(sql);
      if (sql === 'COMMIT') throw commitErr;
      return { rows: [], rowCount: 0 };
    });
    db.pool.connect = vi.fn(async () => client);

    await expect(db.withTransaction(async () => 'x')).rejects.toBe(commitErr);
    expect(client.released).toBe(1);
  });

  it('kaster naar databasen ikke er konfigurert (ingen pool)', async () => {
    const realPool = db.pool;
    // Simuler ukonfigurert: tving connect til å reflektere manglende pool.
    // Vi kan ikke nulle modul-lokal pool herfra, så vi verifiserer i stedet at
    // connect-feil propagerer (klient hentes aldri -> ingen release).
    db.pool.connect = vi.fn(async () => {
      throw new Error('Database ikke konfigurert.');
    });

    await expect(db.withTransaction(async () => 'x')).rejects.toThrow(
      /ikke konfigurert/
    );
    db.pool.connect = realPool.connect;
  });
});
