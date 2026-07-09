/**
 * Steg B — agent-loop: foreslå-før-skriv, bekreft, invarianter.
 *
 * Eval scorer på HANDLINGER (verktøy-kall + port-state), ikke prosa (design §9):
 *  - lese-verktøy kjøres auto og muterer ikke
 *  - skrive-verktøy STOPPER som forslag (ingenting skrevet før confirm)
 *  - confirm utfører ÉN skriving og endrer port-state
 *  - forfalsket token / utløpt / dobbel confirm / sprengt kapasitet blokkeres
 *  - skygge-modus (allowWrites=false) skriver ALDRI
 *  - META: hvert skrive-verktøy har propose+execute-dekning
 */
import { describe, it, expect } from 'vitest';
import { Agent } from '../src/brain/agent.js';
import type { AgentDeps } from '../src/brain/agent.js';
import { InMemoryStore } from '../src/brain/store.js';
import { MockWebsiteAdapter } from '../src/adapters/mock-website-adapter.js';
import { StubAnthropic, textTurn, toolTurn, refusalTurn } from './anthropic-stub.js';
import { baseSeed } from './port-contract.test.js';
import { WRITE_TOOL_NAMES } from '../src/brain/tools.js';

const SECRET = 'agent-test-secret-0123456789';
const MODEL = 'claude-opus-4-8';

function makeAgent(queue: ReturnType<typeof textTurn>[], opts: Partial<AgentDeps> = {}) {
  const port = new MockWebsiteAdapter(baseSeed);
  const store = new InMemoryStore();
  const client = new StubAnthropic(queue);
  const agent = new Agent({
    client,
    port,
    store,
    model: MODEL,
    confirmSecret: SECRET,
    confirmTtlMin: 15,
    allowWrites: true,
    ...opts,
  });
  return { agent, port, store, client };
}

describe('lese-verktøy kjøres automatisk og muterer ikke', () => {
  it('check_availability → tekst-svar; ingen booking opprettes', async () => {
    const { agent, port } = makeAgent([
      toolTurn('check_availability', { activity_id: 1, dato: '2026-07-01', tid: '10:00' }),
      textTurn('Det er 3 ledige plasser kl 10:00.'),
    ]);
    const before = port.bookings.length;
    const turn = await agent.message({ text: 'Er det ledig 1. juli kl 10?' });
    expect(turn.kind).toBe('final');
    if (turn.kind === 'final') expect(turn.text).toContain('ledige');
    expect(port.bookings.length).toBe(before);
  });
});

describe('refusal håndteres før content', () => {
  it('stop_reason refusal → høflig final, ingen skriving', async () => {
    const { agent } = makeAgent([refusalTurn()]);
    const turn = await agent.message({ text: 'gjør noe ulovlig' });
    expect(turn.kind).toBe('final');
  });
});

describe('foreslå-før-skriv: create_booking', () => {
  it('skrive-tool STOPPER som forslag; ingenting skrevet før confirm', async () => {
    const { agent, port, store } = makeAgent([
      toolTurn('check_availability', { activity_id: 1, dato: '2026-07-01', tid: '10:00' }),
      toolTurn('create_booking', {
        activity_id: 1,
        navn: 'Ola',
        epost: 'ola@example.com',
        dato: '2026-07-01',
        tid: '10:00',
        antall: 2,
        idempotency_key: 'idem-1',
      }, { text: 'Jeg foreslår å opprette bookingen.' }),
    ]);
    const turn = await agent.message({ text: 'Book 2 plasser til Ola 1. juli kl 10' });
    expect(turn.kind).toBe('proposal');
    expect(port.bookings.length).toBe(0); // INGENTING skrevet
    if (turn.kind === 'proposal') {
      const pending = await store.getPending(turn.proposal.toolUseId);
      expect(pending?.status).toBe('pending');
      // audit har 'proposed' men ikke 'executed'
      const audit = await store.listAudit(turn.conversationId);
      expect(audit.some((a) => a.phase === 'proposed')).toBe(true);
      expect(audit.some((a) => a.phase === 'executed')).toBe(false);
    }
  });

  it('confirm med gyldig token utfører ÉN skriving og endrer port-state', async () => {
    const { agent, port } = makeAgent([
      toolTurn('create_booking', {
        activity_id: 1, navn: 'Ola', epost: 'ola@example.com',
        dato: '2026-07-01', tid: '10:00', antall: 2, idempotency_key: 'idem-2',
      }),
      textTurn('Bookingen er opprettet.'),
    ]);
    const turn = await agent.message({ text: 'book' });
    expect(turn.kind).toBe('proposal');
    if (turn.kind !== 'proposal') return;

    const res = await agent.confirm({
      toolUseId: turn.proposal.toolUseId,
      confirmToken: turn.proposal.confirmToken,
      conversationId: turn.conversationId,
      transcript: turn.transcript,
    });
    expect(res.executed).toBe(true);
    expect(port.bookings.length).toBe(1);
    expect(port.bookings[0]!.antall).toBe(2);
    expect(port.bookings[0]!.status).toBe('forespurt');
  });

  it('forfalsket confirm-token avvises; ingen skriving', async () => {
    const { agent, port } = makeAgent([
      toolTurn('create_booking', {
        activity_id: 1, navn: 'X', epost: 'x@example.com',
        dato: '2026-07-01', tid: '10:00', antall: 1, idempotency_key: 'idem-3',
      }),
    ]);
    const turn = await agent.message({ text: 'book' });
    if (turn.kind !== 'proposal') throw new Error('forventet forslag');
    const res = await agent.confirm({
      toolUseId: turn.proposal.toolUseId,
      confirmToken: 'forfalsket-token',
      conversationId: turn.conversationId,
    });
    expect(res.executed).toBeFalsy();
    expect(port.bookings.length).toBe(0);
  });

  it('dobbel confirm gir ikke dobbel booking (idempotens)', async () => {
    const { agent, port } = makeAgent([
      toolTurn('create_booking', {
        activity_id: 1, navn: 'Y', epost: 'y@example.com',
        dato: '2026-07-01', tid: '10:00', antall: 1, idempotency_key: 'idem-4',
      }),
      textTurn('ok'),
    ]);
    const turn = await agent.message({ text: 'book' });
    if (turn.kind !== 'proposal') throw new Error('forventet forslag');
    const first = await agent.confirm({
      toolUseId: turn.proposal.toolUseId,
      confirmToken: turn.proposal.confirmToken,
      conversationId: turn.conversationId,
      transcript: turn.transcript,
    });
    expect(first.executed).toBe(true);
    const second = await agent.confirm({
      toolUseId: turn.proposal.toolUseId,
      confirmToken: turn.proposal.confirmToken,
      conversationId: turn.conversationId,
      transcript: turn.transcript,
    });
    expect(second.executed).toBeFalsy();
    expect(port.bookings.length).toBe(1); // fortsatt én
  });

  it('confirm re-validerer kapasitet mot fersk DB (sprengt → blokkert)', async () => {
    const { agent, port } = makeAgent([
      toolTurn('create_booking', {
        activity_id: 1, navn: 'Sen', epost: 's@example.com',
        dato: '2026-07-01', tid: '10:00', antall: 3, idempotency_key: 'idem-5',
      }),
    ]);
    const turn = await agent.message({ text: 'book 3' });
    if (turn.kind !== 'proposal') throw new Error('forventet forslag');
    // Noen andre fyller opp slotten ETTER forslaget (kapasitet 3).
    await port.createBooking({ activity_id: 1, navn: 'Andre', epost: 'a@b.no', dato: '2026-07-01', tid: '10:00', antall: 3 });
    const res = await agent.confirm({
      toolUseId: turn.proposal.toolUseId,
      confirmToken: turn.proposal.confirmToken,
      conversationId: turn.conversationId,
    });
    expect(res.executed).toBeFalsy();
    expect(res.text.toLowerCase()).toContain('plass'); // "Ingen ledige plasser"
    expect(port.bookings.length).toBe(1); // bare den andre
  });

  it('skygge-modus (allowWrites=false) skriver ALDRI', async () => {
    const { agent, port } = makeAgent(
      [
        toolTurn('create_booking', {
          activity_id: 1, navn: 'Z', epost: 'z@example.com',
          dato: '2026-07-01', tid: '10:00', antall: 1, idempotency_key: 'idem-6',
        }),
      ],
      { allowWrites: false },
    );
    const turn = await agent.message({ text: 'book' });
    if (turn.kind !== 'proposal') throw new Error('forventet forslag');
    const res = await agent.confirm({
      toolUseId: turn.proposal.toolUseId,
      confirmToken: turn.proposal.confirmToken,
      conversationId: turn.conversationId,
    });
    expect(res.executed).toBeFalsy();
    expect(port.bookings.length).toBe(0);
  });

  it('tool_choice er aldri tvunget til skrive-verktøy', async () => {
    const { agent, client } = makeAgent([textTurn('hei')]);
    await agent.message({ text: 'hei' });
    for (const call of client.calls) {
      expect(call.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
    }
  });
});

describe('set_booking_status revalidering (stale + gyldig overgang)', () => {
  it('expected_status matcher ikke fersk DB → stale-write blokkert', async () => {
    const { agent, port } = makeAgent([
      toolTurn('set_booking_status', { id: 1, status: 'fullfort', expected_status: 'forespurt' }),
    ]);
    // booking 1 finnes og er allerede 'bekreftet' i DB (ikke 'forespurt')
    const b = await port.createBooking({ activity_id: 1, navn: 'B', epost: 'b@b.no', dato: '2026-07-01', tid: '10:00', antall: 1 });
    await port.setBookingStatus(b.id, 'bekreftet');
    const turn = await agent.message({ text: 'fullfør booking 1' });
    if (turn.kind !== 'proposal') throw new Error('forventet forslag');
    // confirm med riktig forslag-token, men DB er 'bekreftet' ikke 'forespurt'
    const res = await agent.confirm({
      toolUseId: turn.proposal.toolUseId,
      confirmToken: turn.proposal.confirmToken,
      conversationId: turn.conversationId,
    });
    expect(res.executed).toBeFalsy();
  });
});

describe('lærings-loop: lessons injiseres + memory-verktøy kjøres i loopen', () => {
  it('aktive lessons injiseres i system-prompten', async () => {
    const port = new MockWebsiteAdapter(baseSeed);
    const store = new InMemoryStore();
    await store.insertLesson({ domain: 'customer', type: 'preference', entity_ref: null, payload: { note: 'Svar alltid på norsk' }, confidence: 0.9, source: 'admin_correction', supersedes: null });
    const client = new StubAnthropic([textTurn('ok')]);
    const agent = new Agent({
      client, port, store, model: MODEL, confirmSecret: SECRET, confirmTtlMin: 15, allowWrites: true,
      getLessons: async () => store.getLessons({ domain: 'customer', status: 'active' }),
    });
    await agent.message({ text: 'hei' });
    expect(client.calls[0]!.system).toContain('Svar alltid på norsk');
  });

  it('save_lesson kjøres automatisk i loopen (ingen confirm) og persisteres', async () => {
    const port = new MockWebsiteAdapter(baseSeed);
    const store = new InMemoryStore();
    const client = new StubAnthropic([
      toolTurn('save_lesson', { domain: 'timesheet', type: 'pattern', entity_ref: 'ansatt:3', note: 'Per fører sjelden helg' }),
      textTurn('Notert.'),
    ]);
    const agent = new Agent({ client, port, store, model: MODEL, confirmSecret: SECRET, confirmTtlMin: 15, allowWrites: true });
    const turn = await agent.message({ text: 'Per jobber ikke lørdager' });
    expect(turn.kind).toBe('final'); // memory-verktøy gir ikke forslag
    const lessons = await store.getLessons({ domain: 'timesheet', entityRef: 'ansatt:3', status: 'active' });
    expect(lessons).toHaveLength(1);
  });
});

describe('META: hvert skrive-verktøy har propose+execute-dekning', () => {
  // Per-verktøy: ett scriptet tool_use → forslag → confirm → utført.
  const cases: Record<string, Record<string, unknown>> = {
    create_booking: { activity_id: 1, navn: 'M', epost: 'm@b.no', dato: '2026-07-01', tid: '10:00', antall: 1, idempotency_key: 'm-cb' },
    update_booking: { id: 0, melding: 'oppdatert', expected_updated_at: 'x' }, // id fylles under
    set_booking_status: { id: 0, status: 'bekreftet', expected_status: 'forespurt' },
    set_availability: { activity_id: 1, dato: '2026-08-01', slots: [{ tid: '09:00', kapasitet: 5 }], idempotency_key: 'm-sa' },
    set_opening_hours: { ukedag: 3, apner: '08:00', stenger: '16:00', stengt: false, idempotency_key: 'm-soh' },
    upsert_activity: { navn: 'Kajakk', pris: 300, kapasitet: 6, slug: 'kajakk', idempotency_key: 'm-ua' },
    set_activity_status: { id: 1, aktiv: false, idempotency_key: 'm-sas' },
    reply_to_customer: { bruker_id: 1, tekst: 'Hei, takk for henvendelsen!', idempotency_key: 'm-rtc' },
    log_staff_hours: { ansatt_id: 1, dato: '2026-07-01', timer: 6, idempotency_key: 'm-lsh' },
    opprett_regnskapspost: { type: 'utgift', dato: '2026-07-01', beskrivelse: 'Kvittering: kaffe', konto: 4000, mva_sats: 25, brutto_ore: 12500, betalingsmetode: 'kort', idempotency_key: 'm-orp' },
    update_site_content: { nokkel: 'forside.tittel', verdi: 'Velkommen til Havstund', expected_version: null },
  };

  for (const name of WRITE_TOOL_NAMES) {
    it(`${name}: forslag → confirm → utført`, async () => {
      const input = { ...cases[name]! };
      const { agent, port } = makeAgent([
        toolTurn(name, input),
        textTurn('Utført.'),
      ]);
      // For booking-muterende verktøy: lag en booking å peke på.
      if (name === 'update_booking' || name === 'set_booking_status') {
        const b = await port.createBooking({ activity_id: 1, navn: 'Seed', epost: 's@b.no', dato: '2026-07-01', tid: '10:00', antall: 1 });
        (input as { id: number }).id = b.id;
      }
      const turn = await agent.message({ text: `kjør ${name}` });
      expect(turn.kind, `${name} skal bli forslag`).toBe('proposal');
      if (turn.kind !== 'proposal') return;
      expect(turn.proposal.toolName).toBe(name);
      const res = await agent.confirm({
        toolUseId: turn.proposal.toolUseId,
        confirmToken: turn.proposal.confirmToken,
        conversationId: turn.conversationId,
        transcript: turn.transcript,
      });
      expect(res.executed, `${name} skal utføres etter confirm`).toBe(true);
    });
  }
});
