import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isActionDischarged, sha256, summarizeLedger } from '../../worker/ledger.mjs';
import { sanitizeDraftText } from '../../worker/pilot.mjs';
import {
  type ApprovalRow,
  computeProposalHash,
  type EpisodeRow,
  type SqliteCoordinatorStore,
} from '../store/sqlite.ts';

export interface CheckpointFactItem {
  text: string;
  evidence?: string[];
}

export interface CheckpointNextActionItem {
  action_key: string;
  text?: string;
  draft?: string;
  evidence?: string[];
  workflow?: string;
  chain_id?: string | null;
  params?: Record<string, unknown>;
  expected_state?: Record<string, unknown>;
  draft_sha256?: string | null;
  actor?: string;
}

export interface CheckpointEpisodeItem {
  episode_id: string;
  status: 'open' | 'closed' | string;
  workflow?: string;
  application_id?: number | null;
  candidate_id?: number | null;
  job_id?: number | null;
  stage_id?: number | null;
  candidate_name?: string;
  facts?: CheckpointFactItem[];
  next_actions?: CheckpointNextActionItem[];
  resolution?: { text: string; evidence?: string[] } | null;
  unknowns?: string[];
  state?: Record<string, unknown>;
}

export interface CheckpointHmSignalInput {
  signal_key: string;
  application_id: number;
  stage_id: number;
  channel_id: string;
  message_ts: string;
  reactor_or_reply_id: string;
  target_stage_id: number;
  episode_id: string;
  details?: Record<string, unknown>;
}

export interface CheckpointProposalInput {
  episode_id: string;
  action_key: string;
  chain_id?: string | null;
  workflow: string;
  params: Record<string, unknown>;
  expected_state?: Record<string, unknown>;
  draft_sha256?: string | null;
  actor?: string;
}

export interface CheckpointDocument {
  scanned_at?: string;
  partial?: string[];
  report?: {
    coverage?: Record<string, unknown>;
    episodes?: CheckpointEpisodeItem[];
    unknowns?: string[];
  };
  episodes?: CheckpointEpisodeItem[];
  proposals?: CheckpointProposalInput[];
  hm_signals?: CheckpointHmSignalInput[];
  changes?: {
    new_or_changed?: string[];
    removed?: string[];
  };
}

export interface SyncCheckpointOptions {
  dataDir?: string;
  now?: string;
  writeApprovalsMd?: boolean;
  writeDraftsMd?: boolean;
  approvalsFilename?: string;
  draftsFilename?: string;
  cliScriptPath?: string;
}

export interface SyncCheckpointResult {
  scanned_at: string;
  episodes_upserted: number;
  episodes_preserved_in_flight: number;
  proposals_registered: number;
  proposals_preserved: number;
  proposals_superseded: number;
  hm_signals_claimed: number;
  hm_signals_preserved: number;
  pending_approvals: ApprovalRow[];
  approvals_md_path: string | null;
  drafts_md_path: string | null;
}

const PROTECTED_EPISODE_STATUSES = new Set([
  'AWAITING_JOB_MAPPING',
  'AWAITING_MANUAL_NOTES',
  'CONFLICT_HOLD',
  'PENDING_APPROVAL',
  'pending_approval',
  'DECLINED',
  'CANCELLED',
  'COMPLETED_ADVANCED_TO_HM_REVIEW',
  'COMPLETED_REJECTION_DELIBERATION_SCHEDULED',
  'CLOSED_MANUAL_NOTES_EXPIRED',
  'deliberation_holding',
  'rejected',
  'completed',
  'transferred',
  'forked',
  'stage_moved',
  'owner_assigned',
  'dispatched',
  'executing',
]);

export function assertPathNotSymlink(targetPath: string): void {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link path: ${targetPath}`);
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export function atomicWritePrivate(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error(`Refusing to write into symlinked directory: ${dir}`);
  }
  fs.chmodSync(dir, 0o700);
  assertPathNotSymlink(filePath);

  const tmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error on cleanup
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Ignore unlink error if tmp was not created
    }
    throw err;
  }
}

function escapeMarkdownCell(input: unknown): string {
  return String(input ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

function inferNumericFieldFromFacts(
  facts: CheckpointFactItem[] | undefined,
  patterns: RegExp[],
): number | null {
  if (!Array.isArray(facts)) return null;
  for (const f of facts) {
    const text = String(f?.text ?? '');
    for (const pat of patterns) {
      const m = text.match(pat);
      if (m && m[1]) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
  }
  return null;
}

function hasInFlightChainSteps(store: SqliteCoordinatorStore, episodeId: string): boolean {
  const row = store.db
    .prepare(
      `SELECT 1 FROM chain_steps
       WHERE episode_id = ? AND status IN ('intent', 'dispatched', 'succeeded', 'reconciled')
       LIMIT 1`,
    )
    .get(episodeId);
  return Boolean(row);
}

/**
 * Renders a human-readable Markdown summary of pending approvals, job mappings, and conflict holds
 * including each 16-hex `proposal_hash`, workflow, candidate/application, and exact CLI commands.
 */
export function renderPendingApprovalsMarkdown(
  store: SqliteCoordinatorStore,
  options: {
    dataDir?: string;
    scannedAt?: string;
    cliScriptPath?: string;
  } = {},
): string {
  const dataDir = options.dataDir ?? path.dirname(store.dbPath);
  const cliScript = options.cliScriptPath ?? 'worker/executor-tick.mjs';
  const scannedAt = options.scannedAt ?? new Date().toISOString();

  const pendingApprovals = store.listApprovals({ decision: 'pending' });
  const awaitingJobEpisodes = store.listEpisodes({ status: 'AWAITING_JOB_MAPPING' });
  const conflictHolds = store.listConflictHolds({ status: 'CONFLICT_HOLD' });

  const lines: string[] = [
    '# Pending Operator Approvals',
    '',
    `Synchronized at: ${scannedAt}`,
    `Pending proposals: ${pendingApprovals.length}`,
    '',
  ];

  if (pendingApprovals.length === 0) {
    lines.push('No pending proposals awaiting approval.');
    lines.push('');
  } else {
    lines.push(
      '| Proposal Hash (`16-hex`) | Workflow | Episode | Candidate / Application | Action Key | Status |',
    );
    lines.push(
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const app of pendingApprovals) {
      const ep = store.getEpisode(app.episode_id);
      const params = (app.params ?? {}) as Record<string, any>;
      const expected = (app.expected_state ?? {}) as Record<string, any>;
      const epState = (ep?.state ?? {}) as Record<string, any>;
      const candidateName =
        params.candidate_name ??
        epState.candidate_name ??
        params.first_name ??
        null;
      const applicationId =
        params.application_id ??
        expected.application_id ??
        ep?.application_id ??
        null;
      const candidateId =
        params.candidate_id ??
        ep?.candidate_id ??
        null;
      const candAppLabel = escapeMarkdownCell(
        [
          candidateName ? String(candidateName) : null,
          applicationId != null ? `app:${applicationId}` : null,
          candidateId != null ? `cand:${candidateId}` : null,
        ]
          .filter(Boolean)
          .join(' / ') || 'n/a',
      );

      lines.push(
        `| \`${escapeMarkdownCell(app.proposal_hash)}\` | \`${escapeMarkdownCell(app.workflow)}\` | \`${escapeMarkdownCell(app.episode_id)}\` | ${candAppLabel} | \`${escapeMarkdownCell(app.action_key)}\` | \`${escapeMarkdownCell(app.decision)}\` |`,
      );
    }
    lines.push('');

    for (const app of pendingApprovals) {
      const ep = store.getEpisode(app.episode_id);
      const params = (app.params ?? {}) as Record<string, any>;
      const expected = (app.expected_state ?? {}) as Record<string, any>;
      const epState = (ep?.state ?? {}) as Record<string, any>;
      const candidateName =
        params.candidate_name ?? epState.candidate_name ?? null;
      const applicationId =
        params.application_id ??
        expected.application_id ??
        ep?.application_id ??
        null;
      const rawDraftText =
        typeof params.draft === 'string' && params.draft.trim()
          ? params.draft.trim()
          : typeof params.text === 'string' && params.text.trim()
            ? params.text.trim()
            : null;
      const draftText = rawDraftText ? sanitizeDraftText(rawDraftText) : null;

      lines.push(`## Proposal \`${app.proposal_hash}\` (${app.workflow})`);
      lines.push('');
      lines.push(`- **Proposal Hash**: \`${app.proposal_hash}\``);
      lines.push(`- **Episode ID**: \`${app.episode_id}\``);
      lines.push(`- **Workflow**: \`${app.workflow}\``);
      lines.push(`- **Action Key**: \`${app.action_key}\``);
      if (candidateName) {
        lines.push(`- **Candidate**: ${candidateName}`);
      }
      if (applicationId != null) {
        lines.push(`- **Application ID**: \`${applicationId}\``);
      }
      if (draftText) {
        lines.push('');
        lines.push('### Draft / Summary');
        lines.push('');
        lines.push(draftText);
      }
      lines.push('');
      lines.push('### Operator CLI Commands');
      lines.push('');
      lines.push('```bash');
      lines.push(
        `node ${cliScript} approve ${app.proposal_hash} --data-dir ${JSON.stringify(dataDir)}`,
      );
      lines.push(
        `node ${cliScript} decline ${app.proposal_hash} --data-dir ${JSON.stringify(dataDir)}`,
      );
      lines.push('```');
      lines.push('');
    }
  }

  if (awaitingJobEpisodes.length > 0) {
    lines.push('## Episodes Awaiting Job Mapping (WF1)');
    lines.push('');
    for (const ep of awaitingJobEpisodes) {
      lines.push(`- Episode \`${escapeMarkdownCell(ep.episode_id)}\`:`);
      lines.push('  ```bash');
      lines.push(
        `  node ${cliScript} resolve-job ${JSON.stringify(ep.episode_id)} <job_id> --data-dir ${JSON.stringify(dataDir)}`,
      );
      lines.push('  ```');
    }
    lines.push('');
  }

  if (conflictHolds.length > 0) {
    lines.push('## Active Scorecard Conflict Holds (WF4)');
    lines.push('');
    for (const hold of conflictHolds) {
      lines.push(
        `- Application \`${hold.application_id}\`, Stage \`${hold.stage_id}\` (\`${hold.hold_key}\`):`,
      );
      lines.push('  ```bash');
      lines.push(
        `  node ${cliScript} resolve-conflict ${hold.application_id} ${hold.stage_id} <advance|reject|hold> --data-dir ${JSON.stringify(dataDir)}`,
      );
      lines.push('  ```');
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

/**
 * Writes `APPROVALS.md` and/or `DRAFTS.md` atomically with `0600` permissions and symlink refusal.
 */
export function writeOperatorApprovalSummaries(
  store: SqliteCoordinatorStore,
  options: SyncCheckpointOptions = {},
): {
  markdown: string;
  approvals_md_path: string | null;
  drafts_md_path: string | null;
} {
  const dataDir = options.dataDir ?? path.dirname(store.dbPath);
  const now = options.now ?? new Date().toISOString();
  const markdownSummary = renderPendingApprovalsMarkdown(store, {
    dataDir,
    scannedAt: now,
    cliScriptPath: options.cliScriptPath,
  });

  let approvalsMdPath: string | null = null;
  if (options.writeApprovalsMd !== false) {
    approvalsMdPath = path.join(
      dataDir,
      options.approvalsFilename ?? 'APPROVALS.md',
    );
    atomicWritePrivate(approvalsMdPath, markdownSummary);
  }

  let draftsMdPath: string | null = null;
  if (options.writeDraftsMd ?? true) {
    draftsMdPath = path.join(dataDir, options.draftsFilename ?? 'DRAFTS.md');
    assertPathNotSymlink(draftsMdPath);
    if (fs.existsSync(draftsMdPath)) {
      const existingContent = fs.readFileSync(draftsMdPath, 'utf8');
      const marker = '\n<!-- SQLITE_COORDINATOR_APPROVALS -->\n';
      const baseContent = existingContent.includes(marker)
        ? existingContent.split(marker)[0]
        : existingContent.trimEnd();
      atomicWritePrivate(
        draftsMdPath,
        `${baseContent}\n${marker}\n${markdownSummary}`,
      );
    } else {
      atomicWritePrivate(draftsMdPath, markdownSummary);
    }
  }

  return {
    markdown: markdownSummary,
    approvals_md_path: approvalsMdPath,
    drafts_md_path: draftsMdPath,
  };
}

/**
 * Reconciles open episodes, proposals, and HM signals from `checkpoint.json` (or structured scan output)
 * into `state.sqlite` without overwriting or resetting in-progress `chain_steps`, already-granted `approvals`,
 * or consumed `wf3_hm_signals`. Writes `APPROVALS.md` (and updates `DRAFTS.md` when requested) in `dataDir`.
 */
export function syncCheckpointToCoordinatorStore(
  store: SqliteCoordinatorStore,
  checkpoint: CheckpointDocument,
  options: SyncCheckpointOptions = {},
): SyncCheckpointResult {
  const now = options.now ?? checkpoint?.scanned_at ?? new Date().toISOString();
  const dataDir = options.dataDir ?? path.dirname(store.dbPath);
  const episodesInput: CheckpointEpisodeItem[] = Array.isArray(checkpoint?.report?.episodes)
    ? checkpoint.report!.episodes!
    : Array.isArray(checkpoint?.episodes)
      ? checkpoint.episodes!
      : [];
  const topLevelProposals: CheckpointProposalInput[] = Array.isArray(checkpoint?.proposals)
    ? checkpoint.proposals!
    : [];
  const hmSignalsInput: CheckpointHmSignalInput[] = Array.isArray(checkpoint?.hm_signals)
    ? checkpoint.hm_signals!
    : [];
  const removedActionKeys = new Set<string>(
    Array.isArray(checkpoint?.changes?.removed) ? checkpoint.changes!.removed! : [],
  );
  const ledgerSummary = summarizeLedger(dataDir);
  const dischargedActionKeys = new Set<string>(ledgerSummary.discharged_action_keys ?? []);
  const declinedActionKeys = new Set<string>(ledgerSummary.declined_action_keys ?? []);
  const checkpointEpisodeIds = new Set<string>(
    episodesInput
      .map(ep => (typeof ep?.episode_id === 'string' ? ep.episode_id.trim() : ''))
      .filter(Boolean),
  );

  let episodesUpserted = 0;
  let episodesPreservedInFlight = 0;
  let proposalsRegistered = 0;
  let proposalsPreserved = 0;
  let proposalsSuperseded = 0;
  let hmSignalsClaimed = 0;
  let hmSignalsPreserved = 0;

  store.withImmediateTransaction(() => {
    // Reconcile existing pending/approved rows against ledger.jsonl terminal actions & declines
    const existingApprovals = store.listApprovals();
    for (const row of existingApprovals) {
      if (row.decision !== 'pending' && row.decision !== 'approved') continue;
      const isDischarged =
        dischargedActionKeys.has(row.action_key) ||
        dischargedActionKeys.has(`${row.episode_id}/${row.action_key}`);
      if (isDischarged) {
        store.markApprovalOutcome(row.proposal_hash, 'executed', { now });
        proposalsSuperseded++;
        continue;
      }
      if (
        row.decision === 'pending' &&
        (declinedActionKeys.has(row.action_key) ||
          declinedActionKeys.has(`${row.episode_id}/${row.action_key}`))
      ) {
        store.grantApproval({
          proposal_hash: row.proposal_hash,
          decision: 'declined',
          actor: 'sam',
          now,
        });
        proposalsSuperseded++;
      }
    }

    for (const ep of episodesInput) {
      if (!ep || typeof ep.episode_id !== 'string' || !ep.episode_id.trim()) {
        continue;
      }
      const existingEp: EpisodeRow | null = store.getEpisode(ep.episode_id);
      const inFlightSteps = hasInFlightChainSteps(store, ep.episode_id);
      const hasProtectedStatus = Boolean(
        existingEp &&
          (PROTECTED_EPISODE_STATUSES.has(existingEp.status) ||
            (existingEp.status !== 'open' && existingEp.status !== 'closed')),
      );

      const inferredAppId = inFlightSteps
        ? (existingEp?.application_id ?? ep.application_id ?? null)
        : (ep.application_id ??
          existingEp?.application_id ??
          inferNumericFieldFromFacts(ep.facts, [
            /application_id[\s:=]+(\d+)/i,
            /application\s+#?(\d{5,})/i,
          ]));
      const inferredCandId = inFlightSteps
        ? (existingEp?.candidate_id ?? ep.candidate_id ?? null)
        : (ep.candidate_id ??
          existingEp?.candidate_id ??
          inferNumericFieldFromFacts(ep.facts, [
            /candidate_id[\s:=]+(\d+)/i,
            /candidate\s+#?(\d{5,})/i,
          ]));
      const inferredJobId = inFlightSteps
        ? (existingEp?.job_id ?? ep.job_id ?? null)
        : (ep.job_id ??
          existingEp?.job_id ??
          inferNumericFieldFromFacts(ep.facts, [
            /job_id[\s:=]+(\d+)/i,
            /job\s+#?(\d{5,})/i,
          ]));
      const inferredStageId = inFlightSteps
        ? (existingEp?.stage_id ?? ep.stage_id ?? null)
        : (ep.stage_id ??
          existingEp?.stage_id ??
          inferNumericFieldFromFacts(ep.facts, [
            /stage_id[\s:=]+(\d+)/i,
            /stage\s+#?(\d{5,})/i,
          ]));

      const workflow = inFlightSteps
        ? (existingEp?.workflow ?? ep.workflow ?? 'wf6_scheduling')
        : (ep.workflow ?? existingEp?.workflow ?? 'wf6_scheduling');

      // Preserve specialized or in-flight episode statuses; never reset a protected status back to generic 'open'
      let targetStatus = ep.status || 'open';
      if (existingEp) {
        if (
          inFlightSteps ||
          (hasProtectedStatus &&
            (targetStatus === 'open' || targetStatus === 'closed'))
        ) {
          targetStatus = existingEp.status;
          episodesPreservedInFlight++;
        }
      }

      const existingState =
        existingEp && typeof existingEp.state === 'object' && existingEp.state !== null
          ? (existingEp.state as Record<string, unknown>)
          : {};

      const mergedState: Record<string, unknown> = inFlightSteps
        ? {
            ...(ep.state ?? {}),
            ...existingState,
            ...(ep.candidate_name && !existingState.candidate_name
              ? { candidate_name: ep.candidate_name }
              : {}),
            ...(Array.isArray(ep.facts) ? { checkpoint_facts: ep.facts } : {}),
            ...(Array.isArray(ep.unknowns) ? { checkpoint_unknowns: ep.unknowns } : {}),
            ...(ep.resolution ? { checkpoint_resolution: ep.resolution } : {}),
            last_checkpoint_scanned_at: now,
          }
        : {
            ...existingState,
            ...(ep.state ?? {}),
            ...(ep.candidate_name ? { candidate_name: ep.candidate_name } : {}),
            ...(Array.isArray(ep.facts) ? { checkpoint_facts: ep.facts } : {}),
            ...(Array.isArray(ep.unknowns) ? { checkpoint_unknowns: ep.unknowns } : {}),
            ...(ep.resolution ? { checkpoint_resolution: ep.resolution } : {}),
            last_checkpoint_scanned_at: now,
          };

      store.upsertEpisode({
        episode_id: ep.episode_id,
        workflow,
        application_id: inferredAppId ?? null,
        candidate_id: inferredCandId ?? null,
        job_id: inferredJobId ?? null,
        stage_id: inferredStageId ?? null,
        status: targetStatus,
        state: mergedState,
        now,
      });
      episodesUpserted++;

      if (ep.status === 'closed') {
        if (targetStatus === 'closed') {
          const pendingForClosed = store
            .listApprovals({ episode_id: ep.episode_id, decision: 'pending' });
          for (const p of pendingForClosed) {
            store.markApprovalOutcome(p.proposal_hash, 'stale_aborted', {
              failureReason: 'episode_closed_in_checkpoint',
              now,
            });
            proposalsSuperseded++;
          }
        }
        continue;
      }

      const actions = Array.isArray(ep.next_actions) ? ep.next_actions : [];
      const activeActionKeys = new Set<string>();
      for (const action of actions) {
        if (action && typeof action.action_key === 'string' && action.action_key.trim()) {
          activeActionKeys.add(action.action_key);
        }
      }

      // If an open episode explicitly lists `next_actions` (and is not in a protected workflow state),
      // supersede any existing `pending` proposals on this episode whose action_key was removed from `next_actions`.
      if (Array.isArray(ep.next_actions) && !inFlightSteps && !hasProtectedStatus) {
        const existingPendingForEp = store.listApprovals({
          episode_id: ep.episode_id,
          decision: 'pending',
        });
        for (const p of existingPendingForEp) {
          if (
            !activeActionKeys.has(p.action_key) ||
            removedActionKeys.has(`${ep.episode_id}/${p.action_key}`) ||
            removedActionKeys.has(p.action_key)
          ) {
            store.markApprovalOutcome(p.proposal_hash, 'stale_aborted', {
              failureReason: 'action_removed_from_checkpoint_next_actions',
              now,
            });
            proposalsSuperseded++;
          }
        }

        // Also supersede pending approvals on alias episodes (e.g. gmail:<threadId> -> <appId>:<stage>)
        // that share the same application_id or candidate_id and are no longer in checkpoint.episodes.
        if (inferredAppId != null || inferredCandId != null) {
          const allEpisodes = store.listEpisodes();
          for (const otherEp of allEpisodes) {
            if (
              otherEp.episode_id === ep.episode_id ||
              checkpointEpisodeIds.has(otherEp.episode_id) ||
              hasInFlightChainSteps(store, otherEp.episode_id) ||
              PROTECTED_EPISODE_STATUSES.has(otherEp.status)
            ) {
              continue;
            }
            const sameApp =
              inferredAppId != null &&
              otherEp.application_id != null &&
              otherEp.application_id === inferredAppId;
            const sameCand =
              inferredCandId != null &&
              otherEp.candidate_id != null &&
              otherEp.candidate_id === inferredCandId;
            if (!sameApp && !sameCand) continue;
            const pendingOnAlias = store.listApprovals({
              episode_id: otherEp.episode_id,
              decision: 'pending',
            });
            for (const p of pendingOnAlias) {
              store.markApprovalOutcome(p.proposal_hash, 'stale_aborted', {
                failureReason: 'episode_rekeyed_in_checkpoint',
                now,
              });
              proposalsSuperseded++;
            }
          }
        }
      }

      for (const action of actions) {
        if (!action || typeof action.action_key !== 'string' || !action.action_key.trim()) {
          continue;
        }
        if (isActionDischarged(ledgerSummary, ep.episode_id, action.action_key)) {
          proposalsPreserved++;
          continue;
        }
        const sanitizedText =
          typeof action.text === 'string' ? sanitizeDraftText(action.text) : action.text;
        const sanitizedDraft =
          typeof action.draft === 'string' ? sanitizeDraftText(action.draft) : action.draft;
        const actionWorkflow = action.workflow ?? workflow;
        const draftSha =
          action.draft_sha256 !== undefined
            ? action.draft_sha256
            : typeof sanitizedDraft === 'string' && sanitizedDraft.trim().length > 0
              ? sha256(sanitizedDraft)
              : null;

        const params: Record<string, unknown> =
          action.params !== undefined
            ? action.params
            : {
                ...(sanitizedText !== undefined ? { text: sanitizedText } : {}),
                ...(sanitizedDraft !== undefined ? { draft: sanitizedDraft } : {}),
                ...(Array.isArray(action.evidence) ? { evidence: action.evidence } : {}),
                ...(inferredAppId != null ? { application_id: inferredAppId } : {}),
                ...(ep.candidate_name ? { candidate_name: ep.candidate_name } : {}),
              };

        const expectedState: Record<string, unknown> =
          action.expected_state !== undefined
            ? action.expected_state
            : {
                ...(inferredAppId != null ? { application_id: inferredAppId } : {}),
                ...(inferredStageId != null ? { stage_id: inferredStageId } : {}),
              };

        const candidateHash = computeProposalHash({
          episode_id: ep.episode_id,
          action_key: action.action_key,
          workflow: actionWorkflow,
          params,
          expected_state: expectedState,
          draft_sha256: draftSha,
        });

        const existingByHash = store.getApproval(candidateHash);
        if (existingByHash) {
          // Never overwrite or reset an existing approval's decision (pending, approved, declined, executed, stale_aborted)
          proposalsPreserved++;
          continue;
        }

        // Check if there are existing approvals for the same (episode_id, action_key)
        const existingForAction = store
          .listApprovals({ episode_id: ep.episode_id })
          .filter(a => a.action_key === action.action_key);

        // If an approval for this exact action_key was already approved or executed, preserve it and do not create a competing pending proposal
        const alreadyGrantedOrExecuted = existingForAction.find(
          a => a.decision === 'approved' || a.decision === 'executed',
        );
        if (alreadyGrantedOrExecuted) {
          proposalsPreserved++;
          continue;
        }

        // Supersede any obsolete 'pending' proposals for this same (episode_id, action_key) whose hash changed
        for (const oldPending of existingForAction) {
          if (oldPending.decision === 'pending' && oldPending.proposal_hash !== candidateHash) {
            store.markApprovalOutcome(oldPending.proposal_hash, 'stale_aborted', {
              failureReason: 'superseded_by_newer_checkpoint_proposal',
              now,
            });
            proposalsSuperseded++;
          }
        }

        store.registerProposal({
          episode_id: ep.episode_id,
          action_key: action.action_key,
          chain_id: action.chain_id ?? null,
          workflow: actionWorkflow,
          params,
          expected_state: expectedState,
          draft_sha256: draftSha,
          actor: action.actor ?? 'sam',
          now,
        });
        proposalsRegistered++;
      }
    }

    if (removedActionKeys.size > 0) {
      const allPending = store.listApprovals({ decision: 'pending' });
      for (const p of allPending) {
        if (
          removedActionKeys.has(`${p.episode_id}/${p.action_key}`) ||
          removedActionKeys.has(p.action_key)
        ) {
          store.markApprovalOutcome(p.proposal_hash, 'stale_aborted', {
            failureReason: 'action_removed_in_checkpoint_changes',
            now,
          });
          proposalsSuperseded++;
        }
      }
    }

    for (const prop of topLevelProposals) {
      if (!prop || !prop.episode_id || !prop.action_key || !prop.workflow) continue;
      if (isActionDischarged(ledgerSummary, prop.episode_id, prop.action_key)) {
        proposalsPreserved++;
        continue;
      }
      const candidateHash = computeProposalHash({
        episode_id: prop.episode_id,
        action_key: prop.action_key,
        workflow: prop.workflow,
        params: prop.params ?? {},
        expected_state: prop.expected_state ?? {},
        draft_sha256: prop.draft_sha256 ?? null,
      });

      const existingByHash = store.getApproval(candidateHash);
      if (existingByHash) {
        proposalsPreserved++;
        continue;
      }

      const existingForAction = store
        .listApprovals({ episode_id: prop.episode_id })
        .filter(a => a.action_key === prop.action_key);
      if (
        existingForAction.some(
          a => a.decision === 'approved' || a.decision === 'executed',
        )
      ) {
        proposalsPreserved++;
        continue;
      }

      for (const oldPending of existingForAction) {
        if (oldPending.decision === 'pending' && oldPending.proposal_hash !== candidateHash) {
          store.markApprovalOutcome(oldPending.proposal_hash, 'stale_aborted', {
            failureReason: 'superseded_by_newer_checkpoint_proposal',
            now,
          });
          proposalsSuperseded++;
        }
      }

      store.registerProposal({
        episode_id: prop.episode_id,
        action_key: prop.action_key,
        chain_id: prop.chain_id ?? null,
        workflow: prop.workflow,
        params: prop.params ?? {},
        expected_state: prop.expected_state ?? {},
        draft_sha256: prop.draft_sha256 ?? null,
        actor: prop.actor ?? 'sam',
        now,
      });
      proposalsRegistered++;
    }

    for (const sig of hmSignalsInput) {
      if (!sig || !sig.signal_key) continue;
      const existingSig = store.getHmSignal(sig.signal_key);
      const existingForStage = store.getActiveHmSignalForAppStage(
        sig.application_id,
        sig.stage_id,
      );
      if (
        (existingSig &&
          (existingSig.status === 'claimed' || existingSig.status === 'executed')) ||
        existingForStage
      ) {
        hmSignalsPreserved++;
        continue;
      }

      const claimed = store.claimHmSignal({
        signal_key: sig.signal_key,
        application_id: sig.application_id,
        stage_id: sig.stage_id,
        channel_id: sig.channel_id,
        message_ts: sig.message_ts,
        reactor_or_reply_id: sig.reactor_or_reply_id,
        target_stage_id: sig.target_stage_id,
        episode_id: sig.episode_id,
        details: sig.details ?? {},
        now,
      });
      if (claimed.claimed) {
        hmSignalsClaimed++;
      } else {
        hmSignalsPreserved++;
      }
    }
  });

  const written = writeOperatorApprovalSummaries(store, {
    ...options,
    dataDir,
    now,
  });

  return {
    scanned_at: now,
    episodes_upserted: episodesUpserted,
    episodes_preserved_in_flight: episodesPreservedInFlight,
    proposals_registered: proposalsRegistered,
    proposals_preserved: proposalsPreserved,
    proposals_superseded: proposalsSuperseded,
    hm_signals_claimed: hmSignalsClaimed,
    hm_signals_preserved: hmSignalsPreserved,
    pending_approvals: store.listApprovals({ decision: 'pending' }),
    approvals_md_path: written.approvals_md_path,
    drafts_md_path: written.drafts_md_path,
  };
}
