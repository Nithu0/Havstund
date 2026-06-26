/**
 * Havstund Brain — kryptografisk bekreftelses-handshake (invariant #2).
 *
 * Når agenten foreslår en skriving genererer vi en HMAC over (tool_use_id,
 * tool_name, kanonisk input). /confirm må sende NØYAKTIG samme token tilbake.
 * Et forfalsket eller manipulert token avvises (timing-safe sammenligning).
 * Dette gjør at ingen skriving kan utføres uten et gyldig, server-signert
 * forslag — selv om noen treffer /confirm direkte.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stabil JSON: nøkler sortert rekursivt, så samme input → samme streng. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function signConfirmToken(
  secret: string,
  parts: { toolUseId: string; toolName: string; input: unknown },
): string {
  const payload = `${parts.toolUseId}\n${parts.toolName}\n${canonicalJson(parts.input)}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyConfirmToken(
  secret: string,
  parts: { toolUseId: string; toolName: string; input: unknown },
  candidate: string,
): boolean {
  const expected = signConfirmToken(secret, parts);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate ?? '', 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
