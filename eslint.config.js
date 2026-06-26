// ESLint v9 flat config (CommonJS project)
// Erstatter legacy .eslintrc.json + .eslintignore.
// Mål: mild lint — 0 errors på eksisterende kode, warnings OK.

const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  // Globale ignores (erstatter .eslintignore)
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "build/**",
      "public/**", // frontend vanilla — egne globals, ikke lint her
      "**/*.min.js",
    ],
  },

  // Anbefalt baseline
  js.configs.recommended,

  // Node CommonJS-kildekode (.js i prosjektroten + undermapper)
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "no-constant-condition": ["warn", { checkLoops: false }],
      "prefer-const": "warn",
      "no-var": "warn",
      eqeqeq: ["warn", "smart"],
      "no-irregular-whitespace": "warn",
      "no-undef": "error",
    },
  },

  // ESM config-filer (vitest.config.js o.l. bruker import/export).
  // eslint.config.js selv er CommonJS og treffes ikke her.
  {
    files: ["**/*.config.js"],
    ignores: ["eslint.config.js"],
    languageOptions: {
      sourceType: "module",
    },
  },

  // Test-filer (vitest globals)
  {
    files: ["tests/**/*.js", "**/*.test.js"],
    languageOptions: {
      globals: {
        ...globals.node,
        describe: "readonly",
        it: "readonly",
        test: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        vi: "readonly",
      },
    },
  },
];
