/**
 * Havstund Brain — prosess-inngang.
 *
 * Booter HTTP-serveren (src/server/http.ts). config.ts feiler raskt hvis env
 * er ufullstendig. Av/på styres av nettsiden (BRAIN_ENABLED) — denne prosessen
 * eksisterer bare når operatøren har startet den.
 */
import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';
import { PgStore } from './brain/pg-store.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // HULL 2 — auto-migrasjon ved boot: kjør migrations.sql mot DATABASE_URL FØR
  // serveren starter. Idempotent (CREATE TABLE IF NOT EXISTS) — trygt å kjøre
  // gjentatte ganger. Gjenbruker brainens egen pg-pool (PgStore) og sender den
  // videre til startServer, så vi IKKE åpner en ekstra pool.
  const store = new PgStore(config.DATABASE_URL);
  await store.migrate();
  logger.info('migrasjon kjørt');

  const { startServer } = await import('./server/http.js');
  await startServer(config, store);
  logger.info({ port: config.PORT }, 'havstund-brain startet');
}

main().catch((err) => {
  logger.error({ err }, 'havstund-brain klarte ikke å starte');
  process.exitCode = 1;
});
