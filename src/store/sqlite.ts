import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.recruiting-agents/scheduling-pilot');
export const SQLITE_FILENAME = 'state.sqlite';

export function sqlitePath(target: string = DEFAULT_DATA_DIR): string {
  const resolved = path.resolve(target);
  return resolved.endsWith('.sqlite') || resolved.endsWith('.db')
    ? resolved
    : path.join(resolved, SQLITE_FILENAME);
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error('SQLite directory must not be a symbolic link.');
  }
  fs.chmodSync(dir, 0o700);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code !== 'ESRCH';
  }
}

/**
 * Recursive deterministic JSON serializer matching `agents/desk/src/canonical.ts`.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value.normalize('NFKC'));
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => canonicalize(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter(k => obj[k] !== undefined)
      .sort();
    const pairs = keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${pairs.join(',')}}`;
  }
  return 'null';
}

/**
 * Computes the 16-hex SHA-256 proposal hash matching `agents/desk/src/canonical.ts`.
 */
export function computeProposalHash(payload: unknown): string {
  return crypto
    .createHash('sha256')
    .update(canonicalize(payload), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export interface EpisodeRow<TState = Record<string, unknown>> {
  episode_id: string;
  workflow: string;
  application_id: number | null;
  candidate_id: number | null;
  job_id: number | null;
  stage_id: number | null;
  status: string;
  state: TState;
  created_at: string;
  updated_at: string;
}

export type ChainStepStatus =
  | 'pending'
  | 'intent'
  | 'dispatched'
  | 'succeeded'
  | 'reconciled'
  | 'failed'
  | 'skipped';

export interface ChainStepRow<TInput = Record<string, unknown>, TOutput = Record<string, unknown> | null> {
  chain_id: string;
  step_index: number;
  step_key: string;
  episode_id: string;
  action_key: string;
  idempotency_key: string;
  service: 'greenhouse' | 'calendar' | 'gmail' | 'slack';
  operation: string;
  input: TInput;
  status: ChainStepStatus;
  provider_id: string | null;
  output: TOutput;
  error_text: string | null;
  attempt: number;
  created_at: string;
  updated_at: string;
}

export type ApprovalDecision =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'executed'
  | 'stale_aborted';

export interface ApprovalRow<TParams = Record<string, unknown>, TExpected = Record<string, unknown>> {
  proposal_hash: string;
  episode_id: string;
  action_key: string;
  chain_id: string | null;
  workflow: string;
  decision: ApprovalDecision;
  actor: string;
  params: TParams;
  expected_state: TExpected;
  draft_sha256: string | null;
  approved_at: string | null;
  executed_at: string | null;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export type TimerStatus =
  | 'pending'
  | 'firing'
  | 'fired'
  | 'cancelled'
  | 'aborted_state_changed'
  | 'failed';

export interface TimerRow<TPayload = Record<string, unknown>> {
  timer_key: string;
  episode_id: string;
  kind: string;
  fire_at: string;
  attempt: number;
  status: TimerStatus;
  payload: TPayload;
  fired_at: string | null;
  cancelled_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConflictHoldRow<TDetails = Record<string, unknown>> {
  hold_key: string;
  application_id: number;
  stage_id: number;
  scorecard_ids_hash: string;
  status: 'CONFLICT_HOLD' | 'RESOLVED_ADVANCE' | 'RESOLVED_REJECT';
  ruling: 'Advance' | 'Reject' | null;
  resolved_at: string | null;
  details: TDetails;
  created_at: string;
  updated_at: string;
}

export interface HmSignalRow<TDetails = Record<string, unknown>> {
  signal_key: string;
  application_id: number;
  stage_id: number;
  channel_id: string;
  message_ts: string;
  reactor_or_reply_id: string;
  target_stage_id: number;
  episode_id: string;
  status: 'claimed' | 'executed' | 'aborted_stale';
  details: TDetails;
  created_at: string;
  updated_at: string;
}

export class SqliteCoordinatorStore {
  readonly dbPath: string;
  readonly db: DatabaseSync;

  constructor(target: string = DEFAULT_DATA_DIR) {
    this.dbPath = sqlitePath(target);
    ensurePrivateDir(path.dirname(this.dbPath));
    this.db = new DatabaseSync(this.dbPath);
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // Ignore if in-memory or non-regular file
    }
    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS writer_lease (
        lock_name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS episodes (
        episode_id TEXT PRIMARY KEY,
        workflow TEXT NOT NULL,
        application_id INTEGER,
        candidate_id INTEGER,
        job_id INTEGER,
        stage_id INTEGER,
        status TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_episodes_app_stage
        ON episodes (application_id, stage_id);

      CREATE TABLE IF NOT EXISTS chain_steps (
        chain_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        step_key TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        service TEXT NOT NULL,
        operation TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_id TEXT,
        output_json TEXT,
        error_text TEXT,
        attempt INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (chain_id, step_key)
      );

      CREATE INDEX IF NOT EXISTS idx_chain_steps_episode
        ON chain_steps (episode_id, chain_id, step_index);

      CREATE TABLE IF NOT EXISTS approvals (
        proposal_hash TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        chain_id TEXT,
        workflow TEXT NOT NULL,
        decision TEXT NOT NULL,
        actor TEXT NOT NULL DEFAULT 'sam',
        params_json TEXT NOT NULL,
        expected_state_json TEXT NOT NULL,
        draft_sha256 TEXT,
        approved_at TEXT,
        executed_at TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_approvals_decision
        ON approvals (decision, approved_at);

      CREATE TABLE IF NOT EXISTS timers (
        timer_key TEXT PRIMARY KEY,
        episode_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        fire_at TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        fired_at TEXT,
        cancelled_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_timers_due
        ON timers (status, fire_at);

      CREATE TABLE IF NOT EXISTS wf4_conflict_holds (
        hold_key TEXT PRIMARY KEY,
        application_id INTEGER NOT NULL,
        stage_id INTEGER NOT NULL,
        scorecard_ids_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        ruling TEXT,
        resolved_at TEXT,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wf3_hm_signals (
        signal_key TEXT PRIMARY KEY,
        application_id INTEGER NOT NULL,
        stage_id INTEGER NOT NULL,
        channel_id TEXT NOT NULL,
        message_ts TEXT NOT NULL,
        reactor_or_reply_id TEXT NOT NULL,
        target_stage_id INTEGER NOT NULL,
        episode_id TEXT NOT NULL,
        status TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_wf3_hm_signals_app_stage
        ON wf3_hm_signals (application_id, stage_id);
    `);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Executes a synchronous callback inside a `BEGIN IMMEDIATE` transaction (single-writer lock).
   */
  withImmediateTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Ignore rollback failure if already rolled back
      }
      throw err;
    }
  }

  /**
   * Acquires the single-writer lease in `writer_lease`.
   */
  acquireWriterLease(options: {
    lockName?: string;
    ownerId?: string;
    pid?: number;
    ttlMs?: number;
    nowMs?: number;
    checkProcessAlive?: (pid: number) => boolean;
  } = {}): {
    acquired: boolean;
    ownerId: string;
    expiresAt: string;
    existingOwner?: { owner_id: string; pid: number; expires_at: string };
  } {
    const lockName = options.lockName ?? 'executor';
    const ownerId = options.ownerId ?? crypto.randomUUID();
    const pid = options.pid ?? process.pid;
    const ttlMs = options.ttlMs ?? 120_000;
    const nowMs = options.nowMs ?? Date.now();
    const aliveFn = options.checkProcessAlive ?? isProcessAlive;
    const nowIso = new Date(nowMs).toISOString();
    const expiresIso = new Date(nowMs + ttlMs).toISOString();

    return this.withImmediateTransaction(() => {
      const existing = this.db
        .prepare('SELECT lock_name, owner_id, pid, acquired_at, expires_at FROM writer_lease WHERE lock_name = ?')
        .get(lockName) as { lock_name: string; owner_id: string; pid: number; acquired_at: string; expires_at: string } | undefined;

      if (existing && existing.owner_id !== ownerId) {
        const expired = Date.parse(existing.expires_at) <= nowMs;
        const ownerDead = !aliveFn(existing.pid);
        if (!expired && !ownerDead) {
          return {
            acquired: false,
            ownerId,
            expiresAt: existing.expires_at,
            existingOwner: {
              owner_id: existing.owner_id,
              pid: existing.pid,
              expires_at: existing.expires_at,
            },
          };
        }
      }

      this.db
        .prepare(
          `INSERT INTO writer_lease (lock_name, owner_id, pid, acquired_at, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (lock_name) DO UPDATE SET
             owner_id = excluded.owner_id,
             pid = excluded.pid,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at`,
        )
        .run(lockName, ownerId, pid, nowIso, expiresIso);

      return { acquired: true, ownerId, expiresAt: expiresIso };
    });
  }

  renewWriterLease(ownerId: string, ttlMs = 120_000, nowMs = Date.now(), lockName = 'executor'): boolean {
    const expiresIso = new Date(nowMs + ttlMs).toISOString();
    return this.withImmediateTransaction(() => {
      const res = this.db
        .prepare('UPDATE writer_lease SET expires_at = ? WHERE lock_name = ? AND owner_id = ?')
        .run(expiresIso, lockName, ownerId);
      return Number(res.changes) > 0;
    });
  }

  releaseWriterLease(ownerId: string, lockName = 'executor'): boolean {
    return this.withImmediateTransaction(() => {
      const res = this.db
        .prepare('DELETE FROM writer_lease WHERE lock_name = ? AND owner_id = ?')
        .run(lockName, ownerId);
      return Number(res.changes) > 0;
    });
  }

  // ---------------------------------------------------------------------------
  // Episodes
  // ---------------------------------------------------------------------------

  upsertEpisode<TState = Record<string, unknown>>(input: {
    episode_id: string;
    workflow: string;
    application_id?: number | null;
    candidate_id?: number | null;
    job_id?: number | null;
    stage_id?: number | null;
    status: string;
    state: TState;
    now?: string;
  }): EpisodeRow<TState> {
    const now = input.now ?? new Date().toISOString();
    const stateJson = JSON.stringify(input.state ?? {});
    return this.withImmediateTransaction(() => {
      const existing = this.getEpisode(input.episode_id);
      const createdAt = existing?.created_at ?? now;
      this.db
        .prepare(
          `INSERT INTO episodes (
             episode_id, workflow, application_id, candidate_id, job_id, stage_id, status, state_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (episode_id) DO UPDATE SET
             workflow = excluded.workflow,
             application_id = excluded.application_id,
             candidate_id = excluded.candidate_id,
             job_id = excluded.job_id,
             stage_id = excluded.stage_id,
             status = excluded.status,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.episode_id,
          input.workflow,
          input.application_id !== undefined ? input.application_id : (existing?.application_id ?? null),
          input.candidate_id !== undefined ? input.candidate_id : (existing?.candidate_id ?? null),
          input.job_id !== undefined ? input.job_id : (existing?.job_id ?? null),
          input.stage_id !== undefined ? input.stage_id : (existing?.stage_id ?? null),
          input.status,
          stateJson,
          createdAt,
          now,
        );
      return this.getEpisode<TState>(input.episode_id)!;
    });
  }

  getEpisode<TState = Record<string, unknown>>(episodeId: string): EpisodeRow<TState> | null {
    const row = this.db
      .prepare('SELECT * FROM episodes WHERE episode_id = ?')
      .get(episodeId) as Record<string, any> | undefined;
    if (!row) return null;
    return {
      episode_id: row.episode_id,
      workflow: row.workflow,
      application_id: row.application_id ?? null,
      candidate_id: row.candidate_id ?? null,
      job_id: row.job_id ?? null,
      stage_id: row.stage_id ?? null,
      status: row.status,
      state: JSON.parse(row.state_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  listEpisodes<TState = Record<string, unknown>>(filter: {
    workflow?: string;
    status?: string;
    application_id?: number;
  } = {}): EpisodeRow<TState>[] {
    const conditions: string[] = [];
    const params: any[] = [];
    if (filter.workflow !== undefined) {
      conditions.push('workflow = ?');
      params.push(filter.workflow);
    }
    if (filter.status !== undefined) {
      conditions.push('status = ?');
      params.push(filter.status);
    }
    if (filter.application_id !== undefined) {
      conditions.push('application_id = ?');
      params.push(filter.application_id);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM episodes ${whereClause} ORDER BY created_at ASC, episode_id ASC`)
      .all(...params) as Record<string, any>[];
    return rows.map(row => ({
      episode_id: row.episode_id,
      workflow: row.workflow,
      application_id: row.application_id ?? null,
      candidate_id: row.candidate_id ?? null,
      job_id: row.job_id ?? null,
      stage_id: row.stage_id ?? null,
      status: row.status,
      state: JSON.parse(row.state_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }));
  }

  // ---------------------------------------------------------------------------
  // Chain Steps (Multi-Step Resumable Execution State)
  // ---------------------------------------------------------------------------

  upsertChainStep<TInput = Record<string, unknown>, TOutput = Record<string, unknown> | null>(input: {
    chain_id: string;
    step_index: number;
    step_key: string;
    episode_id: string;
    action_key: string;
    idempotency_key: string;
    service: 'greenhouse' | 'calendar' | 'gmail' | 'slack';
    operation: string;
    input: TInput;
    status: ChainStepStatus;
    provider_id?: string | null;
    output?: TOutput;
    error_text?: string | null;
    attempt?: number;
    now?: string;
  }): ChainStepRow<TInput, TOutput> {
    const now = input.now ?? new Date().toISOString();
    return this.withImmediateTransaction(() => {
      const existing = this.getChainStep(input.chain_id, input.step_key);
      const createdAt = existing?.created_at ?? now;
      const providerId = input.provider_id !== undefined ? input.provider_id : (existing?.provider_id ?? null);
      const outputJson = input.output !== undefined
        ? (input.output === null ? null : JSON.stringify(input.output))
        : (existing?.output !== undefined && existing.output !== null ? JSON.stringify(existing.output) : null);
      const errorText = input.error_text !== undefined ? input.error_text : (existing?.error_text ?? null);
      const attempt = input.attempt ?? existing?.attempt ?? 1;

      this.db
        .prepare(
          `INSERT INTO chain_steps (
             chain_id, step_index, step_key, episode_id, action_key, idempotency_key,
             service, operation, input_json, status, provider_id, output_json, error_text,
             attempt, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (chain_id, step_key) DO UPDATE SET
             step_index = excluded.step_index,
             episode_id = excluded.episode_id,
             action_key = excluded.action_key,
             idempotency_key = excluded.idempotency_key,
             service = excluded.service,
             operation = excluded.operation,
             input_json = excluded.input_json,
             status = excluded.status,
             provider_id = excluded.provider_id,
             output_json = excluded.output_json,
             error_text = excluded.error_text,
             attempt = excluded.attempt,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.chain_id,
          input.step_index,
          input.step_key,
          input.episode_id,
          input.action_key,
          input.idempotency_key,
          input.service,
          input.operation,
          JSON.stringify(input.input ?? {}),
          input.status,
          providerId,
          outputJson,
          errorText,
          attempt,
          createdAt,
          now,
        );

      return this.getChainStep<TInput, TOutput>(input.chain_id, input.step_key)!;
    });
  }

  getChainStep<TInput = Record<string, unknown>, TOutput = Record<string, unknown> | null>(
    chainId: string,
    stepKey: string,
  ): ChainStepRow<TInput, TOutput> | null {
    const row = this.db
      .prepare('SELECT * FROM chain_steps WHERE chain_id = ? AND step_key = ?')
      .get(chainId, stepKey) as Record<string, any> | undefined;
    if (!row) return null;
    return this.mapChainStepRow<TInput, TOutput>(row);
  }

  listChainSteps(chainId: string): ChainStepRow[] {
    const rows = this.db
      .prepare('SELECT * FROM chain_steps WHERE chain_id = ? ORDER BY step_index ASC, step_key ASC')
      .all(chainId) as Record<string, any>[];
    return rows.map(r => this.mapChainStepRow(r));
  }

  clearPendingChainSteps(chainId: string): number {
    return this.withImmediateTransaction(() => {
      const res = this.db
        .prepare("DELETE FROM chain_steps WHERE chain_id = ? AND status = 'pending'")
        .run(chainId);
      return Number(res.changes);
    });
  }

  private mapChainStepRow<TInput = Record<string, unknown>, TOutput = Record<string, unknown> | null>(
    row: Record<string, any>,
  ): ChainStepRow<TInput, TOutput> {
    return {
      chain_id: row.chain_id,
      step_index: row.step_index,
      step_key: row.step_key,
      episode_id: row.episode_id,
      action_key: row.action_key,
      idempotency_key: row.idempotency_key,
      service: row.service,
      operation: row.operation,
      input: JSON.parse(row.input_json),
      status: row.status,
      provider_id: row.provider_id ?? null,
      output: row.output_json ? JSON.parse(row.output_json) : null,
      error_text: row.error_text ?? null,
      attempt: row.attempt,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Authenticated Approvals (16-hex SHA-256 proposal_hash)
  // ---------------------------------------------------------------------------

  registerProposal<TParams = Record<string, unknown>, TExpected = Record<string, unknown>>(input: {
    episode_id: string;
    action_key: string;
    chain_id?: string | null;
    workflow: string;
    params: TParams;
    expected_state: TExpected;
    draft_sha256?: string | null;
    actor?: string;
    now?: string;
  }): ApprovalRow<TParams, TExpected> {
    const now = input.now ?? new Date().toISOString();
    const proposalHash = computeProposalHash({
      episode_id: input.episode_id,
      action_key: input.action_key,
      workflow: input.workflow,
      params: input.params,
      expected_state: input.expected_state,
      draft_sha256: input.draft_sha256 ?? null,
    });

    return this.withImmediateTransaction(() => {
      const existing = this.getApproval<TParams, TExpected>(proposalHash);
      if (existing) return existing;

      this.db
        .prepare(
          `INSERT INTO approvals (
             proposal_hash, episode_id, action_key, chain_id, workflow, decision, actor,
             params_json, expected_state_json, draft_sha256, approved_at, executed_at,
             failure_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          proposalHash,
          input.episode_id,
          input.action_key,
          input.chain_id ?? null,
          input.workflow,
          input.actor ?? 'sam',
          JSON.stringify(input.params ?? {}),
          JSON.stringify(input.expected_state ?? {}),
          input.draft_sha256 ?? null,
          now,
          now,
        );

      return this.getApproval<TParams, TExpected>(proposalHash)!;
    });
  }

  grantApproval<TParams = Record<string, unknown>, TExpected = Record<string, unknown>>(input: {
    proposal_hash: string;
    decision: 'approved' | 'declined';
    actor?: string;
    expected_params?: TParams;
    now?: string;
  }): ApprovalRow<TParams, TExpected> {
    if (!/^[0-9a-f]{16}$/.test(input.proposal_hash)) {
      throw new Error(`Invalid proposal_hash ${JSON.stringify(input.proposal_hash)}; expected 16-hex SHA-256 prefix.`);
    }
    const now = input.now ?? new Date().toISOString();
    return this.withImmediateTransaction(() => {
      const existing = this.getApproval<TParams, TExpected>(input.proposal_hash);
      if (!existing) {
        throw new Error(`Unknown proposal_hash: ${input.proposal_hash}`);
      }
      if (input.expected_params !== undefined) {
        if (canonicalize(existing.params) !== canonicalize(input.expected_params)) {
          throw new Error(`Approval parameter mismatch for proposal_hash ${input.proposal_hash}.`);
        }
      }
      this.db
        .prepare(
          `UPDATE approvals
           SET decision = ?, actor = ?, approved_at = ?, updated_at = ?
           WHERE proposal_hash = ?`,
        )
        .run(
          input.decision,
          input.actor ?? 'sam',
          input.decision === 'approved' ? now : existing.approved_at,
          now,
          input.proposal_hash,
        );

      // If a WF3 HM signal proposal is declined by Sam, release any claimed HM signal row
      // for that episode so a subsequent HM thread reply can re-route the candidate.
      if (input.decision === 'declined' && existing.workflow === 'wf3_hm_signal') {
        this.db
          .prepare(
            `UPDATE wf3_hm_signals
             SET status = 'aborted_stale', updated_at = ?
             WHERE episode_id = ? AND status = 'claimed'`,
          )
          .run(now, existing.episode_id);
      }

      return this.getApproval<TParams, TExpected>(input.proposal_hash)!;
    });
  }

  supersedeApprovalsForEpisode(
    episodeId: string,
    reason: string,
    options: { keepProposalHash?: string; now?: string } = {},
  ): number {
    const now = options.now ?? new Date().toISOString();
    return this.withImmediateTransaction(() => {
      if (options.keepProposalHash) {
        const res = this.db
          .prepare(
            `UPDATE approvals
             SET decision = 'stale_aborted', failure_reason = ?, updated_at = ?
             WHERE episode_id = ? AND proposal_hash != ? AND decision IN ('pending', 'approved')`,
          )
          .run(reason, now, episodeId, options.keepProposalHash);
        return Number(res.changes);
      }
      const res = this.db
        .prepare(
          `UPDATE approvals
           SET decision = 'stale_aborted', failure_reason = ?, updated_at = ?
           WHERE episode_id = ? AND decision IN ('pending', 'approved')`,
        )
        .run(reason, now, episodeId);
      return Number(res.changes);
    });
  }

  markApprovalOutcome(
    proposalHash: string,
    decision: 'executed' | 'stale_aborted',
    options: { failureReason?: string | null; now?: string } = {},
  ): ApprovalRow | null {
    const now = options.now ?? new Date().toISOString();
    return this.withImmediateTransaction(() => {
      this.db
        .prepare(
          `UPDATE approvals
           SET decision = ?, executed_at = ?, failure_reason = ?, updated_at = ?
           WHERE proposal_hash = ?`,
        )
        .run(
          decision,
          decision === 'executed' ? now : null,
          options.failureReason ?? null,
          now,
          proposalHash,
        );
      return this.getApproval(proposalHash);
    });
  }

  getApproval<TParams = Record<string, unknown>, TExpected = Record<string, unknown>>(
    proposalHash: string,
  ): ApprovalRow<TParams, TExpected> | null {
    const row = this.db
      .prepare('SELECT * FROM approvals WHERE proposal_hash = ?')
      .get(proposalHash) as Record<string, any> | undefined;
    if (!row) return null;
    return this.mapApprovalRow<TParams, TExpected>(row);
  }

  listReadyApprovals(): ApprovalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE decision = 'approved' ORDER BY approved_at ASC, created_at ASC")
      .all() as Record<string, any>[];
    return rows.map(r => this.mapApprovalRow(r));
  }

  private mapApprovalRow<TParams = Record<string, unknown>, TExpected = Record<string, unknown>>(
    row: Record<string, any>,
  ): ApprovalRow<TParams, TExpected> {
    return {
      proposal_hash: row.proposal_hash,
      episode_id: row.episode_id,
      action_key: row.action_key,
      chain_id: row.chain_id ?? null,
      workflow: row.workflow,
      decision: row.decision,
      actor: row.actor,
      params: JSON.parse(row.params_json),
      expected_state: JSON.parse(row.expected_state_json),
      draft_sha256: row.draft_sha256 ?? null,
      approved_at: row.approved_at ?? null,
      executed_at: row.executed_at ?? null,
      failure_reason: row.failure_reason ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Timers (Deliberation & Reminder Timers)
  // ---------------------------------------------------------------------------

  scheduleTimer<TPayload = Record<string, unknown>>(input: {
    timer_key: string;
    episode_id: string;
    kind: string;
    fire_at: string;
    attempt?: number;
    status?: TimerStatus;
    payload: TPayload;
    now?: string;
  }): TimerRow<TPayload> {
    const now = input.now ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(input.fire_at))) {
      throw new Error(`Invalid timer fire_at timestamp: ${input.fire_at}`);
    }
    return this.withImmediateTransaction(() => {
      const existing = this.getTimer<TPayload>(input.timer_key);
      const createdAt = existing?.created_at ?? now;
      this.db
        .prepare(
          `INSERT INTO timers (
             timer_key, episode_id, kind, fire_at, attempt, status, payload_json,
             fired_at, cancelled_reason, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
           ON CONFLICT (timer_key) DO UPDATE SET
             episode_id = excluded.episode_id,
             kind = excluded.kind,
             fire_at = excluded.fire_at,
             attempt = excluded.attempt,
             status = excluded.status,
             payload_json = excluded.payload_json,
             fired_at = CASE WHEN excluded.status = 'pending' THEN NULL ELSE timers.fired_at END,
             cancelled_reason = CASE WHEN excluded.status = 'pending' THEN NULL ELSE timers.cancelled_reason END,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.timer_key,
          input.episode_id,
          input.kind,
          input.fire_at,
          input.attempt ?? existing?.attempt ?? 1,
          input.status ?? 'pending',
          JSON.stringify(input.payload ?? {}),
          createdAt,
          now,
        );
      return this.getTimer<TPayload>(input.timer_key)!;
    });
  }

  getTimer<TPayload = Record<string, unknown>>(timerKey: string): TimerRow<TPayload> | null {
    const row = this.db
      .prepare('SELECT * FROM timers WHERE timer_key = ?')
      .get(timerKey) as Record<string, any> | undefined;
    if (!row) return null;
    return this.mapTimerRow<TPayload>(row);
  }

  listDueTimers(nowIso: string = new Date().toISOString()): TimerRow[] {
    const rows = this.db
      .prepare("SELECT * FROM timers WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC, timer_key ASC")
      .all(nowIso) as Record<string, any>[];
    return rows.map(r => this.mapTimerRow(r));
  }

  listTimersForEpisode(episodeId: string): TimerRow[] {
    const rows = this.db
      .prepare('SELECT * FROM timers WHERE episode_id = ? ORDER BY fire_at ASC, timer_key ASC')
      .all(episodeId) as Record<string, any>[];
    return rows.map(r => this.mapTimerRow(r));
  }

  updateTimerStatus(
    timerKey: string,
    status: TimerStatus,
    options: { fireAt?: string; reason?: string | null; now?: string } = {},
  ): TimerRow | null {
    const now = options.now ?? new Date().toISOString();
    return this.withImmediateTransaction(() => {
      const existing = this.getTimer(timerKey);
      if (!existing) return null;
      this.db
        .prepare(
          `UPDATE timers
           SET status = ?,
               fire_at = ?,
               fired_at = ?,
               cancelled_reason = ?,
               updated_at = ?
           WHERE timer_key = ?`,
        )
        .run(
          status,
          options.fireAt ?? existing.fire_at,
          status === 'fired' ? now : existing.fired_at,
          options.reason !== undefined ? options.reason : existing.cancelled_reason,
          now,
          timerKey,
        );
      return this.getTimer(timerKey);
    });
  }

  cancelTimersByPrefix(prefix: string, reason: string, now: string = new Date().toISOString()): number {
    return this.withImmediateTransaction(() => {
      const res = this.db
        .prepare(
          `UPDATE timers
           SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
           WHERE timer_key LIKE ? AND status = 'pending'`,
        )
        .run(reason, now, `${prefix}%`);
      return Number(res.changes);
    });
  }

  private mapTimerRow<TPayload = Record<string, unknown>>(row: Record<string, any>): TimerRow<TPayload> {
    return {
      timer_key: row.timer_key,
      episode_id: row.episode_id,
      kind: row.kind,
      fire_at: row.fire_at,
      attempt: row.attempt,
      status: row.status,
      payload: JSON.parse(row.payload_json),
      fired_at: row.fired_at ?? null,
      cancelled_reason: row.cancelled_reason ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Workflow 4 Conflict Holds (Mixed Panel Scorecard Ratings)
  // ---------------------------------------------------------------------------

  upsertConflictHold<TDetails = Record<string, unknown>>(input: {
    application_id: number;
    stage_id: number;
    scorecard_ids: number[];
    details: TDetails;
    now?: string;
  }): ConflictHoldRow<TDetails> {
    const now = input.now ?? new Date().toISOString();
    const sortedIds = [...new Set(input.scorecard_ids.map(Number))].sort((a, b) => a - b);
    const scorecardIdsHash = computeProposalHash(sortedIds);
    const holdKey = `wf4_conflict:${input.application_id}:${input.stage_id}:${scorecardIdsHash}`;

    return this.withImmediateTransaction(() => {
      const existing = this.getConflictHold<TDetails>(holdKey);
      if (existing) return existing;

      this.db
        .prepare(
          `INSERT INTO wf4_conflict_holds (
             hold_key, application_id, stage_id, scorecard_ids_hash, status,
             ruling, resolved_at, details_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'CONFLICT_HOLD', NULL, NULL, ?, ?, ?)`,
        )
        .run(
          holdKey,
          input.application_id,
          input.stage_id,
          scorecardIdsHash,
          JSON.stringify(input.details ?? {}),
          now,
          now,
        );
      return this.getConflictHold<TDetails>(holdKey)!;
    });
  }

  resolveConflictHold(
    holdKey: string,
    ruling: 'Advance' | 'Reject',
    now: string = new Date().toISOString(),
  ): ConflictHoldRow | null {
    return this.withImmediateTransaction(() => {
      const status = ruling === 'Advance' ? 'RESOLVED_ADVANCE' : 'RESOLVED_REJECT';
      this.db
        .prepare(
          `UPDATE wf4_conflict_holds
           SET status = ?, ruling = ?, resolved_at = ?, updated_at = ?
           WHERE hold_key = ?`,
        )
        .run(status, ruling, now, now, holdKey);
      return this.getConflictHold(holdKey);
    });
  }

  getConflictHold<TDetails = Record<string, unknown>>(holdKey: string): ConflictHoldRow<TDetails> | null {
    const row = this.db
      .prepare('SELECT * FROM wf4_conflict_holds WHERE hold_key = ?')
      .get(holdKey) as Record<string, any> | undefined;
    if (!row) return null;
    return {
      hold_key: row.hold_key,
      application_id: row.application_id,
      stage_id: row.stage_id,
      scorecard_ids_hash: row.scorecard_ids_hash,
      status: row.status,
      ruling: row.ruling ?? null,
      resolved_at: row.resolved_at ?? null,
      details: JSON.parse(row.details_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  // ---------------------------------------------------------------------------
  // Workflow 3 HM Positive Signals (Single-Consumption per application_id + stage_id)
  // ---------------------------------------------------------------------------

  claimHmSignal<TDetails = Record<string, unknown>>(input: {
    signal_key: string;
    application_id: number;
    stage_id: number;
    channel_id: string;
    message_ts: string;
    reactor_or_reply_id: string;
    target_stage_id: number;
    episode_id: string;
    details: TDetails;
    now?: string;
  }): { claimed: boolean; row: HmSignalRow<TDetails>; reason?: 'DUPLICATE_SIGNAL_KEY' | 'STAGE_ALREADY_CONSUMED' } {
    const now = input.now ?? new Date().toISOString();
    return this.withImmediateTransaction(() => {
      const existingByKey = this.getHmSignal<TDetails>(input.signal_key);
      if (existingByKey && existingByKey.status !== 'aborted_stale') {
        return {
          claimed: false,
          row: existingByKey,
          reason: 'DUPLICATE_SIGNAL_KEY',
        };
      }

      const existingForStage = this.getActiveHmSignalForAppStage<TDetails>(
        input.application_id,
        input.stage_id,
      );
      if (existingForStage) {
        return {
          claimed: false,
          row: existingForStage,
          reason: 'STAGE_ALREADY_CONSUMED',
        };
      }

      this.db
        .prepare(
          `INSERT INTO wf3_hm_signals (
             signal_key, application_id, stage_id, channel_id, message_ts,
             reactor_or_reply_id, target_stage_id, episode_id, status,
             details_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?)
           ON CONFLICT (signal_key) DO UPDATE SET
             target_stage_id = excluded.target_stage_id,
             episode_id = excluded.episode_id,
             status = 'claimed',
             details_json = excluded.details_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.signal_key,
          input.application_id,
          input.stage_id,
          input.channel_id,
          input.message_ts,
          input.reactor_or_reply_id,
          input.target_stage_id,
          input.episode_id,
          JSON.stringify(input.details ?? {}),
          now,
          now,
        );

      return {
        claimed: true,
        row: this.getHmSignal<TDetails>(input.signal_key)!,
      };
    });
  }

  updateHmSignalStatus<TDetails = Record<string, unknown>>(
    signalKey: string,
    status: 'claimed' | 'executed' | 'aborted_stale',
    now: string = new Date().toISOString(),
  ): HmSignalRow<TDetails> | null {
    return this.withImmediateTransaction(() => {
      this.db
        .prepare('UPDATE wf3_hm_signals SET status = ?, updated_at = ? WHERE signal_key = ?')
        .run(status, now, signalKey);
      return this.getHmSignal<TDetails>(signalKey);
    });
  }

  getHmSignal<TDetails = Record<string, unknown>>(signalKey: string): HmSignalRow<TDetails> | null {
    const row = this.db
      .prepare('SELECT * FROM wf3_hm_signals WHERE signal_key = ?')
      .get(signalKey) as Record<string, any> | undefined;
    if (!row) return null;
    return this.mapHmSignalRow<TDetails>(row);
  }

  getActiveHmSignalForAppStage<TDetails = Record<string, unknown>>(
    applicationId: number,
    stageId: number,
  ): HmSignalRow<TDetails> | null {
    const row = this.db
      .prepare(
        `SELECT * FROM wf3_hm_signals
         WHERE application_id = ? AND stage_id = ? AND status IN ('claimed', 'executed')
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(applicationId, stageId) as Record<string, any> | undefined;
    if (!row) return null;
    return this.mapHmSignalRow<TDetails>(row);
  }

  private mapHmSignalRow<TDetails = Record<string, unknown>>(row: Record<string, any>): HmSignalRow<TDetails> {
    return {
      signal_key: row.signal_key,
      application_id: row.application_id,
      stage_id: row.stage_id,
      channel_id: row.channel_id,
      message_ts: row.message_ts,
      reactor_or_reply_id: row.reactor_or_reply_id,
      target_stage_id: row.target_stage_id,
      episode_id: row.episode_id,
      status: row.status,
      details: JSON.parse(row.details_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
