/**
 * Havstund Brain — persistens-kontrakt for pending_actions + audit + lessons.
 *
 * Pending actions og audit lagres i Postgres (design §6/§8), IKKE i minne, slik
 * at de overlever omstart og confirm 2× ikke gir 2 bookinger (idempotens på
 * unik DB-constraint). To implementasjoner:
 *   - InMemoryStore  (test — deterministisk, ingen DB)
 *   - PgStore        (prod — pg, egne brain-tabeller)
 *
 * Lessons-delen brukes fra Steg C (memory-laget). Den ligger her fordi den
 * deler samme persistens-livssyklus.
 */

export type PendingStatus = 'pending' | 'executed' | 'expired' | 'cancelled';

export interface PendingAction {
  toolUseId: string;
  conversationId: string;
  toolName: string;
  input: unknown;
  confirmToken: string;
  idempotencyKey: string | null;
  status: PendingStatus;
  createdAt: number; // epoch ms
  executedAt?: number;
  resultJson?: unknown;
}

export interface AuditEntry {
  phase: 'proposed' | 'executed';
  toolUseId: string;
  conversationId: string;
  toolName: string;
  actor: string; // operatør-identitet
  input?: unknown;
  result?: unknown;
  error?: string;
  at: number;
}

// ---- Lessons (Steg C) ----
export type LessonDomain = 'booking' | 'timesheet' | 'calendar' | 'customer' | 'global';
export type LessonStatus = 'active' | 'retired' | 'superseded';

export interface LessonRow {
  id: number;
  domain: LessonDomain;
  type: string;
  entity_ref: string | null;
  payload: unknown;
  confidence: number;
  source: string;
  version: number;
  supersedes: number | null;
  status: LessonStatus;
  created_at: number;
}

export interface NewLesson {
  domain: LessonDomain;
  type: string;
  entity_ref?: string | null;
  payload: unknown;
  confidence?: number;
  source: string;
  supersedes?: number | null;
}

export interface BrainStore {
  // pending
  savePending(p: PendingAction): Promise<void>;
  getPending(toolUseId: string): Promise<PendingAction | null>;
  /** Atomisk: marker pending som executed hvis fortsatt 'pending'. Returnerer
   *  false hvis allerede executed/expired (idempotens-vakt mot dobbel confirm). */
  markExecuted(toolUseId: string, result: unknown): Promise<boolean>;
  /** Slå opp en tidligere utført handling på idempotency_key (samme nøkkel
   *  → returner det forrige resultatet i stedet for å skrive på nytt). */
  findExecutedByIdempotencyKey(key: string): Promise<PendingAction | null>;

  // audit
  writeAudit(e: AuditEntry): Promise<void>;
  listAudit(conversationId?: string): Promise<AuditEntry[]>;

  // lessons (Steg C)
  insertLesson(l: NewLesson): Promise<LessonRow>;
  getLessons(filter: { domain: LessonDomain; entityRef?: string | null; status?: LessonStatus }): Promise<LessonRow[]>;
  setLessonStatus(id: number, status: LessonStatus): Promise<LessonRow | null>;
}

// ----------------------------------------------------------------------------
// In-memory implementasjon (test)
// ----------------------------------------------------------------------------
export class InMemoryStore implements BrainStore {
  private pending = new Map<string, PendingAction>();
  private audit: AuditEntry[] = [];
  private lessons: LessonRow[] = [];
  private lessonSeq = 0;

  async savePending(p: PendingAction): Promise<void> {
    this.pending.set(p.toolUseId, { ...p });
  }

  async getPending(toolUseId: string): Promise<PendingAction | null> {
    const p = this.pending.get(toolUseId);
    return p ? { ...p } : null;
  }

  async markExecuted(toolUseId: string, result: unknown): Promise<boolean> {
    const p = this.pending.get(toolUseId);
    if (!p || p.status !== 'pending') return false;
    p.status = 'executed';
    p.executedAt = Date.now();
    p.resultJson = result;
    return true;
  }

  async findExecutedByIdempotencyKey(key: string): Promise<PendingAction | null> {
    for (const p of this.pending.values()) {
      if (p.idempotencyKey === key && p.status === 'executed') return { ...p };
    }
    return null;
  }

  async writeAudit(e: AuditEntry): Promise<void> {
    this.audit.push({ ...e });
  }

  async listAudit(conversationId?: string): Promise<AuditEntry[]> {
    return this.audit.filter((a) => !conversationId || a.conversationId === conversationId).map((a) => ({ ...a }));
  }

  async insertLesson(l: NewLesson): Promise<LessonRow> {
    const prev = this.lessons.filter(
      (x) => x.domain === l.domain && x.type === l.type && (x.entity_ref ?? null) === (l.entity_ref ?? null) && x.status === 'active',
    );
    const version = prev.length ? Math.max(...prev.map((x) => x.version)) + 1 : 1;
    const row: LessonRow = {
      id: ++this.lessonSeq,
      domain: l.domain,
      type: l.type,
      entity_ref: l.entity_ref ?? null,
      payload: l.payload,
      confidence: l.confidence ?? 0.7,
      source: l.source,
      version,
      supersedes: l.supersedes ?? (prev.length ? prev[prev.length - 1]!.id : null),
      status: 'active',
      created_at: Date.now(),
    };
    // forrige aktive blir superseded
    for (const p of prev) p.status = 'superseded';
    this.lessons.push(row);
    return { ...row };
  }

  async getLessons(filter: { domain: LessonDomain; entityRef?: string | null; status?: LessonStatus }): Promise<LessonRow[]> {
    const status = filter.status ?? 'active';
    return this.lessons
      .filter((l) => l.domain === filter.domain && l.status === status)
      .filter((l) => filter.entityRef === undefined || (l.entity_ref ?? null) === (filter.entityRef ?? null))
      .map((l) => ({ ...l }));
  }

  async setLessonStatus(id: number, status: LessonStatus): Promise<LessonRow | null> {
    const l = this.lessons.find((x) => x.id === id);
    if (!l) return null;
    l.status = status;
    return { ...l };
  }
}
