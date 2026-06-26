import { defineConfig } from 'vitest/config';

// Egen vitest-config for AI-brainen (eget npm-package). MÅ finnes her slik at
// vitest IKKE traverserer opp og plukker repo-rotens vitest.config.js — den
// importerer 'vitest/config' som ikke resolves fra brain-mappa når CI bare
// kjører `npm ci` i havstund-brain/ (egen build-test-jobb uten rot-deps).
// 'root' låser config-/test-oppdagelsen til denne mappa.
export default defineConfig({
  root: __dirname,
  test: {
    // globals: true så testfiler kan bruke describe/it/expect uten import
    // (port-contract.test.ts gjør det). Speiler tidligere rot-config-atferd.
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
