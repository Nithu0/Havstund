/**
 * Havstund Brain — writeLesson: ENESTE skrivevei inn i minne-laget (design §7).
 *
 * Anti-rot-rekkefølge (alle må passere, ellers kastes skrivingen):
 *  1. domenet må være et lovlig domene
 *  2. typen må være lovlig I DET domenet (ingen kryss-domene-typer)
 *  3. payload må validere mot DOMENETS schema
 *  4. assertNoHardState: ingen fersk-tilstand-felter får havne i minnet
 *
 * Resultatet versjoneres (supersedes forrige aktive med samme domain+type+entityRef).
 * Dette gjør at minnet aldri kan bli stale (det inneholder ingen tilstand) og
 * aldri overstyre DB (harde fakta hentes alltid via lese-verktøy).
 */
import { ZodError } from 'zod';
import { DOMAIN_PAYLOAD, DOMAIN_TYPES, FORBIDDEN_HARD_STATE_KEYS } from './schemas.js';
import type { BrainStore, LessonDomain, LessonRow, NewLesson } from '../store.js';

export class LessonError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LessonError';
    this.code = code;
  }
}

const VALID_DOMAINS: LessonDomain[] = ['booking', 'timesheet', 'calendar', 'customer', 'global'];

/** Dyp skanning: kaster hvis et forbudt nøkkelnavn finnes hvor som helst. */
export function assertNoHardState(payload: unknown, path = 'payload'): void {
  if (payload == null || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoHardState(v, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (FORBIDDEN_HARD_STATE_KEYS.includes(k.toLowerCase())) {
      throw new LessonError(
        'hard_state',
        `Minne-laget kan ikke lagre fersk tilstand: feltet "${k}" (${path}) hører hjemme i databasen, ikke i en lesson.`,
      );
    }
    assertNoHardState(v, `${path}.${k}`);
  }
}

export async function writeLesson(store: BrainStore, intent: NewLesson): Promise<LessonRow> {
  // 1. domene
  if (!VALID_DOMAINS.includes(intent.domain)) {
    throw new LessonError('bad_domain', `Ukjent domene: ${intent.domain}`);
  }
  // 2. type lovlig i domenet
  const allowedTypes = DOMAIN_TYPES[intent.domain];
  if (!allowedTypes.includes(intent.type)) {
    throw new LessonError(
      'bad_type',
      `Typen "${intent.type}" er ikke lovlig i domenet "${intent.domain}" (lovlige: ${allowedTypes.join(', ')}).`,
    );
  }
  // 3. ingen fersk tilstand — sjekk RÅ payload FØR zod evt. stripper ukjente
  //    nøkler, ellers kunne en hard-state-nøkkel forsvinne stille og uoppdaget.
  assertNoHardState(intent.payload);

  // 4. payload validerer mot domene-schema
  const schema = DOMAIN_PAYLOAD[intent.domain];
  let payload: unknown;
  try {
    payload = schema.parse(intent.payload);
  } catch (e) {
    const detail = e instanceof ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(e);
    throw new LessonError('bad_payload', `Payload validerer ikke mot ${intent.domain}-schema: ${detail}`);
  }
  // dobbeltsjekk normalisert payload (skal alltid passere etter pkt. 3)
  assertNoHardState(payload);

  return store.insertLesson({
    domain: intent.domain,
    type: intent.type,
    entity_ref: intent.entity_ref ?? null,
    payload,
    confidence: intent.confidence ?? 0.7,
    source: intent.source,
    supersedes: intent.supersedes ?? null,
  });
}

/**
 * Retrieval (design §7): KUN relevante lessons for (domain, entityRef) injiseres.
 * Henter både entity-spesifikke OG domene-generelle (entity_ref null) lessons.
 */
export async function getRelevantLessons(
  store: BrainStore,
  domain: LessonDomain,
  entityRef?: string | null,
): Promise<LessonRow[]> {
  const general = await store.getLessons({ domain, entityRef: null, status: 'active' });
  if (entityRef == null) return general;
  const specific = await store.getLessons({ domain, entityRef, status: 'active' });
  // entity-spesifikke først (mer presise), så generelle.
  const seen = new Set(specific.map((l) => l.id));
  return [...specific, ...general.filter((l) => !seen.has(l.id))];
}
