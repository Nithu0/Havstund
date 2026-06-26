/**
 * Havstund Brain — memory-verktøy (save_lesson / retire_lesson / correct_lesson).
 *
 * Disse er agent-verktøy som skriver til minne-laget (lessons), ikke til
 * nettsiden. `domain` er en STRICT enum (design §7) — modellen kan ikke finne
 * på et domene. All skriving går via writeLesson-routeren, så domene-isolasjon
 * og assertNoHardState håndheves uansett hvordan verktøyet kalles.
 *
 * De fanges som SKRIVE-i-betydning, men de er trygge (ingen penge-/booking-
 * effekt) og krever ikke confirm-handshaket — de endrer kun agentens hukommelse.
 */
import { z } from 'zod';
import type { BrainStore, LessonDomain } from '../store.js';
import { writeLesson, LessonError } from './write-lesson.js';

const DOMAIN_ENUM = ['booking', 'timesheet', 'calendar', 'customer', 'global'] as const;

export interface MemoryToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export const MEMORY_TOOLS: MemoryToolDef[] = [
  {
    name: 'save_lesson',
    description:
      'Lagre en lærdom (preferanse/korreksjon/mønster) i minnet. domain er strengt: booking|timesheet|calendar|customer|global. Lagre ALDRI fersk tilstand (status, beløp, kapasitet, timer) — slikt hentes alltid fra databasen.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        domain: { type: 'string', enum: [...DOMAIN_ENUM] },
        type: { type: 'string', enum: ['preference', 'correction', 'pattern', 'profile'] },
        entity_ref: { type: ['string', 'null'], description: 'F.eks. "ansatt:3" eller "kunde:12". Null = domene-generell.' },
        note: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['domain', 'type', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'correct_lesson',
    description:
      'Registrer en admin-korreksjon som en ny, versjonert lesson (erstatter forrige aktive for samme domene/type/entitet).',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        domain: { type: 'string', enum: [...DOMAIN_ENUM] },
        type: { type: 'string', enum: ['preference', 'correction', 'pattern', 'profile'] },
        entity_ref: { type: ['string', 'null'] },
        note: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['domain', 'type', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'retire_lesson',
    description: 'Pensjoner (soft-delete) en lesson på id når den ikke lenger gjelder.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];

export const MEMORY_TOOL_NAMES = MEMORY_TOOLS.map((t) => t.name);

const saveInput = z.object({
  domain: z.enum(DOMAIN_ENUM),
  type: z.string(),
  entity_ref: z.string().nullable().optional(),
  note: z.string(),
  confidence: z.number().min(0).max(1).optional(),
});

export interface MemoryToolResult {
  value: unknown;
  isError: boolean;
}

/** Utfør et memory-verktøy mot store. Brukes av agent-loopen (lese-aktig:
 *  ingen confirm), eller direkte i evals. */
export async function runMemoryTool(
  store: BrainStore,
  name: string,
  rawInput: Record<string, unknown>,
  source = 'admin_correction',
): Promise<MemoryToolResult> {
  try {
    if (name === 'save_lesson' || name === 'correct_lesson') {
      const input = saveInput.parse(rawInput);
      const row = await writeLesson(store, {
        domain: input.domain as LessonDomain,
        type: input.type,
        entity_ref: input.entity_ref ?? null,
        payload: { note: input.note },
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        source,
      });
      return { value: { ok: true, lesson: row }, isError: false };
    }
    if (name === 'retire_lesson') {
      const id = Number(rawInput.id);
      const row = await store.setLessonStatus(id, 'retired');
      if (!row) return { value: { ok: false, error: 'Fant ikke lesson' }, isError: true };
      return { value: { ok: true, lesson: row }, isError: false };
    }
    return { value: { error: `Ukjent memory-verktøy: ${name}` }, isError: true };
  } catch (e) {
    const msg = e instanceof LessonError ? e.message : e instanceof Error ? e.message : 'Feil i memory-verktøy';
    return { value: { ok: false, error: msg }, isError: true };
  }
}

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL_NAMES.includes(name);
}
