// Havstund Brain — ESLint flat config (eslint 9 + typescript-eslint).
// Lett oppsett uten type-aware-regler (raskt i CI). Lint-feil blokkerer ikke
// CI separat, men holdes ren under utvikling.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: { process: 'readonly' },
    },
  },
);
