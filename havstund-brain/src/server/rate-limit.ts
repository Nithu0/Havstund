/**
 * Havstund Brain — enkel per-aktør rate-limit (design §8) på /agent/ask og
 * /agent/confirm. Sliding window i minne (én prosess). Returnerer 429 ved brudd.
 */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max: number, private windowMs: number) {}

  /** true = tillatt, false = over grensen. */
  allow(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}
