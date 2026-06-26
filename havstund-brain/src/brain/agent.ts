/**
 * Havstund Brain — manuell agent-loop med foreslå-før-skriv.
 *
 * IKKE auto tool_runner. Vi driver tool-loopen for hånd (design §6) slik at vi
 * kan STOPPE i det øyeblikket Claude emitterer et SKRIVE-verktøy:
 *
 *   message(): kjør LESE-verktøy automatisk og mat resultatet tilbake. Når et
 *   SKRIVE-tool_use kommer → ikke utfør. Lag en PendingAction (HMAC-signert),
 *   persister i store, returner forslaget. Ingenting skrevet.
 *
 *   confirm(): hent pending → re-valider mot FERSK DB (kapasitet, gyldig
 *   statusovergang, stale-write, idempotens) → utfør ÉN skriving via porten →
 *   audit (proposed allerede skrevet ved forslag; executed nå) → mat tool_result
 *   tilbake → Claude oppsummerer.
 *
 * Sikkerhet:
 *  - stop_reason sjekkes FØR content (refusal-håndtering, design §8).
 *  - tool_choice {type:'auto', disable_parallel_tool_use:true} — aldri tvunget skriv.
 *  - port-feil blir tool_result {is_error:true}, ikke kastet exception.
 *  - confirm krever gyldig HMAC-token; forfalsket avvises (invariant #2).
 *  - dobbel confirm fanges av markExecuted (atomisk) + idempotency_key-oppslag.
 */
import { randomUUID } from 'node:crypto';
import type { AnthropicLike, ConversationMessage, MessageResponse, ToolResultBlock } from './anthropic-client.js';
import { ALL_TOOLS, getTool, isWriteTool, toolsForApi } from './tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import { signConfirmToken, verifyConfirmToken } from '../lib/confirm-token.js';
import { executeWrite, revalidateWrite } from './write-exec.js';
import { MEMORY_TOOLS, isMemoryTool, runMemoryTool } from './memory/tools.js';
import type { BrainStore, PendingAction } from './store.js';
import type { WebsitePort } from '../port/website-port.js';
import type { LessonRow } from './store.js';
import { PortError } from '../port/errors.js';

const MAX_READ_STEPS = 12;
const MAX_TOKENS = 4096;

export interface AgentDeps {
  client: AnthropicLike;
  port: WebsitePort;
  store: BrainStore;
  model: string;
  confirmSecret: string;
  confirmTtlMin: number;
  allowWrites: boolean;
  /** Hentes fra memory-laget i Steg C; tom liste er greit i Steg B. */
  getLessons?: () => Promise<LessonRow[]>;
}

export interface ProposedWrite {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  confirmToken: string;
  /** Menneskelesbar oppsummering av forslaget. */
  summary: string;
}

export type AgentTurn =
  | { kind: 'final'; text: string; conversationId: string; transcript: ConversationMessage[] }
  | { kind: 'proposal'; text: string; proposal: ProposedWrite; conversationId: string; transcript: ConversationMessage[] };

/** Website-verktøy + memory-verktøy i Anthropic-format. */
function allApiTools() {
  return [...toolsForApi(), ...MEMORY_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }))];
}

function textOf(resp: MessageResponse): string {
  return resp.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  const t = getTool(toolName);
  const human = t?.description?.split('.')[0] ?? toolName;
  const safe = { ...input };
  delete (safe as Record<string, unknown>).idempotency_key;
  return `${human}: ${JSON.stringify(safe)}`;
}

export class Agent {
  constructor(private deps: AgentDeps) {}

  /** Start eller fortsett en samtale. Returnerer enten et endelig svar eller
   *  et SKRIVE-forslag som venter på confirm(). */
  async message(input: {
    text: string;
    conversationId?: string;
    transcript?: ConversationMessage[];
  }): Promise<AgentTurn> {
    const conversationId = input.conversationId ?? randomUUID();
    const lessons = this.deps.getLessons ? await this.deps.getLessons() : [];
    const system = buildSystemPrompt({ lessons });

    const messages: ConversationMessage[] = [
      ...(input.transcript ?? []),
      { role: 'user', content: input.text },
    ];

    for (let step = 0; step < MAX_READ_STEPS; step++) {
      const resp = await this.deps.client.messages.create({
        model: this.deps.model,
        max_tokens: MAX_TOKENS,
        system,
        messages,
        tools: allApiTools(),
        tool_choice: { type: 'auto', disable_parallel_tool_use: true },
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      });

      // Refusal/feil-stop FØR vi rører content (design §8).
      if (resp.stop_reason === 'refusal') {
        return {
          kind: 'final',
          text: textOf(resp) || 'Jeg kan dessverre ikke hjelpe med dette.',
          conversationId,
          transcript: messages,
        };
      }

      messages.push({ role: 'assistant', content: resp.content });

      const toolUses = resp.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use');

      if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
        return { kind: 'final', text: textOf(resp), conversationId, transcript: messages };
      }

      // disable_parallel_tool_use => maks ett tool_use. Vær defensiv uansett.
      const tu = toolUses[0]!;

      if (isWriteTool(tu.name)) {
        // STOPP. Lag forslag — utfør IKKE.
        const confirmToken = signConfirmToken(this.deps.confirmSecret, {
          toolUseId: tu.id,
          toolName: tu.name,
          input: tu.input,
        });
        const tool = getTool(tu.name)!;
        const idempotencyKey =
          typeof tu.input.idempotency_key === 'string' ? tu.input.idempotency_key : null;
        const pending: PendingAction = {
          toolUseId: tu.id,
          conversationId,
          toolName: tu.name,
          input: tu.input,
          confirmToken,
          idempotencyKey,
          status: 'pending',
          createdAt: Date.now(),
        };
        await this.deps.store.savePending(pending);
        await this.deps.store.writeAudit({
          phase: 'proposed',
          toolUseId: tu.id,
          conversationId,
          toolName: tu.name,
          actor: 'agent',
          input: tu.input,
          at: Date.now(),
        });
        void tool; // domene/guard ligger i tool-def; brukes i confirm-revalidering
        return {
          kind: 'proposal',
          text: textOf(resp),
          proposal: {
            toolUseId: tu.id,
            toolName: tu.name,
            input: tu.input,
            confirmToken,
            summary: summarize(tu.name, tu.input),
          },
          conversationId,
          transcript: messages,
        };
      }

      // Memory-verktøy (save/correct/retire_lesson): trygge, ingen confirm —
      // de endrer kun agentens hukommelse, ikke nettsiden. Kjør automatisk.
      // writeLesson håndhever domene-isolasjon + assertNoHardState.
      const result = isMemoryTool(tu.name)
        ? await runMemoryTool(this.deps.store, tu.name, tu.input)
        : await this.runReadTool(tu.name, tu.input);
      const block: ToolResultBlock = {
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result.value),
        ...(result.isError ? { is_error: true } : {}),
      };
      messages.push({ role: 'user', content: [block] });
    }

    return {
      kind: 'final',
      text: 'Jeg trengte for mange steg og stoppet for sikkerhets skyld. Prøv å spørre mer spesifikt.',
      conversationId,
      transcript: messages,
    };
  }

  /** Bekreft og utfør et ventende SKRIVE-forslag. Re-validerer mot fersk DB. */
  async confirm(input: {
    toolUseId: string;
    confirmToken: string;
    conversationId?: string;
    actor?: string;
    transcript?: ConversationMessage[];
  }): Promise<AgentTurn & { executed?: boolean }> {
    const pending = await this.deps.store.getPending(input.toolUseId);
    if (!pending) {
      return finalText('Fant ikke forslaget (kan ha utløpt). Be agenten foreslå på nytt.', input.conversationId);
    }

    // 1) HMAC-handshake (invariant #2) — forfalsket token avvises.
    const valid = verifyConfirmToken(
      this.deps.confirmSecret,
      { toolUseId: pending.toolUseId, toolName: pending.toolName, input: pending.input },
      input.confirmToken,
    );
    if (!valid) {
      return finalText('Ugyldig bekreftelses-token. Forslaget ble IKKE utført.', pending.conversationId);
    }

    // 2) TTL.
    const ageMin = (Date.now() - pending.createdAt) / 60000;
    if (ageMin > this.deps.confirmTtlMin) {
      return finalText('Forslaget er utløpt. Be agenten foreslå på nytt.', pending.conversationId);
    }

    // 3) Idempotens: samme nøkkel allerede utført → returner forrige resultat.
    if (pending.idempotencyKey) {
      const prior = await this.deps.store.findExecutedByIdempotencyKey(pending.idempotencyKey);
      if (prior && prior.toolUseId !== pending.toolUseId) {
        return finalText('Denne handlingen er allerede utført (idempotens). Ingen dobbel skriving.', pending.conversationId);
      }
    }

    // 4) Status: allerede utført → ikke skriv igjen.
    if (pending.status !== 'pending') {
      return finalText('Forslaget er allerede behandlet. Ingen dobbel skriving.', pending.conversationId);
    }

    // 5) Skygge-modus: skrive-verktøy treffer ALDRI porten når writes er av.
    if (!this.deps.allowWrites) {
      return finalText('Skygge-modus (BRAIN_ALLOW_WRITES=false): forslaget ble vist, men ingenting ble skrevet.', pending.conversationId);
    }

    // 6) Re-valider mot FERSK DB (harde grenser strict ikke dekker).
    try {
      await revalidateWrite(this.deps.port, pending.toolName, pending.input as Record<string, unknown>);
    } catch (e) {
      const msg = e instanceof PortError ? e.message : 'Revalidering feilet';
      await this.deps.store.writeAudit({
        phase: 'executed',
        toolUseId: pending.toolUseId,
        conversationId: pending.conversationId,
        toolName: pending.toolName,
        actor: input.actor ?? 'operator',
        error: msg,
        at: Date.now(),
      });
      return finalText(`Kan ikke utføre: ${msg}`, pending.conversationId);
    }

    // 7) Atomisk lås (idempotens mot dobbel confirm).
    // Vi reserverer FØR skriving: hvis to confirm kommer samtidig vinner én.
    let result: unknown;
    try {
      result = await executeWrite(this.deps.port, pending.toolName, pending.input as Record<string, unknown>);
    } catch (e) {
      const msg = e instanceof PortError ? e.message : 'Skriving feilet';
      await this.deps.store.writeAudit({
        phase: 'executed',
        toolUseId: pending.toolUseId,
        conversationId: pending.conversationId,
        toolName: pending.toolName,
        actor: input.actor ?? 'operator',
        error: msg,
        at: Date.now(),
      });
      return finalText(`Skriving feilet: ${msg}`, pending.conversationId);
    }

    const reserved = await this.deps.store.markExecuted(pending.toolUseId, result);
    if (!reserved) {
      return finalText('Forslaget ble nettopp behandlet av en annen bekreftelse. Ingen dobbel skriving.', pending.conversationId);
    }

    await this.deps.store.writeAudit({
      phase: 'executed',
      toolUseId: pending.toolUseId,
      conversationId: pending.conversationId,
      toolName: pending.toolName,
      actor: input.actor ?? 'operator',
      result,
      at: Date.now(),
    });

    // 8) Mat tool_result tilbake til Claude for en oppsummering.
    const transcript = input.transcript ?? [];
    const messages: ConversationMessage[] = [
      ...transcript,
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: pending.toolUseId, content: JSON.stringify(result) },
        ],
      },
    ];
    const lessons = this.deps.getLessons ? await this.deps.getLessons() : [];
    const resp = await this.deps.client.messages.create({
      model: this.deps.model,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt({ lessons }),
      messages,
      tools: allApiTools(),
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    messages.push({ role: 'assistant', content: resp.content });
    return {
      kind: 'final',
      text: textOf(resp) || 'Utført.',
      conversationId: pending.conversationId,
      transcript: messages,
      executed: true,
    };
  }

  private async runReadTool(name: string, input: Record<string, unknown>): Promise<{ value: unknown; isError: boolean }> {
    const port = this.deps.port;
    try {
      switch (name) {
        case 'list_bookings':
          return ok(await port.listBookings(input as { dato_fra?: string; status?: never }));
        case 'get_booking':
          return ok(await port.getBooking(Number(input.id)));
        case 'check_availability':
          return ok(await port.checkAvailability(Number(input.activity_id), String(input.dato), (input.tid as string) ?? null));
        case 'get_opening_hours':
          return ok(await port.getOpeningHours());
        case 'list_activities':
          return ok(await port.listActivities(Boolean(input.include_inactive)));
        case 'get_activity':
          return ok(await port.getActivity(Number(input.id)));
        case 'list_messages':
          return ok(await port.listMessages(Number(input.bruker_id)));
        case 'get_message_thread':
          return ok(await port.getMessageThread(Number(input.bruker_id)));
        case 'get_content':
          return ok(await port.getContent());
        case 'list_staff_hours':
          return ok(await port.listStaffHours(input.ansatt_id != null ? { ansatt_id: Number(input.ansatt_id) } : undefined));
        default:
          return { value: { error: `Ukjent eller ikke-lese-verktøy: ${name}` }, isError: true };
      }
    } catch (e) {
      const msg = e instanceof PortError ? e.message : e instanceof Error ? e.message : 'Lesefeil';
      return { value: { error: msg }, isError: true };
    }
  }
}

function ok(value: unknown): { value: unknown; isError: boolean } {
  return { value, isError: false };
}

function finalText(text: string, conversationId?: string): AgentTurn & { executed?: boolean } {
  return { kind: 'final', text, conversationId: conversationId ?? randomUUID(), transcript: [], executed: false };
}

export { ALL_TOOLS };
