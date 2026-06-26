/**
 * Steg D — operatør-token + rate-limit (design §8).
 */
import { describe, it, expect } from 'vitest';
import { extractBearer, verifyOperatorToken } from '../src/server/auth.js';
import { RateLimiter } from '../src/server/rate-limit.js';

describe('operatør-token', () => {
  const SECRET = 'operator-token-0123456789';
  it('extractBearer plukker token fra header', () => {
    expect(extractBearer('Bearer abc')).toBe('abc');
    expect(extractBearer('bearer abc')).toBe('abc');
    expect(extractBearer(undefined)).toBeNull();
    expect(extractBearer('Basic xyz')).toBeNull();
  });
  it('verifyOperatorToken: riktig token true, feil/null false (timing-safe)', () => {
    expect(verifyOperatorToken(SECRET, SECRET)).toBe(true);
    expect(verifyOperatorToken(SECRET, 'feil')).toBe(false);
    expect(verifyOperatorToken(SECRET, null)).toBe(false);
    expect(verifyOperatorToken(SECRET, SECRET + 'x')).toBe(false);
  });
});

describe('rate-limit', () => {
  it('slipper opp til max og blokkerer deretter (429-grunnlag)', () => {
    const rl = new RateLimiter(3, 1000);
    const t0 = 1000;
    expect(rl.allow('a', t0)).toBe(true);
    expect(rl.allow('a', t0)).toBe(true);
    expect(rl.allow('a', t0)).toBe(true);
    expect(rl.allow('a', t0)).toBe(false); // 4. blokkeres
    // annen aktør upåvirket
    expect(rl.allow('b', t0)).toBe(true);
    // etter vindu åpner det igjen
    expect(rl.allow('a', t0 + 1001)).toBe(true);
  });
});
