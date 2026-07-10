/**
 * Kvittering-syn — HTTP-laget: POST /agent/ask leser `images` fra body, VALIDERER
 * formen, og videresender bilde-blokkene til agent.message(). Ugyldig form → 400
 * uten at agenten kalles. Testene bruker en stub-agent (ingen ekte Claude, ingen
 * skriving) og treffer den utskilte handleAsk/parseImages direkte.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleAsk, parseImages } from '../src/server/http.js';
import type { ImageBlock, ConversationMessage } from '../src/brain/anthropic-client.js';

type AskInput = {
  text: string;
  images?: ImageBlock[];
  conversationId?: string;
  transcript?: ConversationMessage[];
};

// 1x1 transparent PNG (base64) — nok til å bevise transport.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const gyldigBilde: ImageBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: PNG_1PX },
};

function stubAgent() {
  const message = vi.fn((_input: AskInput) =>
    Promise.resolve({ kind: 'final' as const, text: 'ok', conversationId: 'c1', transcript: [] }),
  );
  return { agent: { message }, message };
}

describe('handleAsk — bilder trådes til agent.message', () => {
  it('gyldig bilde videresendes uendret, status 200', async () => {
    const { agent, message } = stubAgent();
    const res = await handleAsk(agent, {
      text: 'Les denne kvitteringen.',
      images: [gyldigBilde],
    });
    expect(res.status).toBe(200);
    expect(message).toHaveBeenCalledTimes(1);
    const arg = message.mock.calls[0]![0];
    expect(arg.text).toBe('Les denne kvitteringen.');
    expect(arg.images).toHaveLength(1);
    expect(arg.images![0]!.source.media_type).toBe('image/png');
    expect(arg.images![0]!.source.data).toBe(PNG_1PX);
  });

  it('flere gyldige bilder bevares', async () => {
    const { agent, message } = stubAgent();
    const res = await handleAsk(agent, { text: 'to', images: [gyldigBilde, gyldigBilde] });
    expect(res.status).toBe(200);
    const arg = message.mock.calls[0]![0];
    expect(arg.images).toHaveLength(2);
  });

  it('uten bilder kalles agenten uten images-nøkkel', async () => {
    const { agent, message } = stubAgent();
    const res = await handleAsk(agent, { text: 'bare tekst' });
    expect(res.status).toBe(200);
    const arg = message.mock.calls[0]![0];
    expect(arg.images).toBeUndefined();
  });

  it('conversationId + transcript videresendes når til stede', async () => {
    const { agent, message } = stubAgent();
    await handleAsk(agent, { text: 't', conversationId: 'abc', transcript: [{ role: 'user', content: 'x' }] });
    const arg = message.mock.calls[0]![0];
    expect(arg.conversationId).toBe('abc');
    expect(arg.transcript).toHaveLength(1);
  });

  it('mangler text → 400, agenten kalles ikke', async () => {
    const { agent, message } = stubAgent();
    const res = await handleAsk(agent, { images: [gyldigBilde] });
    expect(res.status).toBe(400);
    expect(message).not.toHaveBeenCalled();
  });

  it('ugyldig image-form (type != image) → 400, agenten kalles ikke', async () => {
    const { agent, message } = stubAgent();
    const res = await handleAsk(agent, {
      text: 't',
      images: [{ type: 'text', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } }],
    });
    expect(res.status).toBe(400);
    expect(message).not.toHaveBeenCalled();
  });

  it('images som ikke er liste → 400', async () => {
    const { agent } = stubAgent();
    const res = await handleAsk(agent, { text: 't', images: { type: 'image' } });
    expect(res.status).toBe(400);
  });
});

describe('parseImages — validering', () => {
  it('undefined/null/tom liste → undefined', () => {
    expect(parseImages(undefined)).toBeUndefined();
    expect(parseImages(null)).toBeUndefined();
    expect(parseImages([])).toBeUndefined();
  });

  it('gyldig blokk returneres renset (ingen fremmede felt)', () => {
    const skitten = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: PNG_1PX },
      ekstra: 'skal bort',
    };
    const ut = parseImages([skitten])!;
    expect(ut).toHaveLength(1);
    expect(Object.keys(ut[0]!)).toEqual(['type', 'source']);
    expect(ut[0]!.source.media_type).toBe('image/jpeg');
  });

  it('for mange bilder (>3) → kaster', () => {
    expect(() => parseImages([gyldigBilde, gyldigBilde, gyldigBilde, gyldigBilde])).toThrow();
  });

  it('ukjent media_type → kaster', () => {
    expect(() =>
      parseImages([{ type: 'image', source: { type: 'base64', media_type: 'image/gif', data: PNG_1PX } }]),
    ).toThrow();
  });

  it('ikke-base64 source.type → kaster', () => {
    expect(() =>
      parseImages([{ type: 'image', source: { type: 'url', media_type: 'image/png', data: 'http://x' } }]),
    ).toThrow();
  });

  it('tom/uteblitt data → kaster', () => {
    expect(() =>
      parseImages([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } }]),
    ).toThrow();
  });

  it('for stort bilde (>5 MB rå) → kaster', () => {
    // ~6 MB rå ⇒ base64-lengde ≈ 8 MB.
    const stor = 'A'.repeat(8 * 1024 * 1024);
    expect(() =>
      parseImages([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: stor } }]),
    ).toThrow();
  });
});
