/**
 * Havstund Brain — prosess-inngang.
 *
 * Booter HTTP-serveren (src/server/http.ts). config.ts feiler raskt hvis env
 * er ufullstendig. Av/på styres av nettsiden (BRAIN_ENABLED) — denne prosessen
 * eksisterer bare når operatøren har startet den.
 */
import { loadConfig } from './config.js';
import { logger } from './lib/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { startServer } = await import('./server/http.js');
  await startServer(config);
  logger.info({ port: config.PORT }, 'havstund-brain startet');
}

main().catch((err) => {
  logger.error({ err }, 'havstund-brain klarte ikke å starte');
  process.exitCode = 1;
});
