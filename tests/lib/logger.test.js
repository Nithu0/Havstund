// describe/it/expect er globale (vitest.config.js -> globals: true)
const { logger, lagRequestLogger } = require('../../lib/logger');

describe('lib/logger', () => {
  it('logger har info/error/warn/debug-metoder', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('logger.info kaster ikke når den kalles', () => {
    expect(() => logger.info('test-melding')).not.toThrow();
    expect(() => logger.error({ feil: 'x' }, 'feilmelding')).not.toThrow();
  });

  it('lagRequestLogger returnerer en middleware-funksjon', () => {
    const mw = lagRequestLogger();
    expect(typeof mw).toBe('function');
  });
});
