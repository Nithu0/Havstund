// globals: true gjør describe/it/expect/vi tilgjengelig uten import,
// slik at testfilene kan bruke CommonJS require() for modulene som testes.
//
// Skrevet som CommonJS (module.exports), ikke ESM. package.json har
// "type": "commonjs", så en fil med import-syntaks her lastes som CJS av Vite
// sin kompatibilitetslaster. Vite 8 advarer om at den lasteren forsvinner i en
// framtidig hovedversjon. Alternativet var å døpe fila om til .mjs, men navnet
// står i eslint.config.js og i kommentaren øverst i et femtens testfiler —
// denne formen holder navnet og fjerner advarselen.
const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // havstund-brain er et eget npm-package med egen vitest + egen CI-jobb
    // (.github/workflows/havstund-brain.yml). Ekskluder det fra nettsidens
    // suite så de to ikke kobles og brain-TS ikke kjøres uten brain-deps.
    exclude: ['node_modules/**', 'dist/**', 'havstund-brain/**'],
  },
});
