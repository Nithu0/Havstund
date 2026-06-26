/**
 * Havstund Brain — minimalt klient-grensesnitt mot Anthropic Messages API.
 *
 * Agenten avhenger KUN av denne formen, ikke av hele @anthropic-ai/sdk-typene.
 * Det gir to gevinster:
 *  - tester kan injisere en scriptet stub (test/anthropic-stub.ts) uten ekte Claude
 *  - SDK-versjonsbump river ikke agent-loopen så lenge messages.create-formen står
 *
 * Den ekte klienten (createRealClient) wrapper @anthropic-ai/sdk og setter
 * modell/thinking/output_config fra design (§10).
 */

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}
export type ContentBlock = TextBlock | ToolUseBlock;

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type UserContent = string | Array<TextBlock | ToolResultBlock>;

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: UserContent | ContentBlock[];
}

export interface MessageCreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: ConversationMessage[];
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  tool_choice?: { type: 'auto'; disable_parallel_tool_use?: boolean };
  thinking?: { type: string };
  // output_config sendes som ekstra felt; SDK videresender ukjente felter.
  [extra: string]: unknown;
}

export interface MessageResponse {
  id: string;
  role: 'assistant';
  /** 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' */
  stop_reason: string;
  content: ContentBlock[];
}

export interface AnthropicLike {
  messages: {
    create(params: MessageCreateParams): Promise<MessageResponse>;
  };
}

/** Bygger den ekte SDK-klienten. Importeres dynamisk så test/CI ikke trenger
 *  @anthropic-ai/sdk lastet eller en ekte nøkkel. */
export async function createRealClient(apiKey: string): Promise<AnthropicLike> {
  const mod = await import('@anthropic-ai/sdk');
  const Anthropic = (mod as { default?: unknown }).default ?? (mod as { Anthropic?: unknown }).Anthropic;
  const client = new (Anthropic as new (o: { apiKey: string }) => unknown)({ apiKey }) as {
    messages: { create: (p: unknown) => Promise<unknown> };
  };
  return {
    messages: {
      create: (params: MessageCreateParams) =>
        client.messages.create(params as unknown) as Promise<MessageResponse>,
    },
  };
}
