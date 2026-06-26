/**
 * Scriptet Anthropic-stub for tester (design §9: LLM-uavhengig CI).
 *
 * messages.create() returnerer den neste responsen fra en forhåndsdefinert kø.
 * Ingen ekte Claude → raskt, deterministisk, gratis. Hver respons er enten en
 * tekst-tur, et tool_use, eller en refusal — nøyaktig den formen agent-loopen
 * forventer.
 */
import type {
  AnthropicLike,
  MessageCreateParams,
  MessageResponse,
  ContentBlock,
} from '../src/brain/anthropic-client.js';

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter}`;
}

export function textTurn(text: string): MessageResponse {
  return { id: nextId('msg'), role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] };
}

export function refusalTurn(text = 'Beklager, dette kan jeg ikke hjelpe med.'): MessageResponse {
  return { id: nextId('msg'), role: 'assistant', stop_reason: 'refusal', content: [{ type: 'text', text }] };
}

export function toolTurn(
  name: string,
  input: Record<string, unknown>,
  opts: { id?: string; text?: string } = {},
): MessageResponse {
  const content: ContentBlock[] = [];
  if (opts.text) content.push({ type: 'text', text: opts.text });
  content.push({ type: 'tool_use', id: opts.id ?? nextId('toolu'), name, input });
  return { id: nextId('msg'), role: 'assistant', stop_reason: 'tool_use', content };
}

export class StubAnthropic implements AnthropicLike {
  private queue: MessageResponse[];
  /** Alle params agenten sendte — for assertions (f.eks. tool_choice ikke tvunget). */
  public calls: MessageCreateParams[] = [];

  constructor(queue: MessageResponse[]) {
    this.queue = [...queue];
  }

  messages = {
    create: async (params: MessageCreateParams): Promise<MessageResponse> => {
      this.calls.push(params);
      const next = this.queue.shift();
      if (!next) throw new Error('StubAnthropic: køen er tom (uventet ekstra messages.create-kall)');
      return next;
    },
  };
}
