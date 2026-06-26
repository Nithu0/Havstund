// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
const sentry = require('../../lib/sentry');

describe('lib/sentry', () => {
  // Rydd Sentry-env før hver test så vi tester deterministisk.
  const lagret = {};
  const NOKLER = ['SENTRY_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_TRACES_SAMPLE_RATE'];

  beforeEach(() => {
    for (const k of NOKLER) { lagret[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of NOKLER) {
      if (lagret[k] === undefined) delete process.env[k];
      else process.env[k] = lagret[k];
    }
  });

  it('isConfigured er false uten SENTRY_DSN', () => {
    expect(sentry.isConfigured()).toBe(false);
  });

  it('isConfigured er false når DSN er tom/whitespace', () => {
    process.env.SENTRY_DSN = '   ';
    expect(sentry.isConfigured()).toBe(false);
  });

  it('isConfigured er true når SENTRY_DSN er satt', () => {
    process.env.SENTRY_DSN = 'https://abc@o0.ingest.sentry.io/1';
    expect(sentry.isConfigured()).toBe(true);
  });

  it('init er no-op (returnerer false) uten DSN', () => {
    const app = { use() { throw new Error('app skal ikke berøres uten DSN'); } };
    expect(sentry.init(app)).toBe(false);
    // Uten init skal captureException heller ikke kaste.
    expect(() => sentry.captureException(new Error('boom'))).not.toThrow();
  });

  it('captureException kaster ikke når ikke initialisert', () => {
    expect(() => sentry.captureException(new Error('uinitialisert'))).not.toThrow();
    expect(() => sentry.captureException(new Error('med ctx'), { level: 'error' })).not.toThrow();
  });
});
