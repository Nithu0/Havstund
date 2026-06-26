/**
 * Havstund Brain — operatør-token-verifisering.
 *
 * Nettside-shimen (kun innenfor requireRole('admin') + ai_agent_enabled) sender
 * BRAIN_OPERATOR_TOKEN i Authorization: Bearer. Brain stoler ALDRI på dette
 * alene for autorisasjon — nettsiden har allerede gjort admin/utvalgt-gatingen.
 * Tokenet beviser bare at kallet kom fra shimen, ikke fra åpen internett.
 * Timing-safe sammenligning.
 */
import { timingSafeEqual } from 'node:crypto';

export function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1]!.trim() : null;
}

export function verifyOperatorToken(expected: string, candidate: string | null): boolean {
  if (!candidate) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(candidate, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
