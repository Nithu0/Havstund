/**
 * HULL 2 — auto-migrasjon ved boot.
 *
 * Beviser at PgStore.migrate():
 *  - leser migrations.sql fra disk (samme mappe som modulen)
 *  - kjører SQL-en mot poolen (én pool.query med skjema-DDL)
 *  - er idempotent-trygg (SQL-en bruker CREATE TABLE IF NOT EXISTS)
 *
 * Vi mocker 'pg' så ingen ekte database trengs; stub-poolen fanger SQL-en.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queries: string[] = [];

vi.mock('pg', () => {
  class Pool {
    async query(sql: string): Promise<{ rows: unknown[] }> {
      queries.push(sql);
      return { rows: [] };
    }
    async end(): Promise<void> {
      /* no-op */
    }
  }
  return { default: { Pool }, Pool };
});

// Import ETTER vi.mock så PgStore plukker den mockede poolen.
const { PgStore } = await import('../src/brain/pg-store.js');

describe('PgStore.migrate (HULL 2 — auto-migrasjon)', () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it('leser migrations.sql og kjører den mot poolen', async () => {
    const store = new PgStore('postgres://stub');
    await store.migrate();

    expect(queries.length).toBe(1);
    const sql = queries[0]!;
    // SQL-en skal være selve migrasjonsfila — sjekk de brain-eide tabellene.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS brain_pending_actions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS brain_audit');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS brain_lessons');
    // Idempotens-garanti: filen bruker IF NOT EXISTS, ikke bart CREATE TABLE.
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });

  it('er trygg å kjøre flere ganger (idempotent boot)', async () => {
    const store = new PgStore('postgres://stub');
    await store.migrate();
    await store.migrate();
    expect(queries.length).toBe(2);
    expect(queries[0]).toBe(queries[1]);
  });
});
