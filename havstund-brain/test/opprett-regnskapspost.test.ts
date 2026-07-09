/**
 * Fase 6 — opprett_regnskapspost (skrive-verktøy for regnskapsposter fra kvittering).
 *
 * Beviser:
 *  1) verktøyet er registrert i ALL_TOOLS og er et skrive-verktøy (isWriteTool),
 *     med strict-schema + guard + finance-domene.
 *  2) MockWebsiteAdapter driver verktøyet uten ekte HTTP: executeWrite lagrer en
 *     post med korrekt netto/mva/brutto (systemet regner mva fra bekreftet brutto).
 *  3) HttpWebsiteAdapter sender et POST-kall til /api/regnskap/poster med RIKTIG
 *     body — inkl. netto_ore baklengs-regnet fra brutto (ruta tar netto, ikke brutto).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { ALL_TOOLS, getTool, isWriteTool } from '../src/brain/tools.js';
import { executeWrite, revalidateWrite } from '../src/brain/write-exec.js';
import { MockWebsiteAdapter } from '../src/adapters/mock-website-adapter.js';
import { HttpWebsiteAdapter } from '../src/adapters/http-website-adapter.js';

describe('opprett_regnskapspost — registrering', () => {
  it('er registrert i ALL_TOOLS og er et skrive-verktøy', () => {
    expect(ALL_TOOLS.some((t) => t.name === 'opprett_regnskapspost')).toBe(true);
    expect(isWriteTool('opprett_regnskapspost')).toBe(true);
  });

  it('har finance-domene, guard og strict-schema', () => {
    const t = getTool('opprett_regnskapspost')!;
    expect(t.domain).toBe('finance');
    expect(t.guard).toBe('idempotency_key');
    const schema = t.input_schema as { strict?: boolean; additionalProperties?: boolean; required?: string[] };
    expect(schema.strict).toBe(true);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining(['dato', 'beskrivelse', 'konto', 'mva_sats', 'brutto_ore', 'idempotency_key']),
    );
  });
});

describe('opprett_regnskapspost — MockWebsiteAdapter (uten HTTP)', () => {
  it('lagrer post med netto/mva/brutto regnet fra bekreftet brutto', async () => {
    const port = new MockWebsiteAdapter();
    const input = {
      type: 'utgift',
      dato: '2026-07-01',
      beskrivelse: 'Kaffe til kontoret',
      konto: 4000,
      mva_sats: 25,
      brutto_ore: 12500, // 125,00 kr inkl. 25% mva
      betalingsmetode: 'kort',
      idempotency_key: 'orp-1',
    };
    await revalidateWrite(port, 'opprett_regnskapspost', input);
    const res = (await executeWrite(port, 'opprett_regnskapspost', input)) as {
      netto_ore: number; mva_ore: number; brutto_ore: number; type: string; konto: number | null; kilde: string;
    };
    // 125,00 inkl. 25% => netto 100,00 + mva 25,00
    expect(res.netto_ore).toBe(10000);
    expect(res.mva_ore).toBe(2500);
    expect(res.brutto_ore).toBe(12500);
    expect(res.type).toBe('utgift');
    expect(res.konto).toBe(4000);
    expect(res.kilde).toBe('agent');
    expect(port.regnskapsposter).toHaveLength(1);
  });

  it('avviser ugyldig mva_sats i revalidering', async () => {
    const port = new MockWebsiteAdapter();
    await expect(
      revalidateWrite(port, 'opprett_regnskapspost', {
        type: 'utgift', dato: '2026-07-01', beskrivelse: 'x', konto: 4000, mva_sats: 20, brutto_ore: 1000, idempotency_key: 'orp-2',
      }),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('opprett_regnskapspost — HttpWebsiteAdapter POSTer riktig body', () => {
  interface Recorded { method: string; url: string; body?: unknown }
  let server: Server;
  let baseUrl: string;
  let recorded: Recorded[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        let body: unknown = null;
        const t = Buffer.concat(chunks).toString('utf8');
        if (t) { try { body = JSON.parse(t); } catch { body = t; } }
        recorded.push({ method: req.method ?? 'GET', url: req.url ?? '', body });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          post: {
            id: 42, type: 'utgift', dato: '2026-07-01', kontakt: null, beskrivelse: 'Kaffe',
            konto: 4000, mva_kode: null, mva_sats: 25, netto_ore: 10000, mva_ore: 2500,
            brutto_ore: 12500, betalingsmetode: 'kort', bilag: null, kilde: 'agent', fiken_status: 'ikke_sendt',
          },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address();
    const portNo = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${portNo}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('sender POST /api/regnskap/poster med netto_ore baklengs-regnet fra brutto', async () => {
    recorded = [];
    const a = new HttpWebsiteAdapter({ baseUrl, serviceToken: 'svc-token-0123456789' });
    const post = await a.opprettRegnskapspost({
      type: 'utgift',
      dato: '2026-07-01',
      beskrivelse: 'Kaffe',
      konto: 4000,
      mva_sats: 25,
      brutto_ore: 12500,
      betalingsmetode: 'kort',
    });
    expect(post.id).toBe(42);
    const call = recorded.find((r) => r.method === 'POST' && r.url === '/api/regnskap/poster');
    expect(call).toBeTruthy();
    expect(call!.body).toMatchObject({
      type: 'utgift',
      dato: '2026-07-01',
      beskrivelse: 'Kaffe',
      konto: 4000,
      mva_sats: 25,
      netto_ore: 10000, // 12500 brutto / 1.25 => 10000 netto
      betalingsmetode: 'kort',
      kilde: 'agent',
    });
  });
});
