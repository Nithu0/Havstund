/**
 * Havstund Brain — PgStore: Postgres-implementasjon av BrainStore.
 *
 * Bruker brain-eide tabeller (brain_pending_actions/brain_audit/brain_lessons,
 * se migrations.sql). markExecuted er atomisk (UPDATE ... WHERE status='pending'
 * RETURNING) så samtidig dobbel-confirm bare lar én vinne. Lesson-insert
 * supersederer forrige aktive i samme transaksjon.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import type {
  AuditEntry,
  BrainStore,
  LessonDomain,
  LessonRow,
  LessonStatus,
  NewLesson,
  PendingAction,
  PendingStatus,
} from './store.js';

const { Pool } = pg;

function rowToPending(r: Record<string, unknown>): PendingAction {
  return {
    toolUseId: String(r.tool_use_id),
    conversationId: String(r.conversation_id),
    toolName: String(r.tool_name),
    input: r.input,
    confirmToken: String(r.confirm_token),
    idempotencyKey: (r.idempotency_key as string) ?? null,
    status: r.status as PendingStatus,
    createdAt: new Date(r.created_at as string).getTime(),
    ...(r.executed_at ? { executedAt: new Date(r.executed_at as string).getTime() } : {}),
    ...(r.result !== undefined && r.result !== null ? { resultJson: r.result } : {}),
  };
}

function rowToLesson(r: Record<string, unknown>): LessonRow {
  return {
    id: Number(r.id),
    domain: r.domain as LessonDomain,
    type: String(r.type),
    entity_ref: (r.entity_ref as string) ?? null,
    payload: r.payload,
    confidence: Number(r.confidence),
    source: String(r.source),
    version: Number(r.version),
    supersedes: r.supersedes != null ? Number(r.supersedes) : null,
    status: r.status as LessonStatus,
    created_at: new Date(r.created_at as string).getTime(),
  };
}

export class PgStore implements BrainStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
    });
  }

  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    // I dist/ ligger migrations.sql ved siden av; i src under utvikling også.
    const sql = readFileSync(join(here, 'migrations.sql'), 'utf8');
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async savePending(p: PendingAction): Promise<void> {
    await this.pool.query(
      `INSERT INTO brain_pending_actions
        (tool_use_id, conversation_id, tool_name, input, confirm_token, idempotency_key, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8/1000.0))
       ON CONFLICT (tool_use_id) DO NOTHING`,
      [p.toolUseId, p.conversationId, p.toolName, JSON.stringify(p.input), p.confirmToken, p.idempotencyKey, p.status, p.createdAt],
    );
  }

  async getPending(toolUseId: string): Promise<PendingAction | null> {
    const { rows } = await this.pool.query('SELECT * FROM brain_pending_actions WHERE tool_use_id = $1', [toolUseId]);
    return rows[0] ? rowToPending(rows[0]) : null;
  }

  async markExecuted(toolUseId: string, result: unknown): Promise<boolean> {
    // Atomisk: bare 'pending' → 'executed' lykkes. Samtidig confirm taper.
    const { rows } = await this.pool.query(
      `UPDATE brain_pending_actions
          SET status = 'executed', executed_at = now(), result = $2
        WHERE tool_use_id = $1 AND status = 'pending'
        RETURNING tool_use_id`,
      [toolUseId, JSON.stringify(result ?? null)],
    );
    return rows.length === 1;
  }

  async findExecutedByIdempotencyKey(key: string): Promise<PendingAction | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM brain_pending_actions WHERE idempotency_key = $1 AND status = 'executed' LIMIT 1`,
      [key],
    );
    return rows[0] ? rowToPending(rows[0]) : null;
  }

  async writeAudit(e: AuditEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO brain_audit (phase, tool_use_id, conversation_id, tool_name, actor, input, result, error, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9/1000.0))`,
      [
        e.phase,
        e.toolUseId,
        e.conversationId,
        e.toolName,
        e.actor,
        e.input !== undefined ? JSON.stringify(e.input) : null,
        e.result !== undefined ? JSON.stringify(e.result) : null,
        e.error ?? null,
        e.at,
      ],
    );
  }

  async listAudit(conversationId?: string): Promise<AuditEntry[]> {
    const { rows } = conversationId
      ? await this.pool.query('SELECT * FROM brain_audit WHERE conversation_id = $1 ORDER BY at', [conversationId])
      : await this.pool.query('SELECT * FROM brain_audit ORDER BY at');
    return rows.map((r) => ({
      phase: r.phase,
      toolUseId: r.tool_use_id,
      conversationId: r.conversation_id,
      toolName: r.tool_name,
      actor: r.actor,
      input: r.input ?? undefined,
      result: r.result ?? undefined,
      error: r.error ?? undefined,
      at: new Date(r.at).getTime(),
    }));
  }

  async insertLesson(l: NewLesson): Promise<LessonRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prev = await client.query(
        `SELECT id, version FROM brain_lessons
          WHERE domain=$1 AND type=$2 AND entity_ref IS NOT DISTINCT FROM $3 AND status='active'
          ORDER BY version DESC`,
        [l.domain, l.type, l.entity_ref ?? null],
      );
      const version = prev.rows[0] ? Number(prev.rows[0].version) + 1 : 1;
      const supersedes = l.supersedes ?? (prev.rows[0] ? Number(prev.rows[0].id) : null);
      if (prev.rows.length) {
        await client.query(`UPDATE brain_lessons SET status='superseded' WHERE id = ANY($1)`, [prev.rows.map((r) => r.id)]);
      }
      const ins = await client.query(
        `INSERT INTO brain_lessons (domain, type, entity_ref, payload, confidence, source, version, supersedes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active') RETURNING *`,
        [l.domain, l.type, l.entity_ref ?? null, JSON.stringify(l.payload), l.confidence ?? 0.7, l.source, version, supersedes],
      );
      await client.query('COMMIT');
      return rowToLesson(ins.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async getLessons(filter: { domain: LessonDomain; entityRef?: string | null; status?: LessonStatus }): Promise<LessonRow[]> {
    const status = filter.status ?? 'active';
    if (filter.entityRef === undefined) {
      const { rows } = await this.pool.query(
        'SELECT * FROM brain_lessons WHERE domain=$1 AND status=$2 ORDER BY id',
        [filter.domain, status],
      );
      return rows.map(rowToLesson);
    }
    const { rows } = await this.pool.query(
      'SELECT * FROM brain_lessons WHERE domain=$1 AND status=$2 AND entity_ref IS NOT DISTINCT FROM $3 ORDER BY id',
      [filter.domain, status, filter.entityRef ?? null],
    );
    return rows.map(rowToLesson);
  }

  async setLessonStatus(id: number, status: LessonStatus): Promise<LessonRow | null> {
    const { rows } = await this.pool.query('UPDATE brain_lessons SET status=$2 WHERE id=$1 RETURNING *', [id, status]);
    return rows[0] ? rowToLesson(rows[0]) : null;
  }
}
