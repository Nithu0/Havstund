import { defineConfig } from 'vitest/config';

// globals: true gjør describe/it/expect/vi tilgjengelig uten import,
// slik at testfilene kan bruke CommonJS require() for modulene som testes.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // havstund-brain er et eget npm-package med egen vitest + egen CI-jobb
    // (.github/workflows/havstund-brain.yml). Ekskluder det fra nettsidens
    // suite så de to ikke kobles og brain-TS ikke kjøres uten brain-deps.
    exclude: ['node_modules/**', 'dist/**', 'havstund-brain/**'],
  },
});
