/**
 * Fase 6 — syn: en bruker-melding kan inneholde et bilde (kvittering), og
 * bilde-blokken serialiseres UENDRET inn i request-en mot Anthropic-API-et.
 *
 * Vi bruker StubAnthropic (LLM-uavhengig CI): den lagrer alle params agenten
 * sendte, så vi kan asserte at image-blokken faktisk havner i messages[].
 * Ingen ekte Claude, ingen skriving — kun at bildet når fram til modellen.
 */
import { describe, it, expect } from 'vitest';
import { Agent } from '../src/brain/agent.js';
import { InMemoryStore } from '../src/brain/store.js';
import { MockWebsiteAdapter } from '../src/adapters/mock-website-adapter.js';
import { StubAnthropic, textTurn } from './anthropic-stub.js';
import { baseSeed } from './port-contract.test.js';
import type { ImageBlock } from '../src/brain/anthropic-client.js';

const SECRET = 'vision-test-secret-0123456789';
const MODEL = 'claude-opus-4-8';

// 1x1 transparent PNG (base64) — nok til å bevise transport, ikke ekte kvittering.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function makeAgent(queue: ReturnType<typeof textTurn>[]) {
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
  });
  return { agent, client };
}

const kvittering: ImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: PNG_1PX },
};

describe('Fase 6 — bilde i bruker-melding serialiseres inn i request', () => {
  it('image-blokken havner i messages[] med media_type + data uendret', async () => {
    const { agent, client } = makeAgent([textTurn('Jeg ser en kvittering på 200 kr for leire.')]);

    await agent.message({
      text: 'Kjøpte leire, her er kvitteringen. Legg i regnskap.',
      images: [kvittering],
    });

    // Første (og eneste) kall til modellen skal bære bildet. Agent-loopen muterer
    // messages[]-arrayen etter kallet (pusher assistant/tool-meldinger), så vi
    // lokaliserer bruker-meldingen eksplisitt i stedet for å ta siste element.
    const call = client.calls[0]!;
    const bruker = call.messages.find((m) => m.role === 'user')!;
    expect(bruker.role).toBe('user');
    expect(Array.isArray(bruker.content)).toBe(true);

    const content = bruker.content as unknown as Array<Record<string, unknown>>;
    const img = content.find((b) => b.type === 'image') as ImageBlock | undefined;
    expect(img, 'image-blokk mangler i request').toBeTruthy();
    expect(img!.source.type).toBe('base64');
    expect(img!.source.media_type).toBe('image/png');
    expect(img!.source.data).toBe(PNG_1PX);

    // Teksten skal fortsatt være med, etter bildet (rekkefølge: bilde → tekst).
    const tekst = content.find((b) => b.type === 'text') as { type: string; text: string } | undefined;
    expect(tekst?.text).toContain('kvitteringen');
    const imgIdx = content.findIndex((b) => b.type === 'image');
    const txtIdx = content.findIndex((b) => b.type === 'text');
    expect(imgIdx).toBeLessThan(txtIdx);
  });

  it('flere bilder bevares alle', async () => {
    const { agent, client } = makeAgent([textTurn('ok')]);
    await agent.message({ text: 'to kvitteringer', images: [kvittering, kvittering] });
    const call = client.calls[0]!;
    const bruker = call.messages.find((m) => m.role === 'user')!;
    const content = bruker.content as unknown as Array<Record<string, unknown>>;
    expect(content.filter((b) => b.type === 'image')).toHaveLength(2);
  });

  it('tekst-only (ingen bilder) er uendret: content er en ren streng', async () => {
    const { agent, client } = makeAgent([textTurn('hei')]);
    await agent.message({ text: 'bare tekst' });
    const call = client.calls[0]!;
    const bruker = call.messages.find((m) => m.role === 'user')!;
    expect(bruker.content).toBe('bare tekst'); // ingen array-innpakking uten bilder
  });
});
