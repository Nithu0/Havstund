/**
 * Steg C — minne-/lærings-hjerne: domene-isolasjon + anti-rot + retrieval.
 *
 * Evals scorer på HANDLINGER (hva som faktisk havner i store / hvilke lessons
 * som injiseres), ikke prosa (design §9):
 *  - ingen kryss-domene-skriv (booking-type i timesheet avvises)
 *  - assertNoHardState blokkerer fersk tilstand i minnet
 *  - lærte korreksjoner versjoneres og hentes for riktig domene/entitet
 *  - getRelevantLessons isolerer domener fysisk
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../src/brain/store.js';
import { writeLesson, getRelevantLessons, assertNoHardState, LessonError } from '../src/brain/memory/write-lesson.js';
import { runMemoryTool } from '../src/brain/memory/tools.js';

let store: InMemoryStore;
beforeEach(() => {
  store = new InMemoryStore();
});

describe('domene-isolasjon (ingen kryss-domene)', () => {
  it('lovlig type i riktig domene lagres', async () => {
    const l = await writeLesson(store, { domain: 'customer', type: 'profile', entity_ref: 'kunde:12', payload: { note: 'Liker korte svar', tone: 'kort' }, source: 'admin_correction' });
    expect(l.domain).toBe('customer');
    expect(l.status).toBe('active');
  });

  it("'profile' er ikke lovlig i booking-domenet → avvises", async () => {
    await expect(
      writeLesson(store, { domain: 'booking', type: 'profile', payload: { note: 'x' }, source: 'admin_correction' }),
    ).rejects.toBeInstanceOf(LessonError);
  });

  it('ukjent domene avvises', async () => {
    await expect(
      // @ts-expect-error bevisst ugyldig domene
      writeLesson(store, { domain: 'penger', type: 'preference', payload: { note: 'x' }, source: 's' }),
    ).rejects.toMatchObject({ code: 'bad_domain' });
  });

  it('en lesson lekker ALDRI inn i et annet domene', async () => {
    await writeLesson(store, { domain: 'timesheet', type: 'pattern', entity_ref: 'ansatt:3', payload: { note: 'Per fører sjelden helg', ansatt_id: 3 }, source: 'admin_correction' });
    const booking = await getRelevantLessons(store, 'booking');
    const calendar = await getRelevantLessons(store, 'calendar');
    const timesheet = await getRelevantLessons(store, 'timesheet', 'ansatt:3');
    expect(booking).toHaveLength(0);
    expect(calendar).toHaveLength(0);
    expect(timesheet).toHaveLength(1);
  });
});

describe('anti-rot: assertNoHardState', () => {
  it('blokkerer fersk tilstand (status) i payload', () => {
    expect(() => assertNoHardState({ note: 'x', status: 'bekreftet' })).toThrow(LessonError);
  });
  it('blokkerer dypt nestet fersk tilstand (timer)', () => {
    expect(() => assertNoHardState({ note: 'x', meta: { detalj: { timer: 8 } } })).toThrow(LessonError);
  });
  it('tillater ren erfaring uten tilstand', () => {
    expect(() => assertNoHardState({ note: 'Kunden snakker engelsk', language: 'en' })).not.toThrow();
  });
  it('writeLesson avviser payload som inneholder hard state', async () => {
    await expect(
      writeLesson(store, { domain: 'booking', type: 'correction', payload: { note: 'x', antall: 5 }, source: 's' }),
    ).rejects.toMatchObject({ code: 'hard_state' });
  });
});

describe('versjonering + lærte korreksjoner anvendt', () => {
  it('correct_lesson supersederer forrige aktive for samme domene/type/entitet', async () => {
    const first = await runMemoryTool(store, 'save_lesson', { domain: 'calendar', type: 'preference', entity_ref: 'ukedag:6', note: 'Vi har vanligvis åpent lørdag' });
    expect(first.isError).toBe(false);
    const second = await runMemoryTool(store, 'correct_lesson', { domain: 'calendar', type: 'preference', entity_ref: 'ukedag:6', note: 'Korreksjon: vi holder stengt lørdager i lavsesong' });
    expect(second.isError).toBe(false);

    const active = await getRelevantLessons(store, 'calendar', 'ukedag:6');
    expect(active).toHaveLength(1);
    expect(JSON.stringify((active[0]!.payload as { note: string }).note)).toContain('stengt');
    expect(active[0]!.version).toBe(2);
    expect(active[0]!.supersedes).not.toBeNull();
  });
});

describe('retrieval: entity-spesifikk + domene-generell', () => {
  it('getRelevantLessons henter både entitets- og generelle lessons i domenet', async () => {
    await writeLesson(store, { domain: 'customer', type: 'preference', entity_ref: null, payload: { note: 'Vær alltid høflig' }, source: 's' });
    await writeLesson(store, { domain: 'customer', type: 'profile', entity_ref: 'kunde:12', payload: { note: 'Foretrekker SMS' }, source: 's' });
    const forKunde = await getRelevantLessons(store, 'customer', 'kunde:12');
    expect(forKunde).toHaveLength(2);
    // entitets-spesifikk kommer først
    expect(forKunde[0]!.entity_ref).toBe('kunde:12');
  });
});

describe('memory-verktøy via dispatcher', () => {
  it('retire_lesson setter status retired', async () => {
    const saved = await runMemoryTool(store, 'save_lesson', { domain: 'global', type: 'preference', note: 'Bruk fornavn' });
    const id = (saved.value as { lesson: { id: number } }).lesson.id;
    const ret = await runMemoryTool(store, 'retire_lesson', { id });
    expect(ret.isError).toBe(false);
    const active = await getRelevantLessons(store, 'global');
    expect(active).toHaveLength(0);
  });

  it('save_lesson med ulovlig domene-enum gir feil (ikke kast)', async () => {
    const r = await runMemoryTool(store, 'save_lesson', { domain: 'tull', type: 'preference', note: 'x' });
    expect(r.isError).toBe(true);
  });

  it('save_lesson lagrer kun note som payload — ekstra felt (hard state) slipper aldri inn', async () => {
    const r = await runMemoryTool(store, 'save_lesson', { domain: 'booking', type: 'correction', note: 'x', status: 'bekreftet' } as Record<string, unknown>);
    expect(r.isError).toBe(false);
    const saved = (r.value as { lesson: { payload: Record<string, unknown> } }).lesson;
    expect(saved.payload).toEqual({ note: 'x' });
    expect('status' in saved.payload).toBe(false);
  });
});
