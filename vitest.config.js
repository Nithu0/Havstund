import { defineConfig } from 'vitest/config';

// globals: true gjør describe/it/expect/vi tilgjengelig uten import,
// slik at testfilene kan bruke CommonJS require() for modulene som testes.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
