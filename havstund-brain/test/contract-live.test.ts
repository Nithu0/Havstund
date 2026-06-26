/**
 * Nightly fake↔ekte-kontrakt (design §9). Kjører WebsitePort-kontrakten mot
 * HttpWebsiteAdapter og en EKTE nettside-instans. Bevis på paritet mellom mock
 * og ekte adapter.
 *
 * IKKE merge-blokkerende: hoppes over med mindre BRAIN_LIVE_CONTRACT=true.
 * Kjøres separat (npm run nightly:contract) mot en test-database — den OPPRETTER
 * bookinger, så pek den ALDRI mot produksjon.
 *
 * Krever env: WEBSITE_BASE_URL, WEBSITE_SERVICE_TOKEN (+ en nettside med en
 * aktivitet id=1, kap>=3, og en kunde id=1, samt en stengt dato 2026-12-25).
 */
import { describe } from 'vitest';
import { runPortContract } from './port-contract.js';
import { HttpWebsiteAdapter } from '../src/adapters/http-website-adapter.js';

const ENABLED = process.env.BRAIN_LIVE_CONTRACT === 'true';

if (ENABLED) {
  runPortContract('HttpWebsiteAdapter (live)', {
    makePort: () =>
      new HttpWebsiteAdapter({
        baseUrl: process.env.WEBSITE_BASE_URL!,
        serviceToken: process.env.WEBSITE_SERVICE_TOKEN!,
      }),
  });
} else {
  describe.skip('HttpWebsiteAdapter (live) — sett BRAIN_LIVE_CONTRACT=true for å kjøre', () => {});
}
