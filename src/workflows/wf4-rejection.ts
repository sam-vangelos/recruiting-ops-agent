import {
  type DeterministicExecutor,
  type ExecuteChainResult,
  type FreshReadSnapshot,
  type LiveScorecardSummary,
  resolveScorecardStageId,
  SAM_GREENHOUSE_USER_ID,
} from '../executor/index.ts';
import {
  type ApprovalRow,
  type ConflictHoldRow,
  type SqliteCoordinatorStore,
  type TimerRow,
} from '../store/sqlite.ts';
import {
  computeDeliberationFireAt,
  computeNextBusinessDayDeliberationFireAt,
  DEFAULT_TIMEZONE,
  guardDeliberationFireTime,
  resolveTimezone,
} from '../utils/timezone.ts';

export const MASTER_POST_INTERVIEW_REJECTION_TEMPLATE_ID = 4143188004;
export const DEFAULT_REJECTION_REASON_ID = 50000123;
export const DEFAULT_WF4_REJECTION_NOTE =
  'Per Sam Vangelos — assistant acted: Rejected following negative interview scorecard.';

const POSITIVE_RATINGS = new Set(['yes', 'strong_yes']);
const NEGATIVE_RATINGS = new Set(['no', 'strong_no', 'definitely_not']);

export interface Workflow4EvaluationInput {
  episode_id: string;
  application_id: number;
  candidate_id?: number;
  job_id?: number;
  current_stage_id: number;
  candidate_tz?: string | null;
  interview_ends_at?: string | null;
  scorecards: LiveScorecardSummary[];
  stage_maps?: {
    jobInterviewToStage?: Record<number, number>;
    kitToStage?: Record<number, number>;
  };
  rejection_reason_id?: number;
  notes?: string;
  deliberation_mode?: 'ruling2_60_180' | 'next_business_day';
  random_minutes?: number;
  now?: string;
}

export type Workflow4EvaluationResult =
  | {
      outcome: 'ignored_no_current_stage_scorecards';
      ignored_historical_scorecard_ids: number[];
    }
  | {
      outcome: 'positive_only';
      positive_scorecard_ids: number[];
    }
  | {
      outcome: 'conflict_hold';
      hold: ConflictHoldRow;
    }
  | {
      outcome: 'resolved_advance';
      hold: ConflictHoldRow;
    }
  | {
      outcome: 'deliberation_timer_scheduled';
      timer: TimerRow;
      proposal: ApprovalRow;
      fire_at: string;
      candidate_tz: string;
    };

/**
 * Evaluates scorecards for an application under Workflow 4 rules (ARCHITECTURE.md §3.2 & §4.4):
 * 1. Scopes strictly to `(application_id, current_stage_id, scorecard_id)` — historical negative scorecards
 *    from earlier stages (`resolvedStageId !== current_stage_id`) are ignored.
 * 2. Holds mixed panel ratings (`yes`/`strong_yes` + `no`/`strong_no`) in `CONFLICT_HOLD` keyed to
 *    `scorecard_ids_hash` until Sam rules `'Advance'` or `'Reject'`.
 * 3. Holds single/unanimous negative scorecards locally in `state.sqlite` until `fire_at` (calculated via Ruling 2).
 */
export function evaluateWorkflow4Scorecards(
  store: SqliteCoordinatorStore,
  input: Workflow4EvaluationInput,
): Workflow4EvaluationResult {
  const now = input.now ?? new Date().toISOString();
  const candidateTz = resolveTimezone(input.candidate_tz, DEFAULT_TIMEZONE);

  const completedForApp = input.scorecards.filter(
    sc => sc.application_id === input.application_id && sc.status === 'complete',
  );

  const ignoredHistoricalIds: number[] = [];
  const currentStageScorecards: LiveScorecardSummary[] = [];

  for (const sc of completedForApp) {
    const resolvedStageId = resolveScorecardStageId(sc, input.stage_maps);
    if (resolvedStageId !== null) {
      if (resolvedStageId !== input.current_stage_id) {
        ignoredHistoricalIds.push(sc.id);
        continue;
      }
      currentStageScorecards.push(sc);
      continue;
    }
    // If stage_id was explicitly null or scorecard carries an unmapped interview_step/kit id,
    // treat as unverified stage and ignore rather than risking a false historical rejection.
    if (
      sc.stage_id === null ||
      sc.job_interview_id != null ||
      sc.interview_step?.id != null ||
      sc.interview_kit_id != null
    ) {
      ignoredHistoricalIds.push(sc.id);
      continue;
    }
    currentStageScorecards.push(sc);
  }

  const positive = currentStageScorecards.filter(sc =>
    POSITIVE_RATINGS.has(String(sc.overall_recommendation ?? '').toLowerCase()),
  );
  const negative = currentStageScorecards.filter(sc =>
    NEGATIVE_RATINGS.has(String(sc.overall_recommendation ?? '').toLowerCase()),
  );

  if (negative.length === 0) {
    if (positive.length > 0) {
      return {
        outcome: 'positive_only',
        positive_scorecard_ids: positive.map(s => s.id),
      };
    }
    return {
      outcome: 'ignored_no_current_stage_scorecards',
      ignored_historical_scorecard_ids: ignoredHistoricalIds,
    };
  }

  // Mixed panel ratings on current_stage_id -> CONFLICT_HOLD keyed to scorecard_ids_hash
  let resolvedRejectFromHold = false;
  if (positive.length > 0 && negative.length > 0) {
    const allIds = [...positive, ...negative].map(s => s.id);
    const hold = store.upsertConflictHold({
      application_id: input.application_id,
      stage_id: input.current_stage_id,
      scorecard_ids: allIds,
      details: {
        positive_scorecard_ids: positive.map(s => s.id),
        negative_scorecard_ids: negative.map(s => s.id),
      },
      now,
    });

    if (hold.status === 'CONFLICT_HOLD') {
      return { outcome: 'conflict_hold', hold };
    }
    if (hold.status === 'RESOLVED_ADVANCE') {
      return { outcome: 'resolved_advance', hold };
    }
    resolvedRejectFromHold = hold.status === 'RESOLVED_REJECT';
  }

  // Single or unanimous negative scorecard (or CONFLICT_HOLD resolved as 'Reject')
  const primaryNegative = [...negative].sort((a, b) => a.id - b.id)[negative.length - 1];
  const scorecardSubmittedAt =
    primaryNegative.submitted_at ?? primaryNegative.updated_at ?? now;

  // Default to ARCHITECTURE.md §1.1 Ruling 2 & §3.2 (`next_business_day`) unless caller
  // explicitly specifies `ruling2_60_180` or provides `random_minutes`.
  const effectiveMode =
    input.deliberation_mode ??
    (input.random_minutes !== undefined ? 'ruling2_60_180' : 'next_business_day');

  const delib =
    effectiveMode === 'next_business_day'
      ? computeNextBusinessDayDeliberationFireAt({
          interview_ended_at: input.interview_ends_at ?? scorecardSubmittedAt,
          candidate_tz: candidateTz,
          application_id: input.application_id,
        })
      : computeDeliberationFireAt({
          interview_ends_at: input.interview_ends_at,
          scorecard_submitted_at: scorecardSubmittedAt,
          candidate_tz: candidateTz,
          application_id: input.application_id,
          scorecard_id: primaryNegative.id,
          random_minutes: input.random_minutes,
        });

  const timerKey = `wf4_reject:${input.application_id}:${input.current_stage_id}:${primaryNegative.id}`;
  const actionKey = `reject_application:${input.application_id}:${input.current_stage_id}:${primaryNegative.id}`;
  const chainId = `wf4_chain:${input.application_id}:${input.current_stage_id}:${primaryNegative.id}`;
  const rejectionReasonId = input.rejection_reason_id ?? DEFAULT_REJECTION_REASON_ID;
  const notes = input.notes ?? DEFAULT_WF4_REJECTION_NOTE;

  const rejectionParams = {
    application_id: input.application_id,
    rejection_reason_id: rejectionReasonId,
    notes,
    rejection_email: {
      email_template_id: MASTER_POST_INTERVIEW_REJECTION_TEMPLATE_ID,
      email_from_user_id: SAM_GREENHOUSE_USER_ID,
    },
  };

  const expectedState = {
    application_id: input.application_id,
    application_status: 'in_process' as const,
    stage_id: input.current_stage_id,
    negative_scorecard_id: primaryNegative.id,
    require_no_positive_scorecard: true,
    require_no_hm_override: true,
    require_no_candidate_withdrawal: true,
  };

  store.upsertEpisode({
    episode_id: input.episode_id,
    workflow: 'wf4_rejection',
    application_id: input.application_id,
    candidate_id: input.candidate_id,
    job_id: input.job_id,
    stage_id: input.current_stage_id,
    status: 'deliberation_holding',
    state: {
      scorecard_id: primaryNegative.id,
      fire_at: delib.fire_at,
      candidate_tz: delib.candidate_tz,
      delay_minutes: delib.delay_minutes,
      deliberation_mode: effectiveMode,
    },
    now,
  });

  let proposal = store.registerProposal({
    episode_id: input.episode_id,
    action_key: actionKey,
    chain_id: chainId,
    workflow: 'wf4_rejection',
    params: rejectionParams,
    expected_state: expectedState,
    now,
  });

  // When Sam already ruled 'Reject' on a CONFLICT_HOLD, automatically grant approval on the proposal
  if (resolvedRejectFromHold && proposal.decision === 'pending') {
    proposal = store.grantApproval({
      proposal_hash: proposal.proposal_hash,
      decision: 'approved',
      actor: 'sam',
      now,
    });
  }

  const timer = store.scheduleTimer({
    timer_key: timerKey,
    episode_id: input.episode_id,
    kind: 'wf4_deliberated_rejection',
    fire_at: delib.fire_at,
    payload: {
      application_id: input.application_id,
      stage_id: input.current_stage_id,
      scorecard_id: primaryNegative.id,
      candidate_tz: delib.candidate_tz,
      proposal_hash: proposal.proposal_hash,
      chain_id: chainId,
      action_key: actionKey,
      rejection_params: rejectionParams,
      deliberation_mode: effectiveMode,
    },
    now,
  });

  return {
    outcome: 'deliberation_timer_scheduled',
    timer,
    proposal,
    fire_at: delib.fire_at,
    candidate_tz: delib.candidate_tz,
  };
}

/**
 * Executes a due Workflow 4 deliberated rejection timer at `fire_at`:
 * 1. Enforces the missed-window guard (never sends a rejection email at night or on a weekend in candidate_tz).
 * 2. Performs a live pre-dispatch fresh read of Greenhouse (`status === "in_process"`, stage unchanged,
 *    no newer positive scorecard), Slack, and Gmail.
 * 3. If state changed, transitions timer to `aborted_state_changed` and alerts Sam.
 * 4. Otherwise executes a SINGLE Greenhouse mutation (`preview_application_rejection` + `apply_application_rejection`
 *    with template `4143188004`, `email_from_user_id: 5085047004`, and attribution note `"Per Sam Vangelos — assistant acted: ..."`),
 *    with NO duplicate `POST /v3/notes` call after `reject`.
 */
export async function fireWorkflow4DeliberatedRejection(
  executor: DeterministicExecutor,
  params: {
    timer: TimerRow;
    fresh_snapshot: FreshReadSnapshot | null;
    approval?: ApprovalRow | null;
  },
): Promise<{
  ok: boolean;
  status:
    | 'rejected'
    | 'rolled_next_business_window'
    | 'awaiting_approval'
    | 'aborted_state_changed'
    | 'failed';
  reason?: string;
  next_fire_at?: string;
  chain_result?: ExecuteChainResult;
}> {
  const payload = params.timer.payload as Record<string, any>;
  const applicationId = Number(payload.application_id);
  const stageId = Number(payload.stage_id);
  const scorecardId = Number(payload.scorecard_id);
  const candidateTz = resolveTimezone(payload.candidate_tz, DEFAULT_TIMEZONE);
  const mode = payload.deliberation_mode ?? 'next_business_day';

  // 1. Missed-Window Guard (never fire outside business window in candidate's local timezone)
  const windowGuard = guardDeliberationFireTime({
    now_ms: executor.nowMs(),
    scheduled_fire_at_ms: Date.parse(params.timer.fire_at),
    candidate_tz: candidateTz,
    application_id: applicationId,
    window_start_hour: mode === 'next_business_day' ? 10 : 8,
    window_start_minute: mode === 'next_business_day' ? 0 : 30,
    window_end_hour: mode === 'next_business_day' ? 15 : 17,
    window_end_minute: mode === 'next_business_day' ? 0 : 30,
  });

  if (!windowGuard.can_fire_now) {
    if (windowGuard.next_fire_at && windowGuard.next_fire_at !== params.timer.fire_at) {
      executor.store.updateTimerStatus(params.timer.timer_key, 'pending', {
        fireAt: windowGuard.next_fire_at,
        reason: 'missed_business_window_rolled_forward',
        now: executor.nowIso(),
      });
    }
    return {
      ok: false,
      status: 'rolled_next_business_window',
      reason: 'Outside candidate local business hours; rolled fire_at to next business window.',
      next_fire_at: windowGuard.next_fire_at,
    };
  }

  // 2. Check Approval (Ruling 4: all candidate rejections/emails require Sam's approval)
  const proposalHash = String(payload.proposal_hash ?? '');
  const approval =
    params.approval ??
    (proposalHash ? executor.store.getApproval(proposalHash) : null);

  if (!approval || approval.decision !== 'approved') {
    return {
      ok: false,
      status: 'awaiting_approval',
      reason: `Proposal ${proposalHash} is not yet approved (current decision: ${approval?.decision ?? 'missing'}).`,
    };
  }

  const actionKey =
    String(payload.action_key ?? '') ||
    `reject_application:${applicationId}:${stageId}:${scorecardId}`;
  const chainId =
    String(payload.chain_id ?? '') ||
    `wf4_chain:${applicationId}:${stageId}:${scorecardId}`;
  // Bind rejection parameters to the approved proposal's parameters if present
  const approvedParams = (approval.params ?? payload.rejection_params ?? {}) as Record<string, any>;

  // 3. Execute single-step Chain B (with pre-dispatch <= 120s fresh-read gate)
  // Note: NO separate candidate_note_create step is included because POST /v3/applications/{id}/reject
  // natively creates the Greenhouse ACTIVITY rejection note with `notes`.
  const chainResult = await executor.executeChain({
    chain_id: chainId,
    episode_id: params.timer.episode_id,
    workflow: 'wf4_rejection',
    approval,
    expected_state: {
      application_id: applicationId,
      application_status: 'in_process',
      stage_id: stageId,
      negative_scorecard_id: scorecardId,
      require_no_positive_scorecard: true,
      require_no_hm_override: true,
      require_no_candidate_withdrawal: true,
    },
    fresh_snapshot: params.fresh_snapshot,
    steps: [
      {
        step_index: 1,
        step_key: 'reject_application_with_templated_email',
        action_key: actionKey,
        service: 'greenhouse',
        operation: 'application_rejection',
        buildInput: () => ({
          application_id: applicationId,
          rejection_reason_id:
            Number(approvedParams.rejection_reason_id) || DEFAULT_REJECTION_REASON_ID,
          notes: String(approvedParams.notes ?? DEFAULT_WF4_REJECTION_NOTE),
          rejection_email: {
            email_template_id: MASTER_POST_INTERVIEW_REJECTION_TEMPLATE_ID,
            email_from_user_id: SAM_GREENHOUSE_USER_ID,
          },
        }),
      },
    ],
  });

  if (chainResult.status === 'aborted_stale') {
    // If aborted only because fresh_snapshot was missing/stale (not a domain state change),
    // keep the timer pending so the next tick with a fresh read can execute it!
    if (chainResult.reason?.startsWith('STALE_SNAPSHOT:')) {
      return {
        ok: false,
        status: 'failed',
        reason: chainResult.reason,
        chain_result: chainResult,
      };
    }

    executor.store.updateTimerStatus(params.timer.timer_key, 'aborted_state_changed', {
      reason: chainResult.reason ?? 'Pre-dispatch fresh read detected state change.',
      now: executor.nowIso(),
    });
    executor.store.upsertEpisode({
      episode_id: params.timer.episode_id,
      workflow: 'wf4_rejection',
      application_id: applicationId,
      stage_id: stageId,
      status: 'ABORTED_STATE_CHANGED',
      state: {
        scorecard_id: scorecardId,
        abort_reason: chainResult.reason,
      },
      now: executor.nowIso(),
    });
    return {
      ok: false,
      status: 'aborted_state_changed',
      reason: chainResult.reason,
      chain_result: chainResult,
    };
  }

  if (!chainResult.ok) {
    executor.store.updateTimerStatus(params.timer.timer_key, 'failed', {
      reason: chainResult.reason ?? 'Rejection chain failed.',
      now: executor.nowIso(),
    });
    return {
      ok: false,
      status: 'failed',
      reason: chainResult.reason,
      chain_result: chainResult,
    };
  }

  executor.store.updateTimerStatus(params.timer.timer_key, 'fired', {
    now: executor.nowIso(),
  });
  executor.store.upsertEpisode({
    episode_id: params.timer.episode_id,
    workflow: 'wf4_rejection',
    application_id: applicationId,
    stage_id: stageId,
    status: 'rejected',
    state: {
      scorecard_id: scorecardId,
      rejected_at: executor.nowIso(),
    },
    now: executor.nowIso(),
  });

  return {
    ok: true,
    status: 'rejected',
    chain_result: chainResult,
  };
}
