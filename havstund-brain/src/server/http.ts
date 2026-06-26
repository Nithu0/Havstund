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
import { Agent } from '../brain/agent.js';
import { HttpWebsiteAdapter } from '../adapters/http-website-adapter.js';
import { PgStore } from '../brain/pg-store.js';
import { createRealClient } from '../brain/anthropic-client.js';
import { getRelevantLessons } from '../brain/memory/write-lesson.js';
import { extractBearer, verifyOperatorToken } from './auth.js';
import { RateLimiter } from './rate-limit.js';

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error('body for stor');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
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
        const text = String(body.text ?? '').trim();
        if (!text) return send(res, 400, { error: 'Mangler text' });
        const turn = await agent.message({
          text,
          ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
          ...(Array.isArray(body.transcript) ? { transcript: body.transcript as never } : {}),
        });
        return send(res, 200, turn);
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
