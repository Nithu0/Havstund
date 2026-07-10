/**
 * Havstund Brain — HTTP-server (Node http, ingen Express-dep).
 *
 * Ruter:
 *   GET  /agent/health   → { ok, db } (nettsidens helse via porten). Ingen auth.
 *   POST /agent/ask      → { text, conversationId, transcript } | { text?, proposal }
 *   POST /agent/confirm  → { text, executed }
 *
 * /ask og /confirm krever gyldig operatør-token (Authorization: Bearer) +
 * består rate-limit. Bygger Agent med ekte deps (HttpWebsiteAdapter + PgStore +
 * ekte Anthropic-klient med modell/thinking/output_config fra design §10).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Config } from '../config.js';
import { logger } from '../lib/logger.js';
import { Agent, type AgentTurn } from '../brain/agent.js';
import type { ImageBlock, ConversationMessage } from '../brain/anthropic-client.js';
import { HttpWebsiteAdapter } from '../adapters/http-website-adapter.js';
import { PgStore } from '../brain/pg-store.js';
import { createRealClient } from '../brain/anthropic-client.js';
import { getRelevantLessons } from '../brain/memory/write-lesson.js';
import { extractBearer, verifyOperatorToken } from './auth.js';
import { RateLimiter } from './rate-limit.js';

// Body-tak. Et kvitteringsbilde sendes som base64 (≈ 4/3 av rå-bytene), så et
// 5 MB-bilde blir ~6,7 MB JSON. Vi tåler opptil ~8 MB her slik at brain-siden
// ikke blir den bindende grensen. MERK: nettsidens shim-rute /api/brain/* går i
// dag gjennom express.json({limit:'256kb'}) (server.js:53) — den er den REELLE
// øvre grensen for bilder inn hit, og eies av en annen agent. Se rapport.
const MAX_BODY_BYTES = 8_000_000;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body for stor');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

// ---- Bilde-validering (kvittering-syn) ---------------------------------------
// Kun base64-bilder av kjente typer; defensivt tak på antall + total størrelse
// slik at en ondsinnet eller feilformet forespørsel ikke sprenger modellen.
const ALLOWED_IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // rå-bytes per bilde (base64 dekodet)
const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024; // sum over alle bilder

class ImageValidationError extends Error {}

/** base64-lengde → omtrentlig antall rå-bytes. */
function approxBase64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Leser og validerer `images` fra request-body. Returnerer et rent ImageBlock[]
 * (ingen ekstra felt slipper videre) eller undefined når ingen bilder er sendt.
 * Kaster ImageValidationError ved feil form — kalleren mapper det til 400.
 */
export function parseImages(raw: unknown): ImageBlock[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new ImageValidationError('images må være en liste');
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_IMAGES) throw new ImageValidationError(`For mange bilder (maks ${MAX_IMAGES})`);
  const out: ImageBlock[] = [];
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new ImageValidationError('Ugyldig bilde-blokk');
    const b = item as Record<string, unknown>;
    if (b.type !== 'image') throw new ImageValidationError('Bilde-blokk må ha type "image"');
    const src = b.source as Record<string, unknown> | undefined;
    if (!src || typeof src !== 'object') throw new ImageValidationError('Bilde mangler source');
    if (src.type !== 'base64') throw new ImageValidationError('Kun base64-bilder støttes');
    const mediaType = src.media_type;
    if (typeof mediaType !== 'string' || !ALLOWED_IMAGE_MEDIA.has(mediaType)) {
      throw new ImageValidationError('Ugyldig media_type (kun png/jpeg/webp)');
    }
    const data = src.data;
    if (typeof data !== 'string' || data.length === 0) throw new ImageValidationError('Bilde mangler data');
    const bytes = approxBase64Bytes(data);
    if (bytes > MAX_IMAGE_BYTES) throw new ImageValidationError('Bilde er for stort (maks 5 MB)');
    total += bytes;
    if (total > MAX_TOTAL_IMAGE_BYTES) throw new ImageValidationError('Bildene er for store til sammen');
    // Bygg en ren blokk — ingen fremmede felt videresendes til modellen.
    out.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }
  return out;
}

/** Struktur-typen /agent/ask trenger fra agenten (Agent oppfyller den). */
interface AskLike {
  message(input: {
    text: string;
    images?: ImageBlock[];
    conversationId?: string;
    transcript?: ConversationMessage[];
  }): Promise<AgentTurn>;
}

/**
 * Kjernelogikken bak POST /agent/ask: valider text + images, kall agenten.
 * Skilt ut fra HTTP-laget så den kan enhetstestes med en stub-agent.
 */
export async function handleAsk(
  agent: AskLike,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const text = String(body.text ?? '').trim();
  if (!text) return { status: 400, body: { error: 'Mangler text' } };
  let images: ImageBlock[] | undefined;
  try {
    images = parseImages(body.images);
  } catch (e) {
    return { status: 400, body: { error: e instanceof Error ? e.message : 'Ugyldige bilder' } };
  }
  const turn = await agent.message({
    text,
    ...(images ? { images } : {}),
    ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
    ...(Array.isArray(body.transcript) ? { transcript: body.transcript as never } : {}),
  });
  return { status: 200, body: turn };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

export async function buildAgent(
  config: Config,
  injectedStore?: PgStore,
): Promise<{ agent: Agent; store: PgStore; port: HttpWebsiteAdapter }> {
  const port = new HttpWebsiteAdapter({ baseUrl: config.WEBSITE_BASE_URL, serviceToken: config.WEBSITE_SERVICE_TOKEN });
  // Gjenbruk en allerede-migrert store hvis den er sendt inn (index.ts kjører
  // migrasjonen FØR startServer på samme pool). Uten injeksjon: bygg en og
  // migrer her, så buildAgent fortsatt er selvstendig (tester/contract-live).
  let store: PgStore;
  if (injectedStore) {
    store = injectedStore;
  } else {
    store = new PgStore(config.DATABASE_URL);
    await store.migrate();
  }
  const client = await createRealClient(config.ANTHROPIC_API_KEY);
  const agent = new Agent({
    client,
    port,
    store,
    model: config.ANTHROPIC_MODEL,
    confirmSecret: config.WEBSITE_SERVICE_TOKEN, // HMAC-secret, server-side only
    confirmTtlMin: config.CONFIRM_TTL_MIN,
    allowWrites: config.BRAIN_ALLOW_WRITES,
    // Default-lessons: tverrgående global-domene. Domene-spesifikke hentes i
    // agent-loopen via egne kall ved behov; her injiseres de generelle.
    getLessons: () => getRelevantLessons(store, 'global', null),
  });
  return { agent, store, port };
}

export async function startServer(
  config: Config,
  injectedStore?: PgStore,
): Promise<{ close: () => Promise<void> }> {
  const { agent, store, port } = await buildAgent(config, injectedStore);
  const limiter = new RateLimiter(30, 60_000); // 30 kall / minutt / aktør

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error({ err }, 'uhåndtert serverfeil');
      if (!res.headersSent) send(res, 500, { error: 'Intern feil' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';

    if (method === 'GET' && url === '/agent/health') {
      try {
        const health = await port.health();
        return send(res, health.ok ? 200 : 503, health);
      } catch {
        return send(res, 503, { ok: false, db: 'down' });
      }
    }

    if (method === 'POST' && (url === '/agent/ask' || url === '/agent/confirm')) {
      // Auth: operatør-token (shimen har allerede admin/utvalgt-gatet).
      const token = extractBearer(req.headers.authorization);
      if (!verifyOperatorToken(config.BRAIN_OPERATOR_TOKEN, token)) {
        return send(res, 401, { error: 'Ugyldig operatør-token' });
      }
      const actor = (req.headers['x-operator'] as string) || 'operator';
      if (!limiter.allow(actor)) {
        return send(res, 429, { error: 'For mange forespørsler, prøv igjen om litt' });
      }

      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: 'Ugyldig JSON' });
      }

      if (url === '/agent/ask') {
        const { status, body: out } = await handleAsk(agent, body);
        return send(res, status, out);
      }

      // /agent/confirm
      const toolUseId = String(body.toolUseId ?? '');
      const confirmToken = String(body.confirmToken ?? '');
      if (!toolUseId || !confirmToken) return send(res, 400, { error: 'Mangler toolUseId/confirmToken' });
      const result = await agent.confirm({
        toolUseId,
        confirmToken,
        actor,
        ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
        ...(Array.isArray(body.transcript) ? { transcript: body.transcript as never } : {}),
      });
      return send(res, 200, result);
    }

    send(res, 404, { error: 'Ukjent rute' });
  }

  await new Promise<void>((resolve) => server.listen(config.PORT, () => resolve()));
  logger.info({ port: config.PORT }, 'havstund-brain HTTP lytter');

  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.close();
    },
  };
}
