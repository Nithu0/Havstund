// describe/it/expect er globale (vitest.config.js -> globals: true)
const { mvaSplitt } = require('../../lib/regnskap');

describe('mvaSplitt', () => {
  it('splitter 50000 øre @ 25% i netto 40000 / mva 10000 / brutto 50000', () => {
    expect(mvaSplitt(50000, 25)).toMatchObject({
      netto_ore: 40000,
      mva_ore: 10000,
      brutto_ore: 50000,
    });
  });

  it('bevarer brutto eksakt (netto + mva === brutto)', () => {
    const r = mvaSplitt(12345, 25);
    expect(r.netto_ore + r.mva_ore).toBe(r.brutto_ore);
  });

  it('kaster på negativt beløp', () => {
    expect(() => mvaSplitt(-1, 25)).toThrow();
  });

  it('kaster på ugyldig MVA-sats (7)', () => {
    expect(() => mvaSplitt(50000, 7)).toThrow();
  });
});
