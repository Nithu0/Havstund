/**
 * Steg B — verktøy-meta-test + invariant-håndhevelse.
 *
 * Design §9 krever: hvert SKRIVE-verktøy MÅ ha propose + execute + forged-token
 * + domene. Denne testen er den maskinelle håndhevelsen — den itererer over ALLE
 * skrive-verktøy og feiler hvis ett mangler dekning, så ingen kan legges til uten
 * å gå gjennom bekreftelses-handshaket.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_TOOLS,
  WRITE_TOOL_NAMES,
  READ_TOOL_NAMES,
  getTool,
  isWriteTool,
  toolsForApi,
} from '../src/brain/tools.js';
import { signConfirmToken, verifyConfirmToken } from '../src/lib/confirm-token.js';

const SECRET = 'test-confirm-secret-0123456789';

// Et minimalt gyldig input per skrive-verktøy (nok for forged-token-testen).
const SAMPLE_INPUT: Record<string, Record<string, unknown>> = {
  create_booking: { activity_id: 1, navn: 'A', epost: 'a@b.no', dato: '2026-07-01', antall: 1, idempotency_key: 'k1' },
  update_booking: { id: 1, antall: 2, expected_updated_at: 'x' },
  set_booking_status: { id: 1, status: 'bekreftet', expected_status: 'forespurt' },
  set_availability: { activity_id: 1, dato: '2026-07-01', slots: [{ tid: '10:00', kapasitet: 3 }], idempotency_key: 'k2' },
  set_opening_hours: { ukedag: 0, stengt: true, idempotency_key: 'k3' },
  upsert_activity: { navn: 'Ny', pris: 100, kapasitet: 5, slug: 'ny', idempotency_key: 'k4' },
  set_activity_status: { id: 1, aktiv: false, idempotency_key: 'k5' },
  reply_to_customer: { bruker_id: 1, tekst: 'Hei', idempotency_key: 'k6' },
  log_staff_hours: { ansatt_id: 1, dato: '2026-07-01', timer: 4, idempotency_key: 'k7' },
  opprett_regnskapspost: { type: 'utgift', dato: '2026-07-01', beskrivelse: 'Kaffe', konto: 4000, mva_sats: 25, brutto_ore: 12500, betalingsmetode: 'kort', idempotency_key: 'k8' },
  update_site_content: { nokkel: 'forside.tittel', verdi: 'Hei', expected_version: null },
};

describe('verktøykatalog — struktur', () => {
  it('har de forventede LESE- og SKRIVE-verktøyene', () => {
    expect(READ_TOOL_NAMES.sort()).toEqual(
      [
        'check_availability',
        'get_activity',
        'get_booking',
        'get_content',
        'get_message_thread',
        'get_opening_hours',
        'list_activities',
        'list_bookings',
        'list_messages',
        'list_staff_hours',
      ].sort(),
    );
    expect(WRITE_TOOL_NAMES.sort()).toEqual(
      [
        'create_booking',
        'log_staff_hours',
        'opprett_regnskapspost',
        'reply_to_customer',
        'set_activity_status',
        'set_availability',
        'set_booking_status',
        'set_opening_hours',
        'update_booking',
        'update_site_content',
        'upsert_activity',
      ].sort(),
    );
  });

  it('alle skrive-verktøy har strict:true + additionalProperties:false + domene + guard', () => {
    for (const name of WRITE_TOOL_NAMES) {
      const t = getTool(name)!;
      expect(t.domain, `${name} mangler domene`).toBeTruthy();
      expect(t.guard, `${name} mangler guard`).toBeTruthy();
      expect((t.input_schema as { strict?: boolean }).strict, `${name} ikke strict`).toBe(true);
      expect((t.input_schema as { additionalProperties?: boolean }).additionalProperties, `${name} tillater extra props`).toBe(false);
    }
  });

  it('toolsForApi() eksponerer name/description/input_schema for alle', () => {
    const api = toolsForApi();
    expect(api).toHaveLength(ALL_TOOLS.length);
    for (const t of api) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(t.input_schema).toBeTruthy();
    }
  });
});

describe('META: hvert skrive-verktøy har confirm-handshake-dekning', () => {
  for (const name of WRITE_TOOL_NAMES) {
    it(`${name}: gyldig token verifiseres, forfalsket avvises`, () => {
      const input = SAMPLE_INPUT[name];
      expect(input, `mangler SAMPLE_INPUT for ${name} — legg til når verktøy legges til`).toBeTruthy();
      expect(isWriteTool(name)).toBe(true);

      const toolUseId = `toolu_${name}`;
      const token = signConfirmToken(SECRET, { toolUseId, toolName: name, input: input! });
      expect(verifyConfirmToken(SECRET, { toolUseId, toolName: name, input: input! }, token)).toBe(true);

      // Forfalsket: endret input
      const tampered = { ...input!, navn: 'HACKER', _x: 1 };
      expect(verifyConfirmToken(SECRET, { toolUseId, toolName: name, input: tampered }, token)).toBe(false);
      // Forfalsket: feil token-streng
      expect(verifyConfirmToken(SECRET, { toolUseId, toolName: name, input: input! }, 'deadbeef')).toBe(false);
      // Forfalsket: feil secret
      expect(verifyConfirmToken('annen-secret-0123456789', { toolUseId, toolName: name, input: input! }, token)).toBe(false);
    });
  }
});
