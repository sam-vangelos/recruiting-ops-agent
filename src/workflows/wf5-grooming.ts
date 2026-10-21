import crypto from 'node:crypto';
import { sha256 } from '../../worker/ledger.mjs';
import {
  type ApprovalRow,
  type EpisodeRow,
  SqliteCoordinatorStore,
} from '../store/sqlite.ts';
import {
  type ChainStepDefinition,
  DeterministicExecutor,
  type ExecuteChainResult,
  type ExpectedFreshState,
  type FreshReadSnapshot,
  SAM_GREENHOUSE_USER_ID,
} from '../executor/index.ts';
import { SAM_REFERRER_ID } from './wf1-intake.ts';
import { type JobStageMetadata, PILOT_JOB_ORDERED_STAGES } from './wf3-hm-signal.ts';

export type CrossReqMode = 'transfer' | 'fork';

export interface PrepareWorkflow5AInput {
  episode_id?: string;
  mode: CrossReqMode;
  application_id: number;
  candidate_id: number;
  candidate_name: string;
  from_job_id: number;
  from_stage_id: number;
  to_job_id: number;
  dest_stage_1_id: number;
  dest_target_stage_id: number;
  source_id?: number | null;
  resume_filename?: string | null;
  resume_base64?: string | null;
  reason?: string;
  now?: string;
}

export interface Workflow5AEpisodeState {
  mode: CrossReqMode;
  application_id: number;
  candidate_id: number;
  candidate_name: string;
  from_job_id: number;
  from_stage_id: number;
  to_job_id: number;
  dest_stage_1_id: number;
  dest_target_stage_id: number;
  source_id: number | null;
  resume_filename: string | null;
  resume_base64: string | null;
  resume_sha256: string | null;
  resume_byte_length: number | null;
  reason: string;
  chain_id: string;
  resulting_application_id: number | null;
}

function computeResumeShaAndLength(base64Content?: string | null): {
  canonicalBase64: string | null;
  sha256: string | null;
  byteLength: number | null;
} {
  if (!base64Content || !base64Content.trim()) {
    return { canonicalBase64: null, sha256: null, byteLength: null };
  }
  const clean = base64Content.replace(/\s+/g, '');
  const buf = Buffer.from(clean, 'base64');
  if (buf.byteLength === 0) {
    return { canonicalBase64: null, sha256: null, byteLength: null };
  }
  return {
    canonicalBase64: buf.toString('base64'),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    byteLength: buf.byteLength,
  };
}

/**
 * Prepares Workflow 5A (Chain E: Cross-Requisition Transfer vs Fork) episode and approval.
 */
export function prepareWorkflow5ACrossReqProposal(
  store: SqliteCoordinatorStore,
  input: PrepareWorkflow5AInput,
): {
  episode: EpisodeRow<Workflow5AEpisodeState>;
  approval: ApprovalRow;
  chain_id: string;
} {
  const now = input.now ?? new Date().toISOString();
  const episodeId =
    input.episode_id ??
    `wf5a:${input.mode}:${input.application_id}:${input.to_job_id}:${input.dest_target_stage_id}`;
  const chainId = `wf5a_chain_e:${input.mode}:${input.application_id}:${input.to_job_id}`;
  const resumeMeta = computeResumeShaAndLength(input.resume_base64);
  const reason =
    input.reason ??
    (input.mode === 'transfer'
      ? `Transferred application ${input.application_id} from job ${input.from_job_id} to job ${input.to_job_id} (stage ${input.dest_target_stage_id}).`
      : `Forked candidate ${input.candidate_id} from application ${input.application_id} (job ${input.from_job_id}) onto job ${input.to_job_id} (stage ${input.dest_target_stage_id}).`);

  const state: Workflow5AEpisodeState = {
    mode: input.mode,
    application_id: input.application_id,
    candidate_id: input.candidate_id,
    candidate_name: input.candidate_name,
    from_job_id: input.from_job_id,
    from_stage_id: input.from_stage_id,
    to_job_id: input.to_job_id,
    dest_stage_1_id: input.dest_stage_1_id,
    dest_target_stage_id: input.dest_target_stage_id,
    source_id: input.source_id ?? null,
    resume_filename: input.resume_filename ?? (resumeMeta.canonicalBase64 ? 'resume.pdf' : null),
    resume_base64: resumeMeta.canonicalBase64,
    resume_sha256: resumeMeta.sha256,
    resume_byte_length: resumeMeta.byteLength,
    reason,
    chain_id: chainId,
    resulting_application_id: input.mode === 'transfer' ? input.application_id : null,
  };

  const episode = store.upsertEpisode<Workflow5AEpisodeState>({
    episode_id: episodeId,
    workflow: 'wf5a_cross_req',
    application_id: input.application_id,
    candidate_id: input.candidate_id,
    job_id: input.from_job_id,
    stage_id: input.from_stage_id,
    status: 'PENDING_APPROVAL',
    state,
    now,
  });

  const approval = store.registerProposal({
    episode_id: episodeId,
    action_key: chainId,
    chain_id: chainId,
    workflow: 'wf5a_cross_req',
    params: {
      mode: input.mode,
      application_id: input.application_id,
      candidate_id: input.candidate_id,
      from_job_id: input.from_job_id,
      from_stage_id: input.from_stage_id,
      to_job_id: input.to_job_id,
      dest_stage_1_id: input.dest_stage_1_id,
      dest_target_stage_id: input.dest_target_stage_id,
      has_resume_copy: Boolean(state.resume_base64 && input.mode === 'fork'),
    },
    expected_state: {
      application_id: input.application_id,
      application_status: ['active', 'in_process'],
      stage_id: input.from_stage_id,
    },
    now,
  });

  store.supersedeApprovalsForEpisode(episodeId, 'Superseded by updated WF5A cross-req proposal', {
    keepProposalHash: approval.proposal_hash,
    now,
  });

  return { episode, approval, chain_id: chainId };
}

/**
 * Builds Chain E steps for Workflow 5A (`transfer` vs `fork`).
 */
export function buildWorkflow5AChainESteps(
  state: Workflow5AEpisodeState,
): ChainStepDefinition[] {
  if (state.mode === 'transfer') {
    const steps: ChainStepDefinition[] = [
      {
        step_index: 10,
        step_key: 'transfer_application_to_job',
        action_key: `wf5a_transfer:${state.application_id}:${state.to_job_id}`,
        service: 'greenhouse',
        operation: 'application_job_transfer',
        buildInput: () => ({
          application_id: state.application_id,
          to_job_id: state.to_job_id,
          to_stage_id: state.dest_stage_1_id,
          email_from_user_id: SAM_GREENHOUSE_USER_ID,
        }),
      },
    ];

    if (state.dest_target_stage_id !== state.dest_stage_1_id) {
      steps.push({
        step_index: 20,
        step_key: 'advance_transferred_application_stage',
        action_key: `wf5a_transfer_stage_move:${state.application_id}:${state.dest_target_stage_id}`,
        service: 'greenhouse',
        operation: 'application_stage_move',
        buildInput: () => ({
          application_id: state.application_id,
          to_stage_id: state.dest_target_stage_id,
          email_from_user_id: SAM_GREENHOUSE_USER_ID,
        }),
      });
    }

    steps.push({
      step_index: 30,
      step_key: 'log_transfer_audit_note',
      action_key: `wf5a_transfer_note:${state.application_id}:${state.to_job_id}`,
      service: 'greenhouse',
      operation: 'candidate_note_create',
      buildInput: () => ({
        application_id: state.application_id,
        body: `Per Sam Vangelos — assistant acted: ${state.reason}`,
        visibility: 'admin_only',
        note_type: 'NOTE',
      }),
    });

    return steps;
  }

  // Mode 2: `fork` — keep application active on both requisitions
  const steps: ChainStepDefinition[] = [
    {
      step_index: 10,
      step_key: 'fork_create_application',
      action_key: `wf5a_fork_create:${state.candidate_id}:${state.to_job_id}`,
      service: 'greenhouse',
      operation: 'application_create',
      buildInput: () => ({
        candidate_id: state.candidate_id,
        job_id: state.to_job_id,
        initial_stage_id: state.dest_target_stage_id,
        ...(state.source_id != null ? { source_id: state.source_id } : {}),
        referrer_id: SAM_REFERRER_ID,
        recruiter_id: SAM_GREENHOUSE_USER_ID,
        coordinator_id: SAM_GREENHOUSE_USER_ID,
      }),
    },
  ];

  if (state.resume_base64 && state.resume_sha256 && state.resume_byte_length) {
    steps.push({
      step_index: 20,
      step_key: 'copy_resume_to_forked_application',
      action_key: `wf5a_fork_resume:${state.candidate_id}:${state.to_job_id}`,
      service: 'greenhouse',
      operation: 'attachment_create',
      buildInput: ctx => {
        const newAppId = resolveForkedAppId(ctx, state);
        return {
          application_id: newAppId,
          filename: state.resume_filename ?? 'resume.pdf',
          type: 'resume',
          content_sha256: state.resume_sha256!,
          byte_length: state.resume_byte_length!,
        };
      },
      buildPayload: () => ({
        content: state.resume_base64!,
        content_base64: state.resume_base64!,
      }),
    });
  }

  steps.push({
    step_index: 30,
    step_key: 'log_fork_audit_note',
    action_key: `wf5a_fork_note:${state.candidate_id}:${state.to_job_id}`,
    service: 'greenhouse',
    operation: 'candidate_note_create',
    buildInput: ctx => {
      const newAppId = resolveForkedAppId(ctx, state);
      return {
        application_id: newAppId,
        body: `Per Sam Vangelos — assistant acted: ${state.reason}`,
        visibility: 'admin_only',
        note_type: 'NOTE',
      };
    },
  });

  return steps;
}

function resolveForkedAppId(
  ctx: {
    priorProviderIds: Record<string, string>;
    priorOutputs: Record<string, Record<string, unknown>>;
  },
  state: Workflow5AEpisodeState,
): number {
  const fromOut =
    (ctx.priorOutputs.fork_create_application?.result_resource_id as number | undefined) ??
    (ctx.priorOutputs.fork_create_application?.application_id as number | undefined);
  if (typeof fromOut === 'number' && Number.isFinite(fromOut) && fromOut > 0) {
    return fromOut;
  }
  const fromProv = Number(ctx.priorProviderIds.fork_create_application);
  if (Number.isFinite(fromProv) && fromProv > 0) {
    return fromProv;
  }
  if (state.resulting_application_id && state.resulting_application_id > 0) {
    return state.resulting_application_id;
  }
  throw new Error('Forked application_id not available from fork_create_application step.');
}

/**
 * Executes Workflow 5A Chain E (`transfer` vs `fork`).
 */
export async function executeWorkflow5AChainE(
  executor: DeterministicExecutor,
  input: {
    episode_id: string;
    approval?: ApprovalRow | null;
    fresh_snapshot?: FreshReadSnapshot | null | (() => Promise<FreshReadSnapshot>);
  },
): Promise<{
  result: ExecuteChainResult;
  resulting_application_id: number | null;
}> {
  const episode = executor.store.getEpisode<Workflow5AEpisodeState>(input.episode_id);
  if (!episode) {
    throw new Error(`Unknown WF5A episode '${input.episode_id}'.`);
  }
  const state = episode.state;
  const steps = buildWorkflow5AChainESteps(state);

  const transferRow = executor.store.getChainStep(state.chain_id, 'transfer_application_to_job');
  const transferDone =
    transferRow != null &&
    (transferRow.status === 'succeeded' ||
      transferRow.status === 'dispatched' ||
      transferRow.status === 'reconciled');

  const stageMoveRow = executor.store.getChainStep(
    state.chain_id,
    'advance_transferred_application_stage',
  );
  const stageMoveDone =
    stageMoveRow != null &&
    (stageMoveRow.status === 'succeeded' ||
      stageMoveRow.status === 'dispatched' ||
      stageMoveRow.status === 'reconciled');

  const expectedStageId = !transferDone
    ? state.from_stage_id
    : stageMoveDone || state.dest_target_stage_id === state.dest_stage_1_id
      ? state.dest_target_stage_id
      : state.dest_stage_1_id;

  const expectedState: ExpectedFreshState = {
    application_id: state.application_id,
    application_status: ['active', 'in_process'],
    stage_id: expectedStageId,
  };

  const result = await executor.executeChain({
    chain_id: state.chain_id,
    episode_id: episode.episode_id,
    workflow: 'wf5a_cross_req',
    approval: input.approval ?? null,
    expected_state: expectedState,
    fresh_snapshot: input.fresh_snapshot,
    steps,
  });

  let resultingAppId: number | null = state.application_id;
  if (state.mode === 'fork') {
    const forkStep = executor.store.getChainStep(state.chain_id, 'fork_create_application');
    const forkOut = (forkStep?.output ?? {}) as Record<string, any>;
    resultingAppId =
      Number(forkOut.result_resource_id) > 0
        ? Number(forkOut.result_resource_id)
        : Number(forkStep?.provider_id) > 0
          ? Number(forkStep?.provider_id)
          : null;
  }

  const transferRowAfter = executor.store.getChainStep(state.chain_id, 'transfer_application_to_job');
  const transferDoneAfter =
    transferDone ||
    (transferRowAfter != null &&
      (transferRowAfter.status === 'succeeded' ||
        transferRowAfter.status === 'dispatched' ||
        transferRowAfter.status === 'reconciled'));

  const stageMoveRowAfter = executor.store.getChainStep(
    state.chain_id,
    'advance_transferred_application_stage',
  );
  const stageMoveDoneAfter =
    stageMoveDone ||
    (stageMoveRowAfter != null &&
      (stageMoveRowAfter.status === 'succeeded' ||
        stageMoveRowAfter.status === 'dispatched' ||
        stageMoveRowAfter.status === 'reconciled'));

  const resolvedJobId =
    result.ok || transferDoneAfter || (state.mode === 'fork' && resultingAppId != null)
      ? state.to_job_id
      : state.from_job_id;

  const resolvedStageId =
    result.ok ||
    stageMoveDoneAfter ||
    (transferDoneAfter && state.dest_target_stage_id === state.dest_stage_1_id) ||
    (state.mode === 'fork' && resultingAppId != null)
      ? state.dest_target_stage_id
      : transferDoneAfter
        ? state.dest_stage_1_id
        : state.from_stage_id;

  executor.store.upsertEpisode<Workflow5AEpisodeState>({
    episode_id: episode.episode_id,
    workflow: 'wf5a_cross_req',
    application_id: resultingAppId ?? state.application_id,
    candidate_id: state.candidate_id,
    job_id: resolvedJobId,
    stage_id: resolvedStageId,
    status: result.ok ? 'COMPLETED' : `FAILED_${result.status.toUpperCase()}`,
    state: {
      ...state,
      resulting_application_id: resultingAppId,
    },
    now: executor.nowIso(),
  });

  return {
    result,
    resulting_application_id: resultingAppId,
  };
}

// ---------------------------------------------------------------------------
// Workflow 5B: Forward-Only Stage Drift Repair
// ---------------------------------------------------------------------------

export interface ApplicationInterviewSummary {
  id: number;
  stage_id: number;
  status: 'scheduled' | 'awaiting_feedback' | 'complete' | 'cancelled' | string;
  starts_at?: string;
  ends_at?: string;
}

export interface EvaluateStageDriftInput {
  application_id: number;
  candidate_id?: number | null;
  candidate_name?: string;
  job_id: number;
  current_stage_id: number;
  interviews: ApplicationInterviewSummary[];
  job_stages?: readonly JobStageMetadata[];
  now?: string;
}

export interface Workflow5BEpisodeState {
  application_id: number;
  candidate_id: number | null;
  candidate_name: string;
  job_id: number;
  from_stage_id: number;
  from_stage_name: string;
  target_stage_id: number;
  target_stage_name: string;
  triggering_interview_id: number;
  triggering_interview_status: string;
  chain_id: string;
}

/**
 * Evaluates Workflow 5B Stage Drift Repair (`ARCHITECTURE.md` §4.5):
 * - Proposes a forward stage move ONLY when a current `scheduled` or `awaiting_feedback`
 *   interview exists for a stage S_k with `rank(S_k) > rank(current_stage)`.
 * - NEVER moves an application backward (`rank(S_k) < rank(current_stage)`) or based on
 *   historical `complete` interviews.
 */
export function evaluateStageDriftRepair(
  store: SqliteCoordinatorStore,
  input: EvaluateStageDriftInput,
): {
  action: 'proposed_forward_repair' | 'noop_no_forward_active_interview';
  reason?: string;
  episode?: EpisodeRow<Workflow5BEpisodeState>;
  approval?: ApprovalRow;
} {
  const now = input.now ?? new Date().toISOString();
  const stages = [...(input.job_stages ?? PILOT_JOB_ORDERED_STAGES)].sort(
    (a, b) => a.priority - b.priority,
  );
  const rankById = new Map<number, number>();
  const stageById = new Map<number, JobStageMetadata>();
  stages.forEach((s, idx) => {
    rankById.set(s.id, s.priority ?? idx + 1);
    stageById.set(s.id, s);
  });

  const currentRank = rankById.get(input.current_stage_id);
  if (currentRank === undefined) {
    return {
      action: 'noop_no_forward_active_interview',
      reason: `Current stage ${input.current_stage_id} not found in job stage hierarchy.`,
    };
  }

  // Filter strictly to active ('scheduled' or 'awaiting_feedback') interviews in LATER stages
  const forwardActive = input.interviews
    .filter(iv => {
      if (iv.status !== 'scheduled' && iv.status !== 'awaiting_feedback') {
        return false;
      }
      const ivRank = rankById.get(iv.stage_id);
      return ivRank !== undefined && ivRank > currentRank;
    })
    .sort((a, b) => (rankById.get(b.stage_id) ?? 0) - (rankById.get(a.stage_id) ?? 0));

  if (forwardActive.length === 0) {
    return {
      action: 'noop_no_forward_active_interview',
      reason:
        'No scheduled or awaiting_feedback interview exists in a later stage (completed or earlier-stage interviews never trigger backward/drift moves).',
    };
  }

  const bestInterview = forwardActive[0];
  const fromStage = stageById.get(input.current_stage_id)!;
  const targetStage = stageById.get(bestInterview.stage_id)!;
  const episodeId = `wf5b:${input.application_id}:${input.current_stage_id}:${targetStage.id}`;
  const chainId = `wf5b_drift:${input.application_id}:${targetStage.id}`;

  const state: Workflow5BEpisodeState = {
    application_id: input.application_id,
    candidate_id: input.candidate_id ?? null,
    candidate_name: input.candidate_name ?? `Application ${input.application_id}`,
    job_id: input.job_id,
    from_stage_id: input.current_stage_id,
    from_stage_name: fromStage.name,
    target_stage_id: targetStage.id,
    target_stage_name: targetStage.name,
    triggering_interview_id: bestInterview.id,
    triggering_interview_status: bestInterview.status,
    chain_id: chainId,
  };

  const episode = store.upsertEpisode<Workflow5BEpisodeState>({
    episode_id: episodeId,
    workflow: 'wf5b_stage_drift',
    application_id: input.application_id,
    candidate_id: input.candidate_id ?? null,
    job_id: input.job_id,
    stage_id: input.current_stage_id,
    status: 'PENDING_APPROVAL',
    state,
    now,
  });

  const approval = store.registerProposal({
    episode_id: episodeId,
    action_key: chainId,
    chain_id: chainId,
    workflow: 'wf5b_stage_drift',
    params: {
      application_id: input.application_id,
      from_stage_id: input.current_stage_id,
      target_stage_id: targetStage.id,
      triggering_interview_id: bestInterview.id,
      triggering_interview_status: bestInterview.status,
    },
    expected_state: {
      application_id: input.application_id,
      application_status: ['active', 'in_process'],
      stage_id: input.current_stage_id,
    },
    now,
  });

  store.supersedeApprovalsForEpisode(episodeId, 'Superseded by updated WF5B stage drift proposal', {
    keepProposalHash: approval.proposal_hash,
    now,
  });

  return {
    action: 'proposed_forward_repair',
    episode,
    approval,
  };
}

export async function executeStageDriftRepair(
  executor: DeterministicExecutor,
  input: {
    episode_id: string;
    approval?: ApprovalRow | null;
    fresh_snapshot?: FreshReadSnapshot | null | (() => Promise<FreshReadSnapshot>);
  },
): Promise<ExecuteChainResult> {
  const episode = executor.store.getEpisode<Workflow5BEpisodeState>(input.episode_id);
  if (!episode) {
    throw new Error(`Unknown WF5B episode '${input.episode_id}'.`);
  }
  const state = episode.state;

  const moveRow = executor.store.getChainStep(state.chain_id, 'repair_stage_drift');
  const moveAlreadyDone =
    moveRow != null &&
    (moveRow.status === 'succeeded' ||
      moveRow.status === 'dispatched' ||
      moveRow.status === 'reconciled');

  const steps: ChainStepDefinition[] = [
    {
      step_index: 10,
      step_key: 'repair_stage_drift',
      action_key: `wf5b_stage_move:${state.application_id}:${state.target_stage_id}`,
      service: 'greenhouse',
      operation: 'application_stage_move',
      buildInput: () => ({
        application_id: state.application_id,
        to_stage_id: state.target_stage_id,
        email_from_user_id: SAM_GREENHOUSE_USER_ID,
      }),
    },
    {
      step_index: 20,
      step_key: 'log_stage_drift_note',
      action_key: `wf5b_drift_note:${state.application_id}:${state.target_stage_id}`,
      service: 'greenhouse',
      operation: 'candidate_note_create',
      buildInput: () => ({
        application_id: state.application_id,
        body: `Per Sam Vangelos — assistant acted: Forward stage-drift repair from ${state.from_stage_name} (${state.from_stage_id}) to ${state.target_stage_name} (${state.target_stage_id}) matching ${state.triggering_interview_status} interview ${state.triggering_interview_id}.`,
        visibility: 'admin_only',
        note_type: 'NOTE',
      }),
    },
  ];

  const result = await executor.executeChain({
    chain_id: state.chain_id,
    episode_id: episode.episode_id,
    workflow: 'wf5b_stage_drift',
    approval: input.approval ?? null,
    expected_state: {
      application_id: state.application_id,
      application_status: ['active', 'in_process'],
      stage_id: moveAlreadyDone ? state.target_stage_id : state.from_stage_id,
    },
    fresh_snapshot: input.fresh_snapshot,
    steps,
  });

  const moveRowAfter = executor.store.getChainStep(state.chain_id, 'repair_stage_drift');
  const moveDoneNow =
    moveAlreadyDone ||
    (moveRowAfter != null &&
      (moveRowAfter.status === 'succeeded' ||
        moveRowAfter.status === 'dispatched' ||
        moveRowAfter.status === 'reconciled'));

  executor.store.upsertEpisode<Workflow5BEpisodeState>({
    episode_id: episode.episode_id,
    workflow: 'wf5b_stage_drift',
    application_id: state.application_id,
    candidate_id: state.candidate_id,
    job_id: state.job_id,
    stage_id: result.ok || moveDoneNow ? state.target_stage_id : state.from_stage_id,
    status: result.ok ? 'COMPLETED' : `FAILED_${result.status.toUpperCase()}`,
    state,
    now: executor.nowIso(),
  });

  return result;
}

// ---------------------------------------------------------------------------
// Workflow 5C: Missing Recruiter / Coordinator Assignment Hygiene
// ---------------------------------------------------------------------------

export interface EvaluateMissingOwnerInput {
  application_id: number;
  candidate_id?: number | null;
  candidate_name?: string;
  job_id: number;
  current_stage_id: number;
  current_recruiter_id: number | null;
  current_coordinator_id: number | null;
  proposed_recruiter_id?: number;
  proposed_coordinator_id?: number;
  now?: string;
}

export interface Workflow5CEpisodeState {
  application_id: number;
  candidate_id: number | null;
  candidate_name: string;
  job_id: number;
  current_stage_id: number;
  assign_recruiter_id: number | null;
  assign_coordinator_id: number | null;
  chain_id: string;
}

/**
 * Evaluates Workflow 5C Missing Owner Hygiene (`ARCHITECTURE.md` §4.5):
 * Uses `application_assignment_change` (`preview_application_assignment_change` /
 * `apply_application_assignment_change`) to assign missing recruiter and/or coordinator.
 */
export function evaluateMissingOwnerHygiene(
  store: SqliteCoordinatorStore,
  input: EvaluateMissingOwnerInput,
): {
  action: 'proposed_owner_assignment' | 'noop_owners_present';
  episode?: EpisodeRow<Workflow5CEpisodeState>;
  approval?: ApprovalRow;
} {
  const now = input.now ?? new Date().toISOString();
  const assignRecruiterId =
    input.current_recruiter_id === null
      ? (input.proposed_recruiter_id ?? SAM_GREENHOUSE_USER_ID)
      : null;
  const assignCoordinatorId =
    input.current_coordinator_id === null
      ? (input.proposed_coordinator_id ?? SAM_GREENHOUSE_USER_ID)
      : null;

  if (assignRecruiterId === null && assignCoordinatorId === null) {
    return { action: 'noop_owners_present' };
  }

  const ownerSuffix = `${assignRecruiterId ?? 'none'}:${assignCoordinatorId ?? 'none'}`;
  const episodeId = `wf5c:${input.application_id}`;
  const chainId = `wf5c_owner:${input.application_id}:${ownerSuffix}`;

  const state: Workflow5CEpisodeState = {
    application_id: input.application_id,
    candidate_id: input.candidate_id ?? null,
    candidate_name: input.candidate_name ?? `Application ${input.application_id}`,
    job_id: input.job_id,
    current_stage_id: input.current_stage_id,
    assign_recruiter_id: assignRecruiterId,
    assign_coordinator_id: assignCoordinatorId,
    chain_id: chainId,
  };

  const episode = store.upsertEpisode<Workflow5CEpisodeState>({
    episode_id: episodeId,
    workflow: 'wf5c_owner_hygiene',
    application_id: input.application_id,
    candidate_id: input.candidate_id ?? null,
    job_id: input.job_id,
    stage_id: input.current_stage_id,
    status: 'PENDING_APPROVAL',
    state,
    now,
  });

  const approval = store.registerProposal({
    episode_id: episodeId,
    action_key: chainId,
    chain_id: chainId,
    workflow: 'wf5c_owner_hygiene',
    params: {
      application_id: input.application_id,
      assign_recruiter_id: assignRecruiterId,
      assign_coordinator_id: assignCoordinatorId,
    },
    expected_state: {
      application_id: input.application_id,
      application_status: ['active', 'in_process'],
    },
    now,
  });

  store.supersedeApprovalsForEpisode(episodeId, 'Superseded by updated WF5C owner hygiene proposal', {
    keepProposalHash: approval.proposal_hash,
    now,
  });

  return {
    action: 'proposed_owner_assignment',
    episode,
    approval,
  };
}

export async function executeMissingOwnerHygiene(
  executor: DeterministicExecutor,
  input: {
    episode_id: string;
    approval?: ApprovalRow | null;
    fresh_snapshot?: FreshReadSnapshot | null | (() => Promise<FreshReadSnapshot>);
  },
): Promise<ExecuteChainResult> {
  const episode = executor.store.getEpisode<Workflow5CEpisodeState>(input.episode_id);
  if (!episode) {
    throw new Error(`Unknown WF5C episode '${input.episode_id}'.`);
  }
  const state = episode.state;
  const steps: ChainStepDefinition[] = [];
  const assignedRoles: string[] = [];

  if (state.assign_recruiter_id !== null) {
    assignedRoles.push(`recruiter=${state.assign_recruiter_id}`);
    steps.push({
      step_index: 10,
      step_key: 'assign_missing_recruiter',
      action_key: `wf5c_assign_recruiter:${state.application_id}:${state.assign_recruiter_id}`,
      service: 'greenhouse',
      operation: 'application_assignment_change',
      buildInput: () => ({
        application_id: state.application_id,
        assignment_role: 'recruiter',
        proposed_user_id: state.assign_recruiter_id!,
      }),
    });
  }

  if (state.assign_coordinator_id !== null) {
    assignedRoles.push(`coordinator=${state.assign_coordinator_id}`);
    steps.push({
      step_index: 20,
      step_key: 'assign_missing_coordinator',
      action_key: `wf5c_assign_coordinator:${state.application_id}:${state.assign_coordinator_id}`,
      service: 'greenhouse',
      operation: 'application_assignment_change',
      buildInput: () => ({
        application_id: state.application_id,
        assignment_role: 'coordinator',
        proposed_user_id: state.assign_coordinator_id!,
      }),
    });
  }

  const ownerSuffix = `${state.assign_recruiter_id ?? 'none'}:${state.assign_coordinator_id ?? 'none'}`;
  steps.push({
    step_index: 30,
    step_key: 'log_owner_hygiene_note',
    action_key: `wf5c_owner_note:${state.application_id}:${ownerSuffix}`,
    service: 'greenhouse',
    operation: 'candidate_note_create',
    buildInput: () => ({
      application_id: state.application_id,
      body: `Per Sam Vangelos — assistant acted: Assigned missing application owner (${assignedRoles.join(', ')}) via application_assignment_change.`,
      visibility: 'admin_only',
      note_type: 'NOTE',
    }),
  });

  const result = await executor.executeChain({
    chain_id: state.chain_id,
    episode_id: episode.episode_id,
    workflow: 'wf5c_owner_hygiene',
    approval: input.approval ?? null,
    expected_state: {
      application_id: state.application_id,
      application_status: ['active', 'in_process'],
    },
    fresh_snapshot: input.fresh_snapshot,
    steps,
  });

  executor.store.upsertEpisode<Workflow5CEpisodeState>({
    episode_id: episode.episode_id,
    workflow: 'wf5c_owner_hygiene',
    application_id: state.application_id,
    candidate_id: state.candidate_id,
    job_id: state.job_id,
    stage_id: state.current_stage_id,
    status: result.ok ? 'COMPLETED' : `FAILED_${result.status.toUpperCase()}`,
    state,
    now: executor.nowIso(),
  });

  return result;
}
