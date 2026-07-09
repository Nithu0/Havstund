// describe/it/expect er globale (vitest.config.js -> globals: true).
// F40 — sammenlignBookinger må gi en gyldig totalordning: 0 ved likhet, og
// konsistent antisymmetri (cmp(a,b) og cmp(b,a) har motsatt fortegn). Ren
// enhetstest av komparatoren fra public/js/bookinger.js — ingen DOM, intet nett
// (bootstrap er nettleser-gated, så require() i node kjører ingen bivirkninger).
const { sammenlignBookinger } = require('../../public/js/bookinger');

const b = (dato) => ({ dato });

describe('F40 — sammenlignBookinger (totalordning)', () => {
  it('returnerer 0 ved lik dato', () => {
    expect(sammenlignBookinger(b('2026-06-25'), b('2026-06-25'))).toBe(0);
  });

  it('er antisymmetrisk: cmp(a,b) og cmp(b,a) har motsatt fortegn', () => {
    const x = b('2026-06-20');
    const y = b('2026-07-01');
    expect(Math.sign(sammenlignBookinger(x, y))).toBe(-Math.sign(sammenlignBookinger(y, x)));
  });

  it('sorterer nyeste dato først (synkende) og er konsistent (Array.sort)', () => {
    const rader = [b('2026-06-25'), b('2026-07-10'), b('2026-06-25'), b('2026-05-01'), b('2026-07-10')];
    const sortert = rader.slice().sort(sammenlignBookinger).map((r) => r.dato);
    expect(sortert).toEqual(['2026-07-10', '2026-07-10', '2026-06-25', '2026-06-25', '2026-05-01']);
  });

  it('transitivitet: a>b>c gir a>c', () => {
    const a = b('2026-07-10'); // nyest -> sorteres først -> minst i komparator
    const m = b('2026-06-25');
    const c = b('2026-05-01');
    expect(sammenlignBookinger(a, m)).toBeLessThan(0);
    expect(sammenlignBookinger(m, c)).toBeLessThan(0);
    expect(sammenlignBookinger(a, c)).toBeLessThan(0);
  });

  it('håndterer tomme/manglende datoer uten å kaste', () => {
    expect(sammenlignBookinger(b(''), b(''))).toBe(0);
    expect(() => [b('2026-06-25'), b(''), b(null)].sort(sammenlignBookinger)).not.toThrow();
  });
});
