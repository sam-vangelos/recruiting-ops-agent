import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendLedger,
  EXCEPTIONS,
  readLedger,
  sha256,
  summarizeLedger,
} from '../../worker/ledger.mjs';
import {
  type ApprovalRow,
  type ChainStepRow,
  computeProposalHash,
  SqliteCoordinatorStore,
  type TimerRow,
} from '../store/sqlite.ts';

export const MAX_FRESH_READ_AGE_MS = 120_000;
export const SAM_GREENHOUSE_USER_ID = 5085047004;
export const SAM_EMAIL = 'sam.vangelos@turing.com';

/**
 * Canonical pilot job (5149015004) mapping from `job_interview_id` (`interview_step.id`)
 * and `interview_kit_id` to `stage_id`, used when Greenhouse `/v3/scorecards` rows omit top-level `stage_id`.
 */
export const PILOT_JOB_INTERVIEW_TO_STAGE_MAP: Record<number, number> = {
  14297388004: 12579937004, // Recruiter Phone Screen
  14297389004: 12579939004, // Turing Assessment
  14297390004: 12579940004, // Manager / Tech Screen
  14297391004: 12579941004, // Panel / Cultural Fit
  14297392004: 12579942004, // Executive Review
};

export const PILOT_INTERVIEW_KIT_TO_STAGE_MAP: Record<number, number> = {
  14297348004: 12579937004, // Recruiter Phone Screen Kit
  14297349004: 12579939004, // Turing Assessment Kit
  14297350004: 12579940004, // Manager / Tech Screen Kit
  14297351004: 12579941004, // Panel / Cultural Fit Kit
};

export function resolveScorecardStageId(
  sc: LiveScorecardSummary,
  customMaps?: {
    jobInterviewToStage?: Record<number, number>;
    kitToStage?: Record<number, number>;
  },
): number | null {
  if (typeof sc.stage_id === 'number' && Number.isFinite(sc.stage_id)) {
    return sc.stage_id;
  }
  const jobInterviewId = sc.job_interview_id ?? sc.interview_step?.id;
  if (typeof jobInterviewId === 'number') {
    const mapped =
      customMaps?.jobInterviewToStage?.[jobInterviewId] ??
      PILOT_JOB_INTERVIEW_TO_STAGE_MAP[jobInterviewId];
    if (typeof mapped === 'number') return mapped;
  }
  if (typeof sc.interview_kit_id === 'number') {
    const mapped =
      customMaps?.kitToStage?.[sc.interview_kit_id] ??
      PILOT_INTERVIEW_KIT_TO_STAGE_MAP[sc.interview_kit_id];
    if (typeof mapped === 'number') return mapped;
  }
  return null;
}

export interface GreenhouseActorContext {
  actorId: string;
  greenhouseUserId?: number;
  role: 'recruiter' | 'coordinator' | 'site_admin' | 'operator';
}

export const DEFAULT_EXECUTOR_ACTOR: GreenhouseActorContext = {
  actorId: 'sam.vangelos@turing.com',
  greenhouseUserId: SAM_GREENHOUSE_USER_ID,
  role: 'site_admin',
};

export interface ActionPreviewResponse {
  status?: 'ready' | 'no_change' | string;
  changeRequired?: boolean;
  change_required?: boolean;
  intent: string | Record<string, unknown> | null;
  approval: unknown;
  summary?: string;
  provider_id?: string;
  details?: Record<string, unknown>;
  before?: Record<string, any>;
  after?: Record<string, any>;
  already_recorded?: {
    interview_id?: number;
    matches_request?: boolean;
    differences?: string[];
  };
}

export interface ActionApplyResponse {
  status?: 'applied' | 'no_change' | 'failed' | string;
  state?: 'succeeded' | 'failed' | 'unknown' | 'reconciled' | 'in_progress' | string;
  observation?: 'observed' | 'desired_observed' | 'not_observed' | 'conflict' | null;
  error_code?: string | null;
  actionId?: string;
  action_id?: string;
  provider_id?: string;
  result_resource_id?: number | null;
  result?: Record<string, unknown>;
  replayed?: boolean;
}

export interface ActionServiceLike {
  preview(
    kind: string,
    input: Record<string, unknown>,
    actor?: GreenhouseActorContext,
    client?: 'mcp' | 'cli' | 'slack' | 'ops_executor',
  ): Promise<ActionPreviewResponse>;
  apply(
    kind: string,
    request: {
      intent: unknown;
      approval: unknown;
      payload?: Record<string, unknown>;
    },
    extraPayloadOrActor?: any,
    client?: 'mcp' | 'cli' | 'slack' | 'ops_executor',
  ): Promise<ActionApplyResponse>;
}

export interface CalendarHoldEvent {
  event_id: string;
  summary?: string;
  description?: string;
  hangout_link?: string;
  html_link?: string;
  status?: string;
  start?: string;
  end?: string;
  attendees?: Array<{ email: string; responseStatus?: string }>;
}

export interface CalendarProvider {
  createSilentHold(input: {
    summary: string;
    description?: string;
    start: string;
    end: string;
    timeZone?: string;
    conferenceRequestId?: string;
  }): Promise<CalendarHoldEvent>;
  patchEvent(input: {
    event_id: string;
    summary?: string;
    description?: string;
    start?: string;
    end?: string;
    attendees?: Array<{ email: string; responseStatus?: string }>;
    sendUpdates: 'all' | 'none';
  }): Promise<CalendarHoldEvent>;
  deleteEvent(input: {
    event_id: string;
    sendUpdates?: 'all' | 'none';
  }): Promise<{ deleted: boolean }>;
  getEvent?(eventId: string): Promise<CalendarHoldEvent | null>;
  listEvents?(input: { start: string; end: string }): Promise<CalendarHoldEvent[]>;
}

export interface GmailProvider {
  sendMessage(input: {
    to: string;
    from?: string;
    cc?: string[];
    subject: string;
    htmlBody: string;
    threadId?: string;
  }): Promise<{ message_id: string; thread_id?: string }>;
}

export interface SlackProvider {
  sendMessage(input: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<{ ts: string; channel: string }>;
}

export interface LiveScorecardSummary {
  id: number;
  application_id: number;
  interview_step?: { id?: number; name?: string } | null;
  job_interview_id?: number | null;
  interview_kit_id?: number | null;
  stage_id?: number | null;
  interviewer_id?: number | null;
  submitter_id?: number | null;
  submitted_by?: { id?: number; name?: string } | null;
  interviewer?: { id?: number; name?: string } | null;
  status: 'draft' | 'complete' | 'awaiting_feedback' | string;
  overall_recommendation?: 'definitely_not' | 'no' | 'strong_no' | 'yes' | 'strong_yes' | 'mixed' | string | null;
  submitted_at?: string | null;
  updated_at?: string | null;
}

export interface FreshReadSnapshot {
  fetched_at: string;
  application?: {
    id: number;
    candidate_id?: number;
    job_id?: number;
    status: 'active' | 'in_process' | 'rejected' | 'hired' | string;
    current_stage_id: number | null;
    prospective?: boolean;
  } | null;
  scorecards?: LiveScorecardSummary[];
  interviews?: Array<{
    id: number | string;
    status?: string;
    interviewers?: Array<{ user_id?: number; id?: number; response_status?: string }>;
  }>;
  interviewer_rsvp_status?: 'needs_action' | 'accepted' | 'declined' | 'tentative' | string | null;
  gmail?: {
    thread_id?: string;
    last_message_id?: string | null;
    has_newer_candidate_reply?: boolean;
    has_unsent_sam_draft?: boolean;
    candidate_withdrew?: boolean;
  } | null;
  slack?: {
    has_hm_override?: boolean;
    override_ruling?: 'Advance' | 'Reject' | 'Hold' | null;
    reaction_removed?: boolean;
    interviewer_declined_reason?: string | null;
  } | null;
  calendar?: {
    conflicting_event_ids?: string[];
  } | null;
}

export interface ExpectedFreshState {
  application_id?: number;
  application_status?: 'active' | 'in_process' | string[];
  stage_id?: number;
  negative_scorecard_id?: number;
  gmail_last_message_id?: string;
  require_no_unsent_sam_draft?: boolean;
  require_no_hm_override?: boolean;
  require_no_reaction_removal?: boolean;
  require_no_positive_scorecard?: boolean;
  require_no_candidate_withdrawal?: boolean;
  require_scorecard_incomplete_for_user_id?: number;
  require_interviewer_rsvp_pending?: {
    interview_id: number | string;
    interviewer_user_id: number;
  };
  ignore_calendar_event_ids?: string[];
}

export interface FreshReadVerificationResult {
  ok: boolean;
  reason?: string;
  code?:
    | 'STALE_SNAPSHOT'
    | 'MISSING_APPLICATION'
    | 'APPLICATION_STATUS_CHANGED'
    | 'STAGE_CHANGED'
    | 'POSITIVE_SCORECARD_ARRIVED'
    | 'SCORECARD_ALREADY_COMPLETED'
    | 'INTERVIEWER_RSVP_ALREADY_RESOLVED'
    | 'UNSENT_SAM_DRAFT'
    | 'GMAIL_THREAD_ADVANCED'
    | 'CANDIDATE_WITHDREW'
    | 'SLACK_HM_OVERRIDE'
    | 'SLACK_REACTION_REMOVED'
    | 'CALENDAR_CONFLICT';
}

/**
 * Enforces the <= 120s Expected-State Fresh-Read Gate before any outward mutation or message.
 */
export function verifyFreshState(
  snapshot: FreshReadSnapshot | null | undefined,
  expected: ExpectedFreshState = {},
  options: { nowMs?: number; maxAgeMs?: number; activeHoldEventIds?: string[] } = {},
): FreshReadVerificationResult {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? MAX_FRESH_READ_AGE_MS;

  if (!snapshot || typeof snapshot.fetched_at !== 'string') {
    return {
      ok: false,
      code: 'STALE_SNAPSHOT',
      reason: 'Missing pre-dispatch fresh-read snapshot.',
    };
  }

  const fetchedMs = Date.parse(snapshot.fetched_at);
  if (!Number.isFinite(fetchedMs)) {
    return {
      ok: false,
      code: 'STALE_SNAPSHOT',
      reason: `Invalid fresh-read snapshot timestamp: ${snapshot.fetched_at}`,
    };
  }

  const ageMs = nowMs - fetchedMs;
  if (ageMs > maxAgeMs || ageMs < -5_000) {
    return {
      ok: false,
      code: 'STALE_SNAPSHOT',
      reason: `Pre-dispatch read snapshot age (${ageMs}ms) exceeds maximum allowed ${maxAgeMs}ms.`,
    };
  }

  if (expected.application_id !== undefined) {
    if (!snapshot.application || snapshot.application.id !== expected.application_id) {
      return {
        ok: false,
        code: 'MISSING_APPLICATION',
        reason: `Expected application ${expected.application_id} in fresh read, got ${snapshot.application?.id ?? 'null'}.`,
      };
    }
  }

  if (snapshot.application) {
    const allowedStatuses = Array.isArray(expected.application_status)
      ? expected.application_status
      : expected.application_status
        ? [expected.application_status]
        : ['active', 'in_process'];

    const expandedAllowed = new Set(allowedStatuses);
    if (expandedAllowed.has('active') || expandedAllowed.has('in_process')) {
      expandedAllowed.add('active');
      expandedAllowed.add('in_process');
    }

    if (!expandedAllowed.has(snapshot.application.status)) {
      return {
        ok: false,
        code: 'APPLICATION_STATUS_CHANGED',
        reason: `Application ${snapshot.application.id} status is '${snapshot.application.status}', expected one of [${[...expandedAllowed].join(', ')}].`,
      };
    }

    if (
      expected.stage_id !== undefined &&
      snapshot.application.current_stage_id !== expected.stage_id
    ) {
      return {
        ok: false,
        code: 'STAGE_CHANGED',
        reason: `Application ${snapshot.application.id} stage changed from ${expected.stage_id} to ${snapshot.application.current_stage_id}.`,
      };
    }
  }

  if (expected.require_no_positive_scorecard && Array.isArray(snapshot.scorecards)) {
    const positive = snapshot.scorecards.find(sc => {
      if (sc.status !== 'complete') return false;
      const isPositive =
        sc.overall_recommendation === 'yes' || sc.overall_recommendation === 'strong_yes';
      if (!isPositive) return false;

      if (expected.stage_id !== undefined) {
        const resolvedStage = resolveScorecardStageId(sc);
        if (resolvedStage !== null) {
          return resolvedStage === expected.stage_id;
        }
        // When scorecard stage_id is unknown and negative_scorecard_id is known,
        // only treat a newer scorecard (sc.id > negative_scorecard_id) as conflicting
        // so an earlier stage's positive scorecard never blocks a later stage's rejection.
        if (expected.negative_scorecard_id !== undefined) {
          return sc.id > expected.negative_scorecard_id;
        }
      }
      return true;
    });
    if (positive) {
      return {
        ok: false,
        code: 'POSITIVE_SCORECARD_ARRIVED',
        reason: `Positive scorecard ${positive.id} (${positive.overall_recommendation}) arrived; aborting rejection.`,
      };
    }
  }

  if (
    expected.require_scorecard_incomplete_for_user_id !== undefined &&
    Array.isArray(snapshot.scorecards)
  ) {
    const targetUserId = expected.require_scorecard_incomplete_for_user_id;
    const completed = snapshot.scorecards.find(sc => {
      const uid =
        sc.interviewer_id ??
        sc.interviewer?.id ??
        sc.submitter_id ??
        sc.submitted_by?.id;
      if (uid !== targetUserId || sc.status !== 'complete') return false;
      if (expected.stage_id !== undefined) {
        const scStage = resolveScorecardStageId(sc);
        if (scStage !== null && scStage !== expected.stage_id) {
          return false;
        }
      }
      return true;
    });
    if (completed) {
      return {
        ok: false,
        code: 'SCORECARD_ALREADY_COMPLETED',
        reason: `Scorecard ${completed.id} for interviewer ${targetUserId} is already complete; skipping chase.`,
      };
    }
  }

  if (expected.require_interviewer_rsvp_pending) {
    const { interview_id: targetIntId, interviewer_user_id: targetUserId } =
      expected.require_interviewer_rsvp_pending;
    if (
      snapshot.interviewer_rsvp_status === 'accepted' ||
      snapshot.interviewer_rsvp_status === 'declined'
    ) {
      return {
        ok: false,
        code: 'INTERVIEWER_RSVP_ALREADY_RESOLVED',
        reason: `Interviewer ${targetUserId} RSVP for interview ${targetIntId} is already '${snapshot.interviewer_rsvp_status}'.`,
      };
    }
    if (Array.isArray(snapshot.interviews)) {
      const interview = snapshot.interviews.find(i => String(i.id) === String(targetIntId));
      if (interview) {
        if (interview.status && interview.status !== 'scheduled') {
          return {
            ok: false,
            code: 'INTERVIEWER_RSVP_ALREADY_RESOLVED',
            reason: `Interview ${targetIntId} status is '${interview.status}', not 'scheduled'.`,
          };
        }
        const attendee = interview.interviewers?.find(
          iv => (iv.user_id ?? iv.id) === targetUserId,
        );
        if (
          attendee?.response_status === 'accepted' ||
          attendee?.response_status === 'declined'
        ) {
          return {
            ok: false,
            code: 'INTERVIEWER_RSVP_ALREADY_RESOLVED',
            reason: `Interviewer ${targetUserId} response_status is already '${attendee.response_status}'.`,
          };
        }
      }
    }
  }

  if (expected.require_no_unsent_sam_draft !== false && snapshot.gmail?.has_unsent_sam_draft) {
    return {
      ok: false,
      code: 'UNSENT_SAM_DRAFT',
      reason: 'Sam has an unsent draft on the Gmail thread; yielding to human.',
    };
  }

  if (
    expected.gmail_last_message_id !== undefined &&
    snapshot.gmail?.last_message_id &&
    snapshot.gmail.last_message_id !== expected.gmail_last_message_id
  ) {
    return {
      ok: false,
      code: 'GMAIL_THREAD_ADVANCED',
      reason: `Gmail thread last_message_id advanced from ${expected.gmail_last_message_id} to ${snapshot.gmail.last_message_id}.`,
    };
  }

  if (
    (expected.require_no_candidate_withdrawal ?? true) &&
    (snapshot.gmail?.candidate_withdrew || snapshot.gmail?.has_newer_candidate_reply)
  ) {
    return {
      ok: false,
      code: 'CANDIDATE_WITHDREW',
      reason: 'Candidate replied or withdrew since proposal creation.',
    };
  }

  if ((expected.require_no_hm_override ?? true) && snapshot.slack?.has_hm_override) {
    return {
      ok: false,
      code: 'SLACK_HM_OVERRIDE',
      reason: `Hiring Manager override detected in Slack (${snapshot.slack.override_ruling ?? 'override'}).`,
    };
  }

  if (expected.require_no_reaction_removal && snapshot.slack?.reaction_removed) {
    return {
      ok: false,
      code: 'SLACK_REACTION_REMOVED',
      reason: 'Slack reaction was removed prior to execution.',
    };
  }

  if (snapshot.calendar?.conflicting_event_ids?.length) {
    const ignored = new Set<string>([
      ...(expected.ignore_calendar_event_ids ?? []),
      ...(options.activeHoldEventIds ?? []),
    ]);
    const realConflicts = snapshot.calendar.conflicting_event_ids.filter(id => !ignored.has(id));
    if (realConflicts.length > 0) {
      return {
        ok: false,
        code: 'CALENDAR_CONFLICT',
        reason: `Calendar conflict detected on event(s): ${realConflicts.join(', ')}`,
      };
    }
  }

  return { ok: true };
}

export interface SendGateCheckInput {
  action_key: string;
  chain_id?: string | null;
  episode_id: string;
  approval?: ApprovalRow | null;
  exception?: string | null;
  outbound_body?: string | null;
  verify_hash?: boolean;
}

export interface SendGateCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * In-process send gate: requires either a valid `approved` ApprovalRow matching the action/chain,
 * or a valid autonomous exception from `EXCEPTIONS` (including Ruling 4 chase exceptions).
 */
export function verifyInProcessSendGate(input: SendGateCheckInput): SendGateCheckResult {
  if (input.exception) {
    if (!(EXCEPTIONS as readonly string[]).includes(input.exception)) {
      return {
        allowed: false,
        reason: `Unknown autonomous exception '${input.exception}'.`,
      };
    }
    return { allowed: true };
  }

  const approval = input.approval;
  if (!approval) {
    return {
      allowed: false,
      reason: `Action '${input.action_key}' has neither an approval grant nor an autonomous exception.`,
    };
  }

  if (approval.decision !== 'approved') {
    return {
      allowed: false,
      reason: `Proposal ${approval.proposal_hash} has decision '${approval.decision}', expected 'approved'.`,
    };
  }

  if (input.verify_hash) {
    const expectedHash = computeProposalHash({
      episode_id: approval.episode_id,
      action_key: approval.action_key,
      workflow: approval.workflow,
      params: approval.params,
      expected_state: approval.expected_state,
      draft_sha256: approval.draft_sha256 ?? null,
    });
    if (expectedHash !== approval.proposal_hash) {
      return {
        allowed: false,
        reason: `Approval proposal_hash '${approval.proposal_hash}' does not match recomputed hash '${expectedHash}'.`,
      };
    }
  }

  if (approval.episode_id !== input.episode_id) {
    return {
      allowed: false,
      reason: `Approval ${approval.proposal_hash} is bound to episode '${approval.episode_id}', not '${input.episode_id}'.`,
    };
  }

  const allowedKeys = Array.isArray((approval.params as any)?.allowed_action_keys)
    ? ((approval.params as any).allowed_action_keys as string[])
    : [];
  const matchesAction =
    approval.action_key === input.action_key ||
    (input.chain_id != null && approval.chain_id != null && approval.chain_id === input.chain_id) ||
    (input.chain_id != null && approval.action_key === input.chain_id) ||
    allowedKeys.includes(input.action_key);

  if (!matchesAction) {
    return {
      allowed: false,
      reason: `Approval ${approval.proposal_hash} is bound to (${approval.episode_id}, ${approval.action_key}), not (${input.episode_id}, ${input.action_key}).`,
    };
  }

  if (approval.draft_sha256 && typeof input.outbound_body === 'string') {
    const actualSha = sha256(input.outbound_body);
    if (actualSha !== approval.draft_sha256) {
      return {
        allowed: false,
        reason: `Outbound body SHA-256 (${actualSha}) does not match approved draft_sha256 (${approval.draft_sha256}).`,
      };
    }
  }

  return { allowed: true };
}

export interface ChainStepContext {
  store: SqliteCoordinatorStore;
  dataDir: string;
  chainId: string;
  episodeId: string;
  priorOutputs: Record<string, Record<string, unknown>>;
  priorProviderIds: Record<string, string>;
  nowIso: () => string;
}

export interface ChainStepExecutionResult {
  provider_id: string;
  output?: Record<string, unknown> | null;
  no_change?: boolean;
}

export interface ChainStepReconcileResult {
  reconciled: boolean;
  allowSafeRetry?: boolean;
  provider_id?: string;
  output?: Record<string, unknown> | null;
}

export interface ChainStepDefinition {
  step_index: number;
  step_key: string;
  action_key: string | ((ctx: ChainStepContext) => string);
  idempotency_key?: string | ((ctx: ChainStepContext) => string);
  service: 'greenhouse' | 'calendar' | 'gmail' | 'slack';
  operation: string;
  exception?: string | null;
  buildInput: (ctx: ChainStepContext) => Record<string, unknown>;
  buildPayload?: (ctx: ChainStepContext, input: Record<string, unknown>) => Record<string, unknown> | undefined;
  outboundBody?: (ctx: ChainStepContext, input: Record<string, unknown>) => string | null;
  execute?: (
    ctx: ChainStepContext,
    input: Record<string, unknown>,
  ) => Promise<ChainStepExecutionResult>;
  reconcile?: (
    ctx: ChainStepContext,
    stepRow: ChainStepRow,
  ) => Promise<ChainStepReconcileResult>;
  onErrorCompensate?: (ctx: ChainStepContext, error: unknown) => Promise<void>;
}

export interface ExecuteChainRequest {
  chain_id: string;
  episode_id: string;
  workflow: string;
  approval?: ApprovalRow | null;
  exception?: string | null;
  expected_state?: ExpectedFreshState;
  fresh_snapshot?: FreshReadSnapshot | null | (() => Promise<FreshReadSnapshot>);
  steps: ChainStepDefinition[];
}

export interface ExecuteChainResult {
  ok: boolean;
  chain_id: string;
  status: 'completed' | 'aborted_stale' | 'blocked_send_gate' | 'blocked_unresolved_intent' | 'failed';
  reason?: string;
  step_results: Record<string, ChainStepExecutionResult>;
  failed_step_key?: string;
}

export interface ExecutorDependencies {
  store: SqliteCoordinatorStore;
  dataDir?: string;
  actionService?: ActionServiceLike;
  calendar?: CalendarProvider;
  gmail?: GmailProvider;
  slack?: SlackProvider;
  actor?: GreenhouseActorContext;
  now?: () => Date;
  freshReadFetcher?: (episodeId: string, expected: ExpectedFreshState) => Promise<FreshReadSnapshot>;
  timerHandlers?: Record<string, (timer: TimerRow, executor: DeterministicExecutor) => Promise<void>>;
  approvalHandlers?: Record<string, (approval: ApprovalRow, executor: DeterministicExecutor) => Promise<ExecuteChainResult>>;
}

/**
 * Normalizes step input to match `greenhouse-mcp/packages/action-mcp` `.strict()` Zod preview schemas.
 */
export function normalizeGreenhousePreviewInput(
  operation: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (operation === 'scorecard_submit') {
    const out: Record<string, unknown> = {
      application_id: input.application_id,
      job_interview_id: input.job_interview_id,
      interviewer_id: input.interviewer_id ?? SAM_GREENHOUSE_USER_ID,
    };
    const rating = input.candidate_rating ?? input.overall_recommendation;
    if (input.overall_recommendation !== undefined || rating !== undefined) {
      out.overall_recommendation = input.overall_recommendation ?? rating;
    }
    if (input.candidate_rating !== undefined || rating !== undefined) {
      out.candidate_rating = input.candidate_rating ?? rating;
    }
    const privateNotes = input.private_notes !== undefined ? input.private_notes : input.notes;
    if (privateNotes !== undefined) {
      out.private_notes = privateNotes;
    }
    if (Array.isArray(input.attribute_ratings)) {
      out.attribute_ratings = input.attribute_ratings.map((attr: any) => {
        const mapped: Record<string, unknown> = {
          job_candidate_attribute_id: attr.job_candidate_attribute_id ?? attr.id,
          rating: attr.rating ?? attr.candidate_attribute_rating ?? attr.value,
        };
        if (attr.note !== undefined) mapped.note = attr.note;
        if (attr.notes !== undefined) mapped.notes = attr.notes;
        return mapped;
      });
    }
    if (Array.isArray(input.question_answers)) {
      out.question_answers = input.question_answers.map((qa: any) => {
        const mapped: Record<string, unknown> = {
          scorecard_question_id: qa.scorecard_question_id ?? qa.id,
        };
        const ans = qa.answer !== undefined ? qa.answer : qa.text;
        if (ans !== undefined) mapped.answer = ans;
        if (qa.boolean_value !== undefined) mapped.boolean_value = qa.boolean_value;
        if (qa.option_ids !== undefined) mapped.option_ids = qa.option_ids;
        return mapped;
      });
    }
    return out;
  }

  if (operation === 'application_stage_move') {
    const { from_stage_id: _ignored, ...rest } = input;
    return rest;
  }

  if (operation === 'application_job_transfer') {
    const { from_stage_id: _ignored, ...rest } = input;
    return rest;
  }

  if (operation === 'prospect_convert') {
    const { prospect_application_id, ...rest } = input;
    return {
      ...rest,
      application_id: input.application_id ?? prospect_application_id,
    };
  }

  if (operation === 'candidate_note_create') {
    const out: Record<string, unknown> = { ...input };
    if (out.note_type === 'EMAIL') {
      if (typeof out.email_from === 'string') {
        out.email_from = [out.email_from];
      }
      if (typeof out.email_to === 'string') {
        out.email_to = [out.email_to];
      }
      if (typeof out.email_cc === 'string') {
        out.email_cc = [out.email_cc];
      } else if (out.email_cc === undefined) {
        out.email_cc = [];
      }
    }
    return out;
  }

  return input;
}

/**
 * Normalizes out-of-band apply payload to match `greenhouse-mcp/packages/action-mcp` `.strict()` payload schemas.
 */
export function normalizeGreenhouseApplyPayload(
  operation: string,
  payload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  if (operation === 'attachment_create') {
    const content = payload.content ?? payload.content_base64;
    if (typeof content === 'string') {
      return { content };
    }
  }
  return payload;
}

/**
 * Dynamically loads GreenhouseActionService from `greenhouse-mcp/packages/action-mcp/dist/index.js`.
 * Supports both a full `GreenhouseActionServiceConfig` and environment-based construction
 * (`createGreenhouseActionServiceFromEnv` with an `ops_executor` session).
 */
export async function loadGreenhouseActionService(
  options: Record<string, any> = {},
): Promise<ActionServiceLike> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const distPath = path.resolve(
    here,
    '../../../greenhouse-mcp/packages/action-mcp/dist/index.js',
  );
  const mod = await import(distPath);
  if (options.greenhouse && options.store && options.session && options.signingSecret) {
    const ServiceClass = mod.GreenhouseActionService;
    return new ServiceClass(options) as ActionServiceLike;
  }
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const secret = mod.readActionSigningSecret(env);
  const sessionToken = mod.issueActionSession(
    {
      subject: options.subject ?? SAM_EMAIL,
      client: 'ops_executor',
      actorUserId: options.actorUserId ?? SAM_GREENHOUSE_USER_ID,
      identityId: options.identityId ?? '00000000-0000-4000-8000-000000005085',
    },
    secret,
  );
  const validated = mod.validateActionSession(sessionToken.token, secret);
  if (!validated.ok) {
    throw new Error(`Failed to mint ops_executor action session: ${validated.reason}`);
  }
  return mod.createGreenhouseActionServiceFromEnv(
    validated.session,
    env,
    options.runtime,
  ) as ActionServiceLike;
}

export class DeterministicExecutor {
  readonly store: SqliteCoordinatorStore;
  readonly dataDir: string;
  readonly actionService?: ActionServiceLike;
  readonly calendar?: CalendarProvider;
  readonly gmail?: GmailProvider;
  readonly slack?: SlackProvider;
  readonly actor: GreenhouseActorContext;
  readonly now: () => Date;
  readonly freshReadFetcher?: (episodeId: string, expected: ExpectedFreshState) => Promise<FreshReadSnapshot>;
  readonly timerHandlers: Record<string, (timer: TimerRow, executor: DeterministicExecutor) => Promise<void>>;
  readonly approvalHandlers: Record<string, (approval: ApprovalRow, executor: DeterministicExecutor) => Promise<ExecuteChainResult>>;
  private activeLeaseOwnerId: string | null = null;

  constructor(deps: ExecutorDependencies) {
    this.store = deps.store;
    this.dataDir = deps.dataDir ?? path.dirname(deps.store.dbPath);
    this.actionService = deps.actionService;
    this.calendar = deps.calendar;
    this.gmail = deps.gmail;
    this.slack = deps.slack;
    this.actor = deps.actor ?? DEFAULT_EXECUTOR_ACTOR;
    this.now = deps.now ?? (() => new Date());
    this.freshReadFetcher = deps.freshReadFetcher;
    this.timerHandlers = deps.timerHandlers ?? {};
    this.approvalHandlers = deps.approvalHandlers ?? {};
  }

  nowIso(): string {
    return this.now().toISOString();
  }

  nowMs(): number {
    return this.now().getTime();
  }

  /**
   * Executes a multi-step chain with single-writer lease protection, per-step idempotency,
   * crash reconciliation, <= 120s fresh-read verification, send-gate enforcement,
   * and dual SQLite + ledger.jsonl journaling.
   */
  async executeChain(req: ExecuteChainRequest): Promise<ExecuteChainResult> {
    let acquiredOwnLease = false;
    let leaseOwnerId = this.activeLeaseOwnerId;

    if (!leaseOwnerId) {
      leaseOwnerId = `exec-${crypto.randomUUID()}`;
      const lease = this.store.acquireWriterLease({
        ownerId: leaseOwnerId,
        ttlMs: 120_000,
        nowMs: this.nowMs(),
      });
      if (lease.acquired) {
        this.activeLeaseOwnerId = leaseOwnerId;
        acquiredOwnLease = true;
      } else {
        leaseOwnerId = null;
      }
    }

    try {
      return await this.executeChainInternal(req, leaseOwnerId);
    } finally {
      if (acquiredOwnLease && leaseOwnerId) {
        this.store.releaseWriterLease(leaseOwnerId);
        this.activeLeaseOwnerId = null;
      }
    }
  }

  private async executeChainInternal(
    req: ExecuteChainRequest,
    leaseOwnerId: string | null,
  ): Promise<ExecuteChainResult> {
    const existingSteps = this.store.listChainSteps(req.chain_id);
    const priorOutputs: Record<string, Record<string, unknown>> = {};
    const priorProviderIds: Record<string, string> = {};
    const stepResults: Record<string, ChainStepExecutionResult> = {};

    for (const row of existingSteps) {
      if (
        row.status === 'dispatched' ||
        row.status === 'succeeded' ||
        row.status === 'reconciled'
      ) {
        if (row.output) priorOutputs[row.step_key] = row.output;
        if (row.provider_id) priorProviderIds[row.step_key] = row.provider_id;
        stepResults[row.step_key] = {
          provider_id: row.provider_id ?? 'completed',
          output: row.output,
        };
      }
    }

    const ctx: ChainStepContext = {
      store: this.store,
      dataDir: this.dataDir,
      chainId: req.chain_id,
      episodeId: req.episode_id,
      priorOutputs,
      priorProviderIds,
      nowIso: () => this.nowIso(),
    };

    // Resolve authoritative approval from SQLite when present
    let resolvedApproval: ApprovalRow | null = req.approval ?? null;
    let verifyHash = false;
    if (req.approval) {
      const fromDb = this.store.getApproval(req.approval.proposal_hash);
      if (fromDb) {
        resolvedApproval = fromDb;
        verifyHash = true;
      }
    }

    // Collect any active silent calendar hold IDs already created by this chain so fresh-read
    // calendar conflict checks do not trip over our own silent hold on resume!
    const activeHoldEventIds: string[] = [];
    for (const row of existingSteps) {
      if (row.service === 'calendar' && row.provider_id) {
        activeHoldEventIds.push(row.provider_id);
      }
    }

    // 1. Pre-dispatch <= 120s Fresh-Read Gate
    if (
      req.expected_state !== undefined ||
      req.fresh_snapshot !== undefined ||
      this.freshReadFetcher !== undefined
    ) {
      const snapshot = typeof req.fresh_snapshot === 'function'
        ? await req.fresh_snapshot()
        : req.fresh_snapshot !== undefined
          ? req.fresh_snapshot
          : this.freshReadFetcher
            ? await this.freshReadFetcher(req.episode_id, req.expected_state ?? {})
            : null;

      const verification = verifyFreshState(snapshot, req.expected_state ?? {}, {
        nowMs: this.nowMs(),
        activeHoldEventIds,
      });

      if (!verification.ok) {
        if (resolvedApproval) {
          this.store.markApprovalOutcome(resolvedApproval.proposal_hash, 'stale_aborted', {
            failureReason: `${verification.code}: ${verification.reason}`,
            now: this.nowIso(),
          });
        }
        return {
          ok: false,
          chain_id: req.chain_id,
          status: 'aborted_stale',
          reason: `${verification.code}: ${verification.reason}`,
          step_results: stepResults,
        };
      }
    }

    // 2. Step-by-step resumable execution
    const sortedSteps = [...req.steps].sort((a, b) => a.step_index - b.step_index);
    const allStepActionKeys = sortedSteps.map(s =>
      typeof s.action_key === 'function' ? s.action_key(ctx) : s.action_key,
    );

    // If an approval was passed for this chain, verify that the approval actually belongs
    // to this chain_id or to one of the steps in this chain!
    const approvalBelongsToChain =
      resolvedApproval != null &&
      (resolvedApproval.chain_id === req.chain_id ||
        resolvedApproval.action_key === req.chain_id ||
        allStepActionKeys.includes(resolvedApproval.action_key));

    for (const stepDef of sortedSteps) {
      if (leaseOwnerId) {
        this.store.renewWriterLease(leaseOwnerId, 120_000, this.nowMs());
      }

      const existing = this.store.getChainStep(req.chain_id, stepDef.step_key);

      if (
        existing &&
        (existing.status === 'dispatched' ||
          existing.status === 'succeeded' ||
          existing.status === 'reconciled')
      ) {
        if (existing.output) priorOutputs[stepDef.step_key] = existing.output;
        if (existing.provider_id) priorProviderIds[stepDef.step_key] = existing.provider_id;
        stepResults[stepDef.step_key] = {
          provider_id: existing.provider_id ?? 'completed',
          output: existing.output,
        };
        continue;
      }

      const actionKey = typeof stepDef.action_key === 'function'
        ? stepDef.action_key(ctx)
        : stepDef.action_key;
      const input = stepDef.buildInput(ctx);
      const idempotencyKey = typeof stepDef.idempotency_key === 'function'
        ? stepDef.idempotency_key(ctx)
        : stepDef.idempotency_key ?? sha256(`${req.episode_id}:${actionKey}`);
      const stepException = stepDef.exception !== undefined ? stepDef.exception : (req.exception ?? null);
      const outboundBody = stepDef.outboundBody ? stepDef.outboundBody(ctx, input) : null;
      const draftSha = outboundBody ? sha256(outboundBody) : null;

      // Check if there is an unresolved intent in SQLite or ledger.jsonl
      const ledgerState = summarizeLedger(readLedger(this.dataDir, { tolerant: true }));
      const hasUnresolvedInLedger = (ledgerState.unresolved_action_keys ?? []).includes(actionKey);

      if ((existing && existing.status === 'intent') || hasUnresolvedInLedger) {
        if (stepDef.reconcile && existing) {
          const rec = await stepDef.reconcile(ctx, existing);
          if (rec.reconciled) {
            const provId = rec.provider_id ?? existing.provider_id ?? 'reconciled';
            const out = rec.output !== undefined ? rec.output : existing.output;
            this.store.upsertChainStep({
              chain_id: req.chain_id,
              step_index: stepDef.step_index,
              step_key: stepDef.step_key,
              episode_id: req.episode_id,
              action_key: actionKey,
              idempotency_key: idempotencyKey,
              service: stepDef.service,
              operation: stepDef.operation,
              input,
              status: 'reconciled',
              provider_id: provId,
              output: out ?? null,
              now: this.nowIso(),
            });
            appendLedger(this.dataDir, {
              kind: 'action',
              status: 'reconciled',
              service: stepDef.service,
              action_key: actionKey,
              episode_id: req.episode_id,
              idempotency_key: idempotencyKey,
              exception: stepException,
              draft_sha256: draftSha,
              provider_id: provId,
              at: this.nowIso(),
            });
            if (out) priorOutputs[stepDef.step_key] = out;
            priorProviderIds[stepDef.step_key] = provId;
            stepResults[stepDef.step_key] = { provider_id: provId, output: out };
            continue;
          }
          if (!rec.allowSafeRetry) {
            return {
              ok: false,
              chain_id: req.chain_id,
              status: 'blocked_unresolved_intent',
              reason: `Step '${stepDef.step_key}' (${actionKey}) reconciliation returned reconciled=false; blocking retry to prevent duplicate external side effect.`,
              step_results: stepResults,
              failed_step_key: stepDef.step_key,
            };
          }
        } else if (stepDef.service !== 'greenhouse') {
          return {
            ok: false,
            chain_id: req.chain_id,
            status: 'blocked_unresolved_intent',
            reason: `Step '${stepDef.step_key}' (${actionKey}) has an unresolved intent requiring reconciliation before retry.`,
            step_results: stepResults,
            failed_step_key: stepDef.step_key,
          };
        }
        // Note: For service === 'greenhouse' without custom reconcile, GreenhouseActionService.preview
        // inspects live Greenhouse state first and returns status: 'no_change' if the previous intent
        // already took effect at Greenhouse!
      }

      // 3. Enforce in-process send gate without overwriting approval.action_key!
      // Co-steps within an approved multi-step chain (where `approvalBelongsToChain` is true)
      // are authorized by the chain's approval; an approval from a DIFFERENT chain/action is rejected.
      const stepApproval = resolvedApproval
        ? approvalBelongsToChain
          ? {
              ...resolvedApproval,
              chain_id: req.chain_id,
            }
          : resolvedApproval
        : null;

      const gateResult = verifyInProcessSendGate({
        action_key: actionKey,
        chain_id: req.chain_id,
        episode_id: req.episode_id,
        approval: stepApproval,
        exception: stepException,
        outbound_body: outboundBody,
        verify_hash: verifyHash,
      });

      if (!gateResult.allowed) {
        return {
          ok: false,
          chain_id: req.chain_id,
          status: 'blocked_send_gate',
          reason: gateResult.reason,
          step_results: stepResults,
          failed_step_key: stepDef.step_key,
        };
      }

      // 4. Persist status: 'intent' to both SQLite and ledger.jsonl BEFORE calling provider
      const attempt = existing ? existing.attempt + (existing.status === 'failed' ? 1 : 0) : 1;
      this.store.upsertChainStep({
        chain_id: req.chain_id,
        step_index: stepDef.step_index,
        step_key: stepDef.step_key,
        episode_id: req.episode_id,
        action_key: actionKey,
        idempotency_key: idempotencyKey,
        service: stepDef.service,
        operation: stepDef.operation,
        input,
        status: 'intent',
        attempt,
        error_text: null,
        now: this.nowIso(),
      });

      appendLedger(this.dataDir, {
        kind: 'action',
        status: 'intent',
        service: stepDef.service,
        action_key: actionKey,
        episode_id: req.episode_id,
        idempotency_key: idempotencyKey,
        exception: stepException,
        draft_sha256: draftSha,
        at: this.nowIso(),
      });

      // 5. Execute provider call
      try {
        const payload = stepDef.buildPayload ? stepDef.buildPayload(ctx, input) : undefined;
        const execResult = stepDef.execute
          ? await stepDef.execute(ctx, input)
          : await this.executeGreenhouseStep(stepDef.operation, input, payload);

        const providerId = execResult.provider_id || 'completed';
        const output = execResult.output ?? null;

        this.store.upsertChainStep({
          chain_id: req.chain_id,
          step_index: stepDef.step_index,
          step_key: stepDef.step_key,
          episode_id: req.episode_id,
          action_key: actionKey,
          idempotency_key: idempotencyKey,
          service: stepDef.service,
          operation: stepDef.operation,
          input,
          status: 'succeeded',
          provider_id: providerId,
          output,
          error_text: null,
          attempt,
          now: this.nowIso(),
        });

        appendLedger(this.dataDir, {
          kind: 'action',
          status: 'dispatched',
          service: stepDef.service,
          action_key: actionKey,
          episode_id: req.episode_id,
          idempotency_key: idempotencyKey,
          exception: stepException,
          draft_sha256: draftSha,
          provider_id: providerId,
          at: this.nowIso(),
        });

        if (output) priorOutputs[stepDef.step_key] = output;
        priorProviderIds[stepDef.step_key] = providerId;
        stepResults[stepDef.step_key] = {
          provider_id: providerId,
          output,
          no_change: execResult.no_change,
        };
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.store.upsertChainStep({
          chain_id: req.chain_id,
          step_index: stepDef.step_index,
          step_key: stepDef.step_key,
          episode_id: req.episode_id,
          action_key: actionKey,
          idempotency_key: idempotencyKey,
          service: stepDef.service,
          operation: stepDef.operation,
          input,
          status: 'failed',
          error_text: errorMessage,
          attempt,
          now: this.nowIso(),
        });

        appendLedger(this.dataDir, {
          kind: 'action',
          status: 'failed',
          service: stepDef.service,
          action_key: actionKey,
          episode_id: req.episode_id,
          idempotency_key: idempotencyKey,
          exception: stepException,
          draft_sha256: draftSha,
          error: errorMessage,
          at: this.nowIso(),
        });

        if (stepDef.onErrorCompensate) {
          try {
            await stepDef.onErrorCompensate(ctx, err);
          } catch {
            // Compensation errors do not mask original error
          }
        }

        return {
          ok: false,
          chain_id: req.chain_id,
          status: 'failed',
          reason: errorMessage,
          step_results: stepResults,
          failed_step_key: stepDef.step_key,
        };
      }
    }

    if (resolvedApproval) {
      this.store.markApprovalOutcome(resolvedApproval.proposal_hash, 'executed', {
        now: this.nowIso(),
      });
    }

    return {
      ok: true,
      chain_id: req.chain_id,
      status: 'completed',
      step_results: stepResults,
    };
  }

  /**
   * Executes a Greenhouse mutation in-process via `GreenhouseActionService.preview` + `apply`
   * using client identity `'ops_executor'`. Handles `no_change`, `already_recorded` verification,
   * `result_resource_id` extraction, and resumable `PARTIAL_APPLIED` re-preview/apply loops.
   */
  async executeGreenhouseStep(
    operation: string,
    input: Record<string, unknown>,
    payload?: Record<string, unknown>,
  ): Promise<ChainStepExecutionResult> {
    if (!this.actionService) {
      throw new Error(`No GreenhouseActionService configured for operation '${operation}'.`);
    }

    const previewInput = normalizeGreenhousePreviewInput(operation, input);
    const normalizedPayload = normalizeGreenhouseApplyPayload(operation, payload);

    let lastErr: unknown;
    for (let resumeAttempt = 0; resumeAttempt < 3; resumeAttempt++) {
      try {
        const previewRes = await this.actionService.preview(
          operation,
          previewInput,
          this.actor,
          'ops_executor',
        );

        const isNoChange =
          previewRes.status === 'no_change' ||
          previewRes.changeRequired === false ||
          previewRes.change_required === false;

        if (isNoChange) {
          if (
            previewRes.already_recorded &&
            previewRes.already_recorded.matches_request === false
          ) {
            const diffText = previewRes.already_recorded.differences?.join(', ') ?? 'parameter mismatch';
            const mismatchErr = new Error(
              `Greenhouse interview_create already_recorded mismatch (${diffText}).`,
            ) as Error & { code?: string };
            mismatchErr.code = 'INTERVIEW_ALREADY_RECORDED';
            throw mismatchErr;
          }

          const existingPermId =
            previewRes.details?.existing_permission_id ??
            previewRes.before?.existing_permission_ids?.[0] ??
            (previewRes.approval as any)?.before?.existing_permission_ids?.[0];
          const existingInterviewId =
            previewRes.already_recorded?.interview_id ??
            previewRes.before?.already_recorded_interview_id;
          const existingCandidateId =
            previewRes.details?.existing_candidate_id ??
            previewRes.before?.candidate_id;
          const existingApplicationId =
            previewRes.details?.existing_application_id ??
            previewRes.before?.application_id;
          const existingAttachmentId =
            previewRes.details?.existing_attachment_id ??
            previewRes.before?.attachment_id;

          const noChangeId =
            previewRes.provider_id ??
            (existingInterviewId !== undefined && existingInterviewId !== null
              ? String(existingInterviewId)
              : undefined) ??
            (existingCandidateId !== undefined && existingCandidateId !== null
              ? String(existingCandidateId)
              : undefined) ??
            (existingApplicationId !== undefined && existingApplicationId !== null
              ? String(existingApplicationId)
              : undefined) ??
            (existingAttachmentId !== undefined && existingAttachmentId !== null
              ? String(existingAttachmentId)
              : undefined) ??
            (existingPermId !== undefined && existingPermId !== null
              ? String(existingPermId)
              : undefined) ??
            'no_change';

          return {
            provider_id: noChangeId,
            output: {
              status: 'no_change',
              ...(previewRes.details ?? {}),
              ...(previewRes.already_recorded ? { already_recorded: previewRes.already_recorded } : {}),
            },
            no_change: true,
          };
        }

        const applyReq: {
          intent: unknown;
          approval: unknown;
          payload?: Record<string, unknown>;
        } = {
          intent: previewRes.intent,
          approval: previewRes.approval,
          ...(normalizedPayload !== undefined ? { payload: normalizedPayload } : {}),
        };

        // Real GreenhouseActionService.apply has signature (kind, input, extraPayload?) (length <= 3).
        // 4-arg test mocks accept (kind, req, actor, client).
        const applyRes =
          this.actionService.apply.length >= 4
            ? await this.actionService.apply(
                operation,
                applyReq,
                this.actor,
                'ops_executor',
              )
            : await this.actionService.apply(
                operation,
                applyReq,
                normalizedPayload,
              );

        if (applyRes.error_code === 'PARTIAL_APPLIED' && resumeAttempt < 2) {
          continue;
        }

        if (
          (applyRes.state &&
            applyRes.state !== 'succeeded' &&
            applyRes.state !== 'reconciled') ||
          applyRes.status === 'failed'
        ) {
          const code = applyRes.error_code ?? applyRes.state ?? 'GREENHOUSE_APPLY_FAILED';
          const applyErr = new Error(
            `Greenhouse apply '${operation}' failed with state='${applyRes.state ?? applyRes.status}' code='${code}'.`,
          ) as Error & { code?: string };
          applyErr.code = String(code);
          throw applyErr;
        }

        const resultObj = (applyRes.result ?? {}) as Record<string, unknown>;
        const providerId =
          (applyRes.result_resource_id !== undefined && applyRes.result_resource_id !== null
            ? String(applyRes.result_resource_id)
            : undefined) ??
          applyRes.provider_id ??
          (resultObj.id !== undefined ? String(resultObj.id) : undefined) ??
          (resultObj.candidate_id !== undefined ? String(resultObj.candidate_id) : undefined) ??
          (resultObj.application_id !== undefined ? String(resultObj.application_id) : undefined) ??
          (resultObj.attachment_id !== undefined ? String(resultObj.attachment_id) : undefined) ??
          (resultObj.scorecard_id !== undefined ? String(resultObj.scorecard_id) : undefined) ??
          (resultObj.interview_id !== undefined ? String(resultObj.interview_id) : undefined) ??
          (resultObj.note_id !== undefined ? String(resultObj.note_id) : undefined) ??
          (resultObj.permission_id !== undefined ? String(resultObj.permission_id) : undefined) ??
          applyRes.action_id ??
          applyRes.actionId ??
          'applied';

        return {
          provider_id: providerId,
          output: {
            ...resultObj,
            ...(applyRes.result_resource_id != null
              ? { result_resource_id: applyRes.result_resource_id }
              : {}),
            ...(applyRes.action_id ? { action_id: applyRes.action_id } : {}),
          },
          no_change: applyRes.status === 'no_change' || applyRes.state === 'reconciled',
        };
      } catch (err: any) {
        lastErr = err;
        // If candidate_create detects a visible existing candidate by email/LinkedIn in Greenhouse
        // ("CANDIDATE_ALREADY_EXISTS ... (candidate_id=12345)"), reconcile idempotently to that candidate_id.
        if (operation === 'candidate_create' && err?.code === 'CANDIDATE_ALREADY_EXISTS') {
          const match = String(err?.message ?? '').match(/candidate_id=(\d+)/);
          if (match) {
            const existingCandId = Number(match[1]);
            return {
              provider_id: String(existingCandId),
              output: {
                status: 'no_change',
                existing_candidate_id: existingCandId,
                result_resource_id: existingCandId,
              },
              no_change: true,
            };
          }
        }
        if (operation === 'application_create' && err?.code === 'APPLICATION_ALREADY_EXISTS') {
          const match =
            String(err?.message ?? '').match(/application_id=(\d+)/i) ??
            String(err?.message ?? '').match(/\((\d+)\)/);
          if (match) {
            const existingAppId = Number(match[1]);
            return {
              provider_id: String(existingAppId),
              output: {
                status: 'no_change',
                existing_application_id: existingAppId,
                result_resource_id: existingAppId,
              },
              no_change: true,
            };
          }
        }
        if (operation === 'scorecard_submit' && err?.code === 'SCORECARD_ALREADY_COMPLETE') {
          const match =
            String(err?.message ?? '').match(/scorecard_id=(\d+)/i) ??
            String(err?.message ?? '').match(/scorecard\s+(\d+)/i);
          const existingScorecardId = match ? Number(match[1]) : null;
          return {
            provider_id:
              existingScorecardId !== null ? String(existingScorecardId) : 'scorecard_complete',
            output: {
              status: 'no_change',
              ...(existingScorecardId !== null
                ? {
                    existing_scorecard_id: existingScorecardId,
                    result_resource_id: existingScorecardId,
                  }
                : {}),
            },
            no_change: true,
          };
        }
        if (err?.code === 'PARTIAL_APPLIED' && resumeAttempt < 2) {
          continue;
        }
        throw err;
      }
    }

    throw lastErr;
  }

  /**
   * Runs one deterministic 60-second tick:
   * 1. Acquires single-writer lease on `state.sqlite`
   * 2. Processes ready approvals (`decision = 'approved'`), skipping timer-held WF4 approvals unless explicitly bound
   * 3. Processes due timers (`status = 'pending' AND fire_at <= now`)
   * 4. Renews writer lease across steps and releases writer lease on completion
   */
  async runTick(options: { ownerId?: string; ttlMs?: number } = {}): Promise<{
    acquired: boolean;
    ownerId: string;
    approvalsProcessed: number;
    timersProcessed: number;
    errors: string[];
  }> {
    const ownerId = options.ownerId ?? crypto.randomUUID();
    const ttlMs = options.ttlMs ?? 120_000;
    const lease = this.store.acquireWriterLease({
      ownerId,
      ttlMs,
      nowMs: this.nowMs(),
    });

    if (!lease.acquired) {
      return {
        acquired: false,
        ownerId,
        approvalsProcessed: 0,
        timersProcessed: 0,
        errors: [],
      };
    }

    this.activeLeaseOwnerId = ownerId;
    let approvalsProcessed = 0;
    let timersProcessed = 0;
    const errors: string[] = [];

    try {
      const approvals = this.store.listReadyApprovals();
      for (const approval of approvals) {
        this.store.renewWriterLease(ownerId, ttlMs, this.nowMs());
        // WF4 deliberated rejections are gated by their local deliberation timer at `fire_at`
        if (
          approval.workflow === 'wf4_rejection' &&
          !this.approvalHandlers['wf4_rejection'] &&
          !this.approvalHandlers[approval.action_key]
        ) {
          continue;
        }
        const handler =
          this.approvalHandlers[approval.workflow] ??
          this.approvalHandlers[approval.action_key] ??
          this.approvalHandlers['*'];
        if (!handler) continue;
        try {
          const res = await handler(approval, this);
          approvalsProcessed++;
          if (res && res.ok === false) {
            errors.push(
              `Approval ${approval.proposal_hash}: ${res.reason ?? res.status}`,
            );
          }
        } catch (err: any) {
          errors.push(`Approval ${approval.proposal_hash}: ${err?.message ?? String(err)}`);
        }
      }

      const dueTimers = this.store.listDueTimers(this.nowIso());
      for (const timer of dueTimers) {
        this.store.renewWriterLease(ownerId, ttlMs, this.nowMs());
        const handler = this.timerHandlers[timer.kind] ?? this.timerHandlers['*'];
        if (!handler) continue;
        try {
          await handler(timer, this);
          timersProcessed++;
        } catch (err: any) {
          errors.push(`Timer ${timer.timer_key}: ${err?.message ?? String(err)}`);
        }
      }
    } finally {
      this.activeLeaseOwnerId = null;
      this.store.releaseWriterLease(ownerId);
    }

    return {
      acquired: true,
      ownerId,
      approvalsProcessed,
      timersProcessed,
      errors,
    };
  }
}

export { computeProposalHash };
