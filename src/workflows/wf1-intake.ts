import crypto from 'node:crypto';
import { appendLedger, sha256 } from '../../worker/ledger.mjs';
import {
  type ApprovalRow,
  canonicalize,
  type EpisodeRow,
  SqliteCoordinatorStore,
  type TimerRow,
} from '../store/sqlite.ts';
import {
  type ChainStepDefinition,
  DeterministicExecutor,
  type ExecuteChainResult,
  type ExpectedFreshState,
  type FreshReadSnapshot,
  SAM_GREENHOUSE_USER_ID,
} from '../executor/index.ts';
import {
  executeWorkflow2ChainD,
  HIRING_MANAGER_REVIEW_STAGE_ID,
  PILOT_JOB_ID,
  prepareWorkflow2ScorecardProposal,
  RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID,
  RECRUITER_PHONE_SCREEN_KIT_ID,
  RECRUITER_PHONE_SCREEN_STAGE_ID,
  SAM_SLACK_USER_ID,
  type SystemsAdminScorecardDraft,
  validateSystemsAdminScorecardDraft,
} from './wf2-scorecard.ts';

export const SAM_REFERRER_ID = 4838328004;
export const APPLICATION_REVIEW_STAGE_ID = 12579936004;
export const URGENT_JOB_MAPPING_REMINDER_LEAD_MS = 2 * 60 * 60_000; // starts_at - 2 hours

export type BookingSignalSource = 'calendly' | 'gmail' | 'calendar';

export interface BookingSignalInput {
  source: BookingSignalSource;
  invitee_uri?: string | null;
  old_invitee_uri?: string | null;
  ical_uid?: string | null;
  calendar_event_id?: string | null;
  gmail_message_id?: string | null;
  candidate_email: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  candidate_name?: string;
  phone?: string | null;
  linkedin_url?: string | null;
  tags?: string[];
  starts_at: string;
  ends_at: string;
  status?: 'active' | 'scheduled' | 'canceled' | 'cancelled' | 'rescheduled';
  booking_status?: 'active' | 'scheduled' | 'canceled' | 'cancelled' | 'rescheduled';
  job_id?: number | null;
  initial_stage_id?: number | null;
  job_interview_id?: number | null;
  source_id?: number | null;
  existing_candidate_id?: number | null;
  existing_application_id?: number | null;
  existing_application_stage_id?: number | null;
  existing_application_prospective?: boolean;
  prospect_application_id?: number | null;
  existing_has_resume?: boolean;
  resume_filename?: string | null;
  resume_base64?: string | null;
  video_conferencing_url?: string | null;
  location?: string | null;
  now?: string;
}

export type IntakeApplicationMode = 'create' | 'prospect_convert' | 'advance_existing';

export interface PendingWf2DraftPayload {
  draft: SystemsAdminScorecardDraft;
  interview_ended_at: string;
  captured_at: string;
}

export interface IntakeEpisodeState {
  primary_key: string;
  invitee_uri: string | null;
  ical_uid: string | null;
  calendar_event_id: string | null;
  gmail_message_id: string | null;
  booking_fingerprint: string;
  prior_booking_fingerprints: string[];
  signals_received: BookingSignalSource[];
  candidate_email: string;
  first_name: string;
  last_name: string;
  candidate_name: string;
  phone: string | null;
  linkedin_url: string | null;
  tags: string[];
  starts_at: string;
  ends_at: string;
  booking_status: 'active' | 'canceled';
  reschedule_count: number;
  job_id: number | null;
  initial_stage_id: number;
  job_interview_id: number;
  source_id: number | null;
  referrer_id: number;
  recruiter_id: number;
  coordinator_id: number;
  existing_candidate_id: number | null;
  existing_application_id: number | null;
  existing_application_stage_id: number | null;
  prospect_application_id: number | null;
  existing_has_resume: boolean;
  resume_filename: string | null;
  resume_base64: string | null;
  resume_sha256: string | null;
  resume_byte_length: number | null;
  video_conferencing_url: string | null;
  location: string | null;
  high_priority_question: string | null;
  urgent_reminder_timer_key: string | null;
  pending_wf2_draft: PendingWf2DraftPayload | null;
  unlocked_wf2_episode_id: string | null;
  chain_id: string | null;
  resolved_candidate_id: number | null;
  resolved_application_id: number | null;
  resolved_interview_id: number | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Rounds an ISO-8601 timestamp to the nearest 5-minute bucket in UTC (seconds/ms zeroed).
 */
export function roundTo5MinIso(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid timestamp for booking_fingerprint: ${isoTimestamp}`);
  }
  const bucketMs = 5 * 60_000;
  const rounded = Math.round(ms / bucketMs) * bucketMs;
  return new Date(rounded).toISOString();
}

/**
 * Computes `booking_fingerprint = sha256(normalize_email(email) + "|" + round_to_5min(starts_at))`
 * used to correlate Calendly API, Gmail confirmation, and Google Calendar signals into one episode.
 */
export function computeBookingFingerprint(email: string, startsAt: string): string {
  const preimage = `${normalizeEmail(email)}|${roundTo5MinIso(startsAt)}`;
  return crypto.createHash('sha256').update(preimage, 'utf8').digest('hex');
}

function splitCandidateName(input: {
  first_name?: string;
  last_name?: string;
  full_name?: string;
  candidate_email: string;
}): { first_name: string; last_name: string; candidate_name: string } {
  if (input.first_name?.trim() && input.last_name?.trim()) {
    const first = input.first_name.trim();
    const last = input.last_name.trim();
    return { first_name: first, last_name: last, candidate_name: `${first} ${last}` };
  }
  if (input.full_name?.trim()) {
    const parts = input.full_name.trim().split(/\s+/);
    const first = parts[0] ?? 'Candidate';
    const last = parts.slice(1).join(' ') || 'Unknown';
    return { first_name: first, last_name: last, candidate_name: `${first} ${last}` };
  }
  const localPart = normalizeEmail(input.candidate_email).split('@')[0] ?? 'candidate';
  const segments = localPart.split(/[._-]+/).filter(Boolean);
  const first = segments[0]
    ? segments[0].charAt(0).toUpperCase() + segments[0].slice(1)
    : 'Candidate';
  const last = segments[1]
    ? segments[1].charAt(0).toUpperCase() + segments[1].slice(1)
    : 'Applicant';
  return { first_name: first, last_name: last, candidate_name: `${first} ${last}` };
}

function computeResumeMetadata(base64Content?: string | null): {
  canonicalBase64: string | null;
  sha256: string | null;
  byteLength: number | null;
} {
  if (!base64Content || !base64Content.trim()) {
    return { canonicalBase64: null, sha256: null, byteLength: null };
  }
  const normalized = base64Content.replace(/\s+/g, '');
  const buf = Buffer.from(normalized, 'base64');
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    canonicalBase64: buf.toString('base64'),
    sha256: digest,
    byteLength: buf.byteLength,
  };
}

/**
 * Finds an existing WF1 `IntakeEpisode` by:
 * 1. `invitee_uri` (or `old_invitee_uri` on reschedule)
 * 2. `ical_uid` or `calendar_event_id`
 * 3. `booking_fingerprint` (or `prior_booking_fingerprints`)
 */
export function findMatchingIntakeEpisode(
  store: SqliteCoordinatorStore,
  signal: BookingSignalInput,
  fingerprint: string,
): EpisodeRow<IntakeEpisodeState> | null {
  const episodes = store.listEpisodes<IntakeEpisodeState>({ workflow: 'wf1_intake' });

  // 1. Exact invitee_uri or old_invitee_uri match
  if (signal.invitee_uri || signal.old_invitee_uri) {
    const byInvitee = episodes.find(ep => {
      const u = ep.state.invitee_uri;
      if (!u) return false;
      return u === signal.invitee_uri || u === signal.old_invitee_uri;
    });
    if (byInvitee) return byInvitee;
  }

  // 2. Exact iCalUID or Google Calendar event_id match
  if (signal.ical_uid || signal.calendar_event_id) {
    const byCal = episodes.find(ep => {
      if (signal.ical_uid && ep.state.ical_uid === signal.ical_uid) return true;
      if (signal.calendar_event_id && ep.state.calendar_event_id === signal.calendar_event_id) {
        return true;
      }
      return false;
    });
    if (byCal) return byCal;
  }

  // 3. Correlate by booking_fingerprint
  const byFingerprint = episodes.find(
    ep =>
      ep.state.booking_fingerprint === fingerprint ||
      (Array.isArray(ep.state.prior_booking_fingerprints) &&
        ep.state.prior_booking_fingerprints.includes(fingerprint)),
  );
  if (byFingerprint) return byFingerprint;

  return null;
}

/**
 * Ingests a booking signal (Calendly API, Gmail confirmation, or Google Calendar event):
 * - Correlates the 3 signals into a single `IntakeEpisode` via `invitee_uri`, `iCalUID`/`event_id`,
 *   or `booking_fingerprint = sha256(normalize_email(email) + "|" + round_to_5min(starts_at))`.
 * - Updates the existing `IntakeEpisode` in place on reschedule or cancellation rather than
 *   spawning a second episode.
 * - Enforces Ruling 1 (`AWAITING_JOB_MAPPING`) when `job_id` cannot be deterministically resolved,
 *   scheduling an urgent Slack DM reminder at `starts_at - 2 hours`.
 */
export function ingestBookingSignal(
  store: SqliteCoordinatorStore,
  signal: BookingSignalInput,
): {
  episode: EpisodeRow<IntakeEpisodeState>;
  correlated_existing: boolean;
  was_rescheduled: boolean;
  was_cancelled: boolean;
  urgent_timer?: TimerRow | null;
  approval?: ApprovalRow | null;
} {
  const now = signal.now ?? new Date().toISOString();
  const fingerprint = computeBookingFingerprint(signal.candidate_email, signal.starts_at);
  const existing = findMatchingIntakeEpisode(store, signal, fingerprint);

  const names = splitCandidateName(signal);
  const rawStatus = signal.status ?? signal.booking_status;
  const isCancelled =
    rawStatus === 'canceled' || rawStatus === 'cancelled';

  const prevStartsAt = existing?.state.starts_at;
  const wasRescheduled = Boolean(
    existing &&
      !isCancelled &&
      ((prevStartsAt && roundTo5MinIso(prevStartsAt) !== roundTo5MinIso(signal.starts_at)) ||
        rawStatus === 'rescheduled' ||
        (signal.old_invitee_uri && signal.invitee_uri && signal.old_invitee_uri !== signal.invitee_uri)),
  );

  const primaryKey =
    existing?.state.primary_key ??
    signal.invitee_uri ??
    signal.ical_uid ??
    signal.calendar_event_id ??
    fingerprint;

  const episodeId = existing?.episode_id ?? `wf1:${sha256(primaryKey).slice(0, 16)}`;

  const signalsReceived = new Set<BookingSignalSource>(existing?.state.signals_received ?? []);
  signalsReceived.add(signal.source);

  const priorFingerprints = new Set<string>(existing?.state.prior_booking_fingerprints ?? []);
  if (existing && existing.state.booking_fingerprint !== fingerprint) {
    priorFingerprints.add(existing.state.booking_fingerprint);
  }

  const resumeBase64 = signal.resume_base64 ?? existing?.state.resume_base64 ?? null;
  const resumeFilename =
    signal.resume_filename ??
    existing?.state.resume_filename ??
    (resumeBase64 ? 'resume.pdf' : null);
  const resumeMeta = computeResumeMetadata(resumeBase64);

  const resolvedJobId =
    signal.job_id !== undefined && signal.job_id !== null
      ? signal.job_id
      : (existing?.state.job_id ?? null);
  const initialStageId =
    signal.initial_stage_id ??
    existing?.state.initial_stage_id ??
    RECRUITER_PHONE_SCREEN_STAGE_ID;
  const jobInterviewId =
    signal.job_interview_id ??
    existing?.state.job_interview_id ??
    RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID;

  const urgentTimerKey = `wf1_job_mapping_urgent:${episodeId}`;

  const highPriorityQuestion =
    resolvedJobId === null && !isCancelled
      ? `Which Greenhouse job requisition should *${names.candidate_name}* (${normalizeEmail(signal.candidate_email)}, booked for ${signal.starts_at}) be mapped to?`
      : null;

  const nextRescheduleCount =
    (existing?.state.reschedule_count ?? 0) + (wasRescheduled ? 1 : 0);
  const completedPreviously = existing?.status === 'COMPLETED';
  const nextChainId =
    isCancelled && completedPreviously && existing?.state.resolved_interview_id != null
      ? `wf1_cancel_chain:${episodeId}`
      : wasRescheduled && completedPreviously && existing?.state.resolved_interview_id != null
        ? `wf1_reschedule_chain:${episodeId}:${nextRescheduleCount}`
        : (existing?.state.chain_id ?? `wf1_chain_c:${episodeId}`);

  const state: IntakeEpisodeState = {
    primary_key: primaryKey,
    invitee_uri: signal.invitee_uri ?? existing?.state.invitee_uri ?? null,
    ical_uid: signal.ical_uid ?? existing?.state.ical_uid ?? null,
    calendar_event_id: signal.calendar_event_id ?? existing?.state.calendar_event_id ?? null,
    gmail_message_id: signal.gmail_message_id ?? existing?.state.gmail_message_id ?? null,
    booking_fingerprint: fingerprint,
    prior_booking_fingerprints: [...priorFingerprints],
    signals_received: [...signalsReceived],
    candidate_email: normalizeEmail(signal.candidate_email),
    first_name: signal.first_name?.trim() || existing?.state.first_name || names.first_name,
    last_name: signal.last_name?.trim() || existing?.state.last_name || names.last_name,
    candidate_name:
      signal.full_name?.trim() || existing?.state.candidate_name || names.candidate_name,
    phone: signal.phone !== undefined ? signal.phone : (existing?.state.phone ?? null),
    linkedin_url:
      signal.linkedin_url !== undefined
        ? signal.linkedin_url
        : (existing?.state.linkedin_url ?? null),
    tags: signal.tags ?? existing?.state.tags ?? ['Calendly Intake'],
    starts_at: signal.starts_at,
    ends_at: signal.ends_at,
    booking_status: isCancelled ? 'canceled' : 'active',
    reschedule_count: nextRescheduleCount,
    job_id: resolvedJobId,
    initial_stage_id: initialStageId,
    job_interview_id: jobInterviewId,
    source_id:
      signal.source_id !== undefined ? signal.source_id : (existing?.state.source_id ?? null),
    referrer_id: SAM_REFERRER_ID,
    recruiter_id: SAM_GREENHOUSE_USER_ID,
    coordinator_id: SAM_GREENHOUSE_USER_ID,
    existing_candidate_id:
      signal.existing_candidate_id !== undefined
        ? signal.existing_candidate_id
        : (existing?.state.existing_candidate_id ?? null),
    existing_application_id:
      signal.existing_application_id !== undefined
        ? signal.existing_application_id
        : (existing?.state.existing_application_id ?? null),
    existing_application_stage_id:
      signal.existing_application_stage_id !== undefined
        ? signal.existing_application_stage_id
        : (existing?.state.existing_application_stage_id ?? null),
    prospect_application_id:
      signal.prospect_application_id !== undefined
        ? signal.prospect_application_id
        : (existing?.state.prospect_application_id ?? null),
    existing_has_resume:
      signal.existing_has_resume ?? existing?.state.existing_has_resume ?? false,
    resume_filename: resumeFilename,
    resume_base64: resumeMeta.canonicalBase64,
    resume_sha256: resumeMeta.sha256,
    resume_byte_length: resumeMeta.byteLength,
    video_conferencing_url:
      signal.video_conferencing_url !== undefined
        ? signal.video_conferencing_url
        : (existing?.state.video_conferencing_url ?? null),
    location:
      signal.location !== undefined ? signal.location : (existing?.state.location ?? null),
    high_priority_question: highPriorityQuestion,
    urgent_reminder_timer_key: resolvedJobId === null && !isCancelled ? urgentTimerKey : null,
    pending_wf2_draft: existing?.state.pending_wf2_draft ?? null,
    unlocked_wf2_episode_id: existing?.state.unlocked_wf2_episode_id ?? null,
    chain_id: nextChainId,
    resolved_candidate_id:
      existing?.state.resolved_candidate_id ?? signal.existing_candidate_id ?? null,
    resolved_application_id:
      existing?.state.resolved_application_id ?? signal.existing_application_id ?? null,
    resolved_interview_id: existing?.state.resolved_interview_id ?? null,
  };

  let status: string;
  if (isCancelled) {
    status =
      completedPreviously && state.resolved_interview_id != null
        ? 'CANCELLED_PENDING_DELETE'
        : 'CANCELLED';
  } else if (resolvedJobId === null) {
    status = 'AWAITING_JOB_MAPPING';
  } else if (completedPreviously) {
    status = wasRescheduled ? 'RESCHEDULED_PENDING_UPDATE' : 'COMPLETED';
  } else {
    status = 'PENDING_APPROVAL';
  }

  const episode = store.upsertEpisode<IntakeEpisodeState>({
    episode_id: episodeId,
    workflow: 'wf1_intake',
    application_id: state.resolved_application_id ?? state.existing_application_id ?? null,
    candidate_id: state.resolved_candidate_id ?? state.existing_candidate_id ?? null,
    job_id: resolvedJobId,
    stage_id: resolvedJobId ? initialStageId : null,
    status,
    state,
    now,
  });

  if (isCancelled) {
    store.cancelTimersByPrefix(urgentTimerKey, 'Booking cancelled', now);
    store.supersedeApprovalsForEpisode(episodeId, 'Booking cancelled', { now });
    const cancelApproval =
      status === 'CANCELLED_PENDING_DELETE'
        ? registerChainCProposal(store, episode, now)
        : null;
    return {
      episode,
      correlated_existing: Boolean(existing),
      was_rescheduled: false,
      was_cancelled: true,
      urgent_timer: null,
      approval: cancelApproval,
    };
  }

  if (resolvedJobId === null) {
    const startsMs = Date.parse(signal.starts_at);
    const urgentFireAt = new Date(startsMs - URGENT_JOB_MAPPING_REMINDER_LEAD_MS).toISOString();
    const timer = store.scheduleTimer({
      timer_key: urgentTimerKey,
      episode_id: episodeId,
      kind: 'wf1_job_mapping_urgent',
      fire_at: urgentFireAt,
      payload: {
        episode_id: episodeId,
        candidate_name: state.candidate_name,
        candidate_email: state.candidate_email,
        starts_at: state.starts_at,
        question: highPriorityQuestion,
      },
      now,
    });
    return {
      episode,
      correlated_existing: Boolean(existing),
      was_rescheduled: wasRescheduled,
      was_cancelled: false,
      urgent_timer: timer,
      approval: null,
    };
  }

  // Job is known -> cancel any job-mapping reminder and register Chain C proposal
  store.cancelTimersByPrefix(urgentTimerKey, 'Job mapping resolved', now);
  const approval = registerChainCProposal(store, episode, now);
  store.supersedeApprovalsForEpisode(episodeId, 'Superseded by updated WF1 booking signal', {
    keepProposalHash: approval.proposal_hash,
    now,
  });

  return {
    episode,
    correlated_existing: Boolean(existing),
    was_rescheduled: wasRescheduled,
    was_cancelled: false,
    urgent_timer: null,
    approval,
  };
}

export function determineIntakeApplicationMode(
  state: IntakeEpisodeState,
): IntakeApplicationMode {
  if (state.prospect_application_id != null) {
    return 'prospect_convert';
  }
  if (state.existing_application_id != null) {
    return 'advance_existing';
  }
  return 'create';
}

export function registerChainCProposal(
  store: SqliteCoordinatorStore,
  episode: EpisodeRow<IntakeEpisodeState>,
  now: string = new Date().toISOString(),
): ApprovalRow {
  const state = episode.state;
  const chainId = state.chain_id ?? `wf1_chain_c:${episode.episode_id}`;
  const appMode = determineIntakeApplicationMode(state);
  const pendingDraftSha = state.pending_wf2_draft
    ? sha256(canonicalize(state.pending_wf2_draft))
    : null;

  return store.registerProposal({
    episode_id: episode.episode_id,
    action_key: chainId,
    chain_id: chainId,
    workflow: 'wf1_intake',
    params: {
      candidate_email: state.candidate_email,
      candidate_name: state.candidate_name,
      job_id: state.job_id,
      initial_stage_id: state.initial_stage_id,
      application_mode: appMode,
      existing_candidate_id: state.existing_candidate_id,
      existing_application_id: state.existing_application_id,
      prospect_application_id: state.prospect_application_id,
      has_resume_to_upload: Boolean(state.resume_base64 && !state.existing_has_resume),
      starts_at: state.starts_at,
      ends_at: state.ends_at,
      booking_status: state.booking_status,
      ...(pendingDraftSha
        ? {
            unlocks_pending_wf2_draft: true,
            pending_wf2_draft_sha256: pendingDraftSha,
          }
        : {}),
    },
    expected_state:
      state.existing_application_id != null
        ? {
            application_id: state.existing_application_id,
            application_status: ['active', 'in_process'],
            ...(state.existing_application_stage_id != null
              ? { stage_id: state.existing_application_stage_id }
              : {}),
          }
        : {},
    now,
  });
}

/**
 * Fires at `starts_at - 2 hours` when an `IntakeEpisode` is still in `AWAITING_JOB_MAPPING`.
 * Sends a single urgent Slack DM reminder to Sam.
 */
export async function handleJobMappingUrgentReminderTimer(
  timer: TimerRow,
  executor: DeterministicExecutor,
): Promise<{ sent: boolean; reason?: string }> {
  const nowIso = executor.nowIso();
  const episode = executor.store.getEpisode<IntakeEpisodeState>(timer.episode_id);
  if (!episode || episode.status !== 'AWAITING_JOB_MAPPING' || episode.state.job_id !== null) {
    executor.store.updateTimerStatus(timer.timer_key, 'cancelled', {
      reason: 'Episode is no longer in AWAITING_JOB_MAPPING.',
      now: nowIso,
    });
    return { sent: false, reason: 'already_resolved' };
  }

  if (executor.slack) {
    const dmText = `:rotating_light: *Urgent (< 2h before call):* Please map a Greenhouse job requisition for *${episode.state.candidate_name}* (\`${episode.state.candidate_email}\`, call at ${episode.state.starts_at}) so Chain C intake can create their application and Recruiter Phone Screen scorecard slot.`;
    const actionKey = `wf1_job_mapping_urgent_dm:${episode.episode_id}`;
    const idempotencyKey = sha256(`${episode.episode_id}:${actionKey}`);
    const draftSha = sha256(dmText);
    appendLedger(executor.dataDir, {
      kind: 'action',
      status: 'intent',
      service: 'slack',
      action_key: actionKey,
      episode_id: episode.episode_id,
      idempotency_key: idempotencyKey,
      draft_sha256: draftSha,
      at: nowIso,
    });
    const sent = await executor.slack.sendMessage({
      channel: SAM_SLACK_USER_ID,
      text: dmText,
    });
    appendLedger(executor.dataDir, {
      kind: 'action',
      status: 'dispatched',
      service: 'slack',
      action_key: actionKey,
      episode_id: episode.episode_id,
      idempotency_key: idempotencyKey,
      draft_sha256: draftSha,
      provider_id: sent.ts,
      at: nowIso,
    });
  }

  executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: nowIso });
  return { sent: true };
}

/**
 * Captures and validates a quote-grounded Workflow 2 Granola screen draft while the
 * Workflow 1 episode is still in `AWAITING_JOB_MAPPING`. Holds Greenhouse `scorecard_submit`
 * until Sam supplies `job_id`, which unlocks Chain C and Chain D in sequence.
 */
export function capturePendingWf2DraftDuringJobMappingHold(
  store: SqliteCoordinatorStore,
  input: {
    episode_id: string;
    draft: SystemsAdminScorecardDraft;
    interview_ended_at: string;
    now?: string;
  },
): EpisodeRow<IntakeEpisodeState> {
  const now = input.now ?? new Date().toISOString();
  const episode = store.getEpisode<IntakeEpisodeState>(input.episode_id);
  if (!episode) {
    throw new Error(`Unknown WF1 intake episode '${input.episode_id}'.`);
  }

  const validation = validateSystemsAdminScorecardDraft(input.draft);
  if (!validation.ok) {
    const err = new Error(
      `Cannot capture ungrounded WF2 draft on ${input.episode_id}: ${validation.errors.join('; ')}`,
    ) as Error & { code?: string; validationErrors?: string[] };
    err.code = 'UNGROUNDED_SCORECARD_CLAIM';
    err.validationErrors = validation.errors;
    throw err;
  }

  const nextState: IntakeEpisodeState = {
    ...episode.state,
    pending_wf2_draft: {
      draft: input.draft,
      interview_ended_at: input.interview_ended_at,
      captured_at: now,
    },
  };

  return store.upsertEpisode<IntakeEpisodeState>({
    episode_id: episode.episode_id,
    workflow: 'wf1_intake',
    application_id: episode.application_id,
    candidate_id: episode.candidate_id,
    job_id: episode.job_id,
    stage_id: episode.stage_id,
    status: episode.status,
    state: nextState,
    now,
  });
}

/**
 * Resolves `AWAITING_JOB_MAPPING` once Sam supplies `job_id`, cancelling the urgent reminder timer
 * and unlocking Chain C (and any pending WF2 Granola scorecard draft).
 */
export function resolveJobMapping(
  store: SqliteCoordinatorStore,
  input: {
    episode_id: string;
    job_id: number;
    initial_stage_id?: number;
    job_interview_id?: number;
    source_id?: number | null;
    now?: string;
  },
): {
  episode: EpisodeRow<IntakeEpisodeState>;
  approval: ApprovalRow;
  has_pending_wf2_draft: boolean;
} {
  const now = input.now ?? new Date().toISOString();
  const existing = store.getEpisode<IntakeEpisodeState>(input.episode_id);
  if (!existing) {
    throw new Error(`Unknown WF1 intake episode '${input.episode_id}'.`);
  }

  const initialStageId =
    input.initial_stage_id ?? existing.state.initial_stage_id ?? RECRUITER_PHONE_SCREEN_STAGE_ID;
  const jobInterviewId =
    input.job_interview_id ??
    existing.state.job_interview_id ??
    RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID;

  const nextState: IntakeEpisodeState = {
    ...existing.state,
    job_id: input.job_id,
    initial_stage_id: initialStageId,
    job_interview_id: jobInterviewId,
    source_id: input.source_id !== undefined ? input.source_id : existing.state.source_id,
    high_priority_question: null,
    urgent_reminder_timer_key: null,
  };

  store.cancelTimersByPrefix(
    `wf1_job_mapping_urgent:${input.episode_id}`,
    `Job mapped to ${input.job_id}`,
    now,
  );

  const updated = store.upsertEpisode<IntakeEpisodeState>({
    episode_id: existing.episode_id,
    workflow: 'wf1_intake',
    application_id: existing.application_id,
    candidate_id: existing.candidate_id,
    job_id: input.job_id,
    stage_id: initialStageId,
    status: 'PENDING_APPROVAL',
    state: nextState,
    now,
  });

  const approval = registerChainCProposal(store, updated, now);
  store.supersedeApprovalsForEpisode(existing.episode_id, 'Superseded by resolveJobMapping', {
    keepProposalHash: approval.proposal_hash,
    now,
  });

  return {
    episode: updated,
    approval,
    has_pending_wf2_draft: Boolean(updated.state.pending_wf2_draft),
  };
}

/**
 * Builds the Chain C (`wf1_intake`) steps:
 * 1. `ensure_candidate`: `candidate_create` (`POST /v3/candidates` person record only) or existing candidate resolution
 * 2. `ensure_application`: `application_create` (`POST /v3/applications`), `prospect_convert`
 *    (`POST /v3/applications/{id}/convert_to_candidate` returning a NEW `application_id`),
 *    or `application_stage_move` (`POST /v3/applications/{id}/move` from `Application Review` to `Recruiter Phone Screen`)
 * 3. `upload_resume`: `attachment_create` (`POST /v3/attachments` with out-of-band base64 `payload`)
 * 4. `create_phone_screen_interview`: `interview_create` (`POST /v3/interviews` linking external_event_id to slot `14297388004`)
 */
export function buildWorkflow1ChainCSteps(
  state: IntakeEpisodeState,
  executor: DeterministicExecutor,
): ChainStepDefinition[] {
  if (!state.job_id) {
    throw new Error('Cannot build Chain C steps while job_id is null (AWAITING_JOB_MAPPING).');
  }

  const jobId = state.job_id;
  const appMode = determineIntakeApplicationMode(state);
  const steps: ChainStepDefinition[] = [];

  // Step 1: Candidate Create or Lookup
  steps.push({
    step_index: 10,
    step_key: 'ensure_candidate',
    action_key: `wf1_ensure_candidate:${state.booking_fingerprint.slice(0, 16)}`,
    service: 'greenhouse',
    operation: 'candidate_create',
    buildInput: () => ({
      context_job_id: jobId,
      first_name: state.first_name,
      last_name: state.last_name,
      email_addresses: [{ value: state.candidate_email, type: 'personal' }],
      ...(state.phone ? { phone_numbers: [{ value: state.phone, type: 'mobile' }] } : {}),
      ...(state.linkedin_url
        ? { social_media_addresses: [{ value: state.linkedin_url }] }
        : {}),
      ...(state.tags?.length ? { tags: state.tags } : {}),
      recruiter_id: state.recruiter_id ?? SAM_GREENHOUSE_USER_ID,
      coordinator_id: state.coordinator_id ?? SAM_GREENHOUSE_USER_ID,
    }),
    execute:
      state.existing_candidate_id != null
        ? async () => ({
            provider_id: String(state.existing_candidate_id),
            output: {
              candidate_id: state.existing_candidate_id,
              existing: true,
            },
            no_change: true,
          })
        : undefined,
  });

  // Step 2: Application Create, Prospect Convert, or Stage Move from Application Review
  if (appMode === 'prospect_convert') {
    steps.push({
      step_index: 20,
      step_key: 'ensure_application',
      action_key: `wf1_prospect_convert:${state.prospect_application_id}:${jobId}`,
      service: 'greenhouse',
      operation: 'prospect_convert',
      buildInput: () => ({
        application_id: state.prospect_application_id!,
        job_id: jobId,
        to_job_interview_stage_id: state.initial_stage_id,
      }),
    });
  } else if (appMode === 'advance_existing') {
    const shouldMoveFromAppReview =
      state.existing_application_stage_id == null ||
      state.existing_application_stage_id === APPLICATION_REVIEW_STAGE_ID;
    steps.push({
      step_index: 20,
      step_key: 'ensure_application',
      action_key: `wf1_advance_existing_app:${state.existing_application_id}:${state.initial_stage_id}`,
      service: 'greenhouse',
      operation: 'application_stage_move',
      buildInput: () => ({
        application_id: state.existing_application_id!,
        to_stage_id: state.initial_stage_id,
        email_from_user_id: SAM_GREENHOUSE_USER_ID,
      }),
      execute: !shouldMoveFromAppReview
        ? async () => ({
            provider_id: String(state.existing_application_id),
            output: {
              application_id: state.existing_application_id,
              already_in_or_past_stage: true,
            },
            no_change: true,
          })
        : async (_ctx, input) => {
            const res = await executor.executeGreenhouseStep('application_stage_move', input);
            return {
              provider_id: String(state.existing_application_id),
              output: {
                ...(res.output ?? {}),
                application_id: state.existing_application_id,
              },
              no_change: res.no_change,
            };
          },
    });
  } else {
    steps.push({
      step_index: 20,
      step_key: 'ensure_application',
      action_key: `wf1_application_create:${state.booking_fingerprint.slice(0, 16)}:${jobId}`,
      service: 'greenhouse',
      operation: 'application_create',
      buildInput: ctx => {
        const candidateIdStr =
          ctx.priorProviderIds.ensure_candidate ??
          (state.existing_candidate_id != null ? String(state.existing_candidate_id) : undefined);
        const candidateId = Number(candidateIdStr);
        if (!Number.isFinite(candidateId) || candidateId <= 0) {
          throw new Error(
            `Step 'ensure_application' requires a valid candidate_id from Step 1; got '${candidateIdStr}'.`,
          );
        }
        return {
          candidate_id: candidateId,
          job_id: jobId,
          initial_stage_id: state.initial_stage_id,
          ...(state.source_id != null ? { source_id: state.source_id } : {}),
          referrer_id: state.referrer_id ?? SAM_REFERRER_ID,
          recruiter_id: state.recruiter_id ?? SAM_GREENHOUSE_USER_ID,
          coordinator_id: state.coordinator_id ?? SAM_GREENHOUSE_USER_ID,
        };
      },
    });
  }

  // Step 3: Resume Attachment Upload (when resume_base64 collected and no existing resume on app)
  if (state.resume_base64 && !state.existing_has_resume) {
    steps.push({
      step_index: 30,
      step_key: 'upload_resume',
      action_key: `wf1_upload_resume:${state.booking_fingerprint.slice(0, 16)}:${jobId}`,
      service: 'greenhouse',
      operation: 'attachment_create',
      buildInput: ctx => {
        const appId = resolveApplicationIdFromContext(ctx, state);
        return {
          application_id: appId,
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

  // Step 4: Link Calendly / Google Calendar Event to Recruiter Phone Screen Interview Slot
  steps.push({
    step_index: 40,
    step_key: 'create_phone_screen_interview',
    action_key: `wf1_interview_create:${state.booking_fingerprint.slice(0, 16)}:${jobId}`,
    service: 'greenhouse',
    operation: 'interview_create',
    buildInput: ctx => {
      const appId = resolveApplicationIdFromContext(ctx, state);
      const externalEventId =
        state.calendar_event_id ??
        state.ical_uid ??
        state.invitee_uri ??
        `calendly:${state.booking_fingerprint.slice(0, 16)}`;
      return {
        application_id: appId,
        job_interview_id: state.job_interview_id ?? RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID,
        interviewers: [
          {
            user_id: SAM_GREENHOUSE_USER_ID,
            response_status: 'accepted',
          },
        ],
        starts_at: state.starts_at,
        ends_at: state.ends_at,
        external_event_id: externalEventId,
        ...(state.video_conferencing_url
          ? { video_conferencing_url: state.video_conferencing_url }
          : {}),
        ...(state.location ? { location: state.location } : {}),
      };
    },
  });

  return steps;
}

function resolveApplicationIdFromContext(
  ctx: {
    priorProviderIds: Record<string, string>;
    priorOutputs: Record<string, Record<string, unknown>>;
  },
  state: IntakeEpisodeState,
): number {
  const fromOutput =
    (ctx.priorOutputs.ensure_application?.result_resource_id as number | undefined) ??
    (ctx.priorOutputs.ensure_application?.application_id as number | undefined);
  if (typeof fromOutput === 'number' && Number.isFinite(fromOutput) && fromOutput > 0) {
    return fromOutput;
  }
  const fromProviderId = Number(ctx.priorProviderIds.ensure_application);
  if (Number.isFinite(fromProviderId) && fromProviderId > 0) {
    return fromProviderId;
  }
  if (state.resolved_application_id != null && state.resolved_application_id > 0) {
    return state.resolved_application_id;
  }
  if (state.existing_application_id != null && state.existing_application_id > 0) {
    return state.existing_application_id;
  }
  throw new Error(
    `Downstream Chain C step requires a valid application_id from Step 2 ('ensure_application').`,
  );
}

/**
 * Executes Chain C (`wf1_intake`) for a mapped episode, propagating the newly created or converted
 * `application_id` across all downstream steps (`attachment_create`, `interview_create`) and
 * automatically unlocking any pending WF2 Granola scorecard draft (`pending_wf2_draft`) in sequence!
 */
export async function executeWorkflow1IntakeChain(
  executor: DeterministicExecutor,
  input: {
    episode_id: string;
    approval?: ApprovalRow | null;
    fresh_snapshot?: FreshReadSnapshot | null | (() => Promise<FreshReadSnapshot>);
    auto_execute_pending_wf2?: boolean;
    wf2_fresh_snapshot?: FreshReadSnapshot | null | (() => Promise<FreshReadSnapshot>);
  },
): Promise<{
  chain_c_result: ExecuteChainResult;
  candidate_id: number | null;
  application_id: number | null;
  unlocked_wf2?: {
    episode_id: string;
    approval: ApprovalRow;
    chain_d_result?: ExecuteChainResult;
  };
}> {
  const episode = executor.store.getEpisode<IntakeEpisodeState>(input.episode_id);
  if (!episode) {
    throw new Error(`Unknown WF1 intake episode '${input.episode_id}'.`);
  }
  const state = episode.state;
  if (!state.job_id) {
    throw new Error(
      `WF1 episode '${input.episode_id}' is in AWAITING_JOB_MAPPING; resolve job_id before executing Chain C.`,
    );
  }

  const chainId = state.chain_id ?? `wf1_chain_c:${episode.episode_id}`;

  // Guard against executing Chain C on a booking that was cancelled before execution!
  if (
    episode.status === 'CANCELLED' ||
    (state.booking_status === 'canceled' && episode.status !== 'CANCELLED_PENDING_DELETE')
  ) {
    if (input.approval) {
      executor.store.markApprovalOutcome(input.approval.proposal_hash, 'stale_aborted', {
        failureReason: 'BOOKING_CANCELLED: Booking was cancelled prior to Chain C execution.',
        now: executor.nowIso(),
      });
    }
    return {
      chain_c_result: {
        ok: false,
        chain_id: chainId,
        status: 'aborted_stale',
        reason: 'BOOKING_CANCELLED: Booking was cancelled prior to Chain C execution.',
        step_results: {},
      },
      candidate_id: state.resolved_candidate_id,
      application_id: state.resolved_application_id,
    };
  }

  // Guard against executing a stale pre-reschedule approval after `starts_at` changed
  if (
    input.approval &&
    episode.status !== 'CANCELLED_PENDING_DELETE' &&
    typeof (input.approval.params as any)?.starts_at === 'string' &&
    (input.approval.params as any).starts_at !== state.starts_at
  ) {
    executor.store.markApprovalOutcome(input.approval.proposal_hash, 'stale_aborted', {
      failureReason: `BOOKING_RESCHEDULED: Approval starts_at (${(input.approval.params as any).starts_at}) does not match episode starts_at (${state.starts_at}).`,
      now: executor.nowIso(),
    });
    return {
      chain_c_result: {
        ok: false,
        chain_id: chainId,
        status: 'aborted_stale',
        reason: 'BOOKING_RESCHEDULED: Approval is for an older booking time.',
        step_results: {},
      },
      candidate_id: state.resolved_candidate_id,
      application_id: state.resolved_application_id,
    };
  }

  let steps: ChainStepDefinition[];
  if (episode.status === 'CANCELLED_PENDING_DELETE' && state.resolved_interview_id != null) {
    steps = [
      {
        step_index: 10,
        step_key: 'delete_cancelled_phone_screen_interview',
        action_key: `wf1_interview_delete:${state.resolved_interview_id}`,
        service: 'greenhouse',
        operation: 'interview_delete',
        buildInput: () => ({
          interview_id: state.resolved_interview_id!,
          application_id: state.resolved_application_id ?? state.existing_application_id,
        }),
      },
    ];
  } else if (
    episode.status === 'RESCHEDULED_PENDING_UPDATE' &&
    state.resolved_interview_id != null
  ) {
    steps = [
      {
        step_index: 10,
        step_key: 'update_rescheduled_phone_screen_interview',
        action_key: `wf1_interview_update:${state.resolved_interview_id}:${state.reschedule_count}`,
        service: 'greenhouse',
        operation: 'interview_update',
        buildInput: () => ({
          interview_id: state.resolved_interview_id!,
          application_id: state.resolved_application_id ?? state.existing_application_id,
          starts_at: state.starts_at,
          ends_at: state.ends_at,
        }),
      },
    ];
  } else {
    steps = buildWorkflow1ChainCSteps(state, executor);
  }

  const expectedState: ExpectedFreshState =
    state.existing_application_id != null
      ? {
          application_id: state.existing_application_id,
          application_status: ['active', 'in_process'],
          ...(state.existing_application_stage_id != null &&
          episode.status !== 'RESCHEDULED_PENDING_UPDATE' &&
          episode.status !== 'CANCELLED_PENDING_DELETE'
            ? { stage_id: state.existing_application_stage_id }
            : {}),
        }
      : {};

  const chainCResult = await executor.executeChain({
    chain_id: chainId,
    episode_id: episode.episode_id,
    workflow: 'wf1_intake',
    approval: input.approval ?? null,
    expected_state: expectedState,
    fresh_snapshot: input.fresh_snapshot,
    steps,
  });

  const candStep = executor.store.getChainStep(chainId, 'ensure_candidate');
  const appStep = executor.store.getChainStep(chainId, 'ensure_application');
  const intStep = executor.store.getChainStep(chainId, 'create_phone_screen_interview');

  const resolvedCandidateId =
    Number(candStep?.provider_id) > 0
      ? Number(candStep?.provider_id)
      : (state.resolved_candidate_id ?? state.existing_candidate_id ?? null);

  const appStepOutput = (appStep?.output ?? {}) as Record<string, any>;
  const resolvedApplicationId =
    Number(appStepOutput.result_resource_id) > 0
      ? Number(appStepOutput.result_resource_id)
      : Number(appStep?.provider_id) > 0
        ? Number(appStep?.provider_id)
        : (state.resolved_application_id ?? state.existing_application_id ?? null);

  const intStepOutput = (intStep?.output ?? {}) as Record<string, any>;
  const resolvedInterviewId =
    episode.status === 'CANCELLED_PENDING_DELETE' && chainCResult.ok
      ? null
      : Number(intStepOutput.result_resource_id) > 0
        ? Number(intStepOutput.result_resource_id)
        : Number(intStep?.provider_id) > 0
          ? Number(intStep?.provider_id)
          : (state.resolved_interview_id ?? null);

  let unlockedWf2:
    | {
        episode_id: string;
        approval: ApprovalRow;
        chain_d_result?: ExecuteChainResult;
      }
    | undefined;

  let remainingPendingDraft = state.pending_wf2_draft;

  if (chainCResult.ok && state.pending_wf2_draft && resolvedApplicationId != null) {
    const existingWf2Ep = state.unlocked_wf2_episode_id
      ? executor.store.getEpisode(state.unlocked_wf2_episode_id)
      : null;

    let wf2EpisodeId: string;
    let wf2Approval: ApprovalRow;

    if (existingWf2Ep) {
      wf2EpisodeId = existingWf2Ep.episode_id;
      const existingChainId =
        (existingWf2Ep.state as any)?.chain_id ??
        `wf2_chain_d:${resolvedApplicationId}:${state.initial_stage_id}`;
      const foundApproval = executor.store
        .listReadyApprovals()
        .find(a => a.episode_id === wf2EpisodeId && a.chain_id === existingChainId);
      if (foundApproval) {
        wf2Approval = foundApproval;
      } else {
        const wf2Prepared = prepareWorkflow2ScorecardProposal(executor.store, {
          episode_id: wf2EpisodeId,
          application_id: resolvedApplicationId,
          candidate_id: resolvedCandidateId,
          candidate_name: state.candidate_name,
          job_id: state.job_id,
          from_stage_id: state.initial_stage_id,
          to_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          job_interview_id: state.job_interview_id,
          interview_kit_id: RECRUITER_PHONE_SCREEN_KIT_ID,
          interview_ended_at: state.pending_wf2_draft.interview_ended_at,
          draft: state.pending_wf2_draft.draft,
          now: executor.nowIso(),
        });
        wf2Approval = wf2Prepared.approval;
      }
    } else {
      const wf2Prepared = prepareWorkflow2ScorecardProposal(executor.store, {
        application_id: resolvedApplicationId,
        candidate_id: resolvedCandidateId,
        candidate_name: state.candidate_name,
        job_id: state.job_id,
        from_stage_id: state.initial_stage_id,
        to_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        job_interview_id: state.job_interview_id,
        interview_kit_id: RECRUITER_PHONE_SCREEN_KIT_ID,
        interview_ended_at: state.pending_wf2_draft.interview_ended_at,
        draft: state.pending_wf2_draft.draft,
        now: executor.nowIso(),
      });
      wf2EpisodeId = wf2Prepared.episode.episode_id;
      wf2Approval = wf2Prepared.approval;
    }

    unlockedWf2 = {
      episode_id: wf2EpisodeId,
      approval: wf2Approval,
    };

    const approvalParams = (input.approval?.params ?? {}) as Record<string, any>;
    const currentDraftSha = sha256(canonicalize(state.pending_wf2_draft));
    const approvalBoundPendingDraft =
      approvalParams.unlocks_pending_wf2_draft === true &&
      approvalParams.pending_wf2_draft_sha256 === currentDraftSha;

    const shouldAutoExecuteWf2 =
      input.auto_execute_pending_wf2 !== undefined
        ? input.auto_execute_pending_wf2
        : approvalBoundPendingDraft;

    if (shouldAutoExecuteWf2) {
      const grantedWf2Approval =
        wf2Approval.decision === 'approved'
          ? wf2Approval
          : executor.store.grantApproval({
              proposal_hash: wf2Approval.proposal_hash,
              decision: 'approved',
              actor: 'sam',
              now: executor.nowIso(),
            });
      const defaultWf2Snapshot: FreshReadSnapshot = {
        fetched_at: executor.nowIso(),
        application: {
          id: resolvedApplicationId,
          candidate_id: resolvedCandidateId ?? undefined,
          job_id: state.job_id,
          status: 'in_process',
          current_stage_id: state.initial_stage_id,
        },
        scorecards: [],
      };
      const chainDResult = await executeWorkflow2ChainD(executor, {
        episode_id: wf2EpisodeId,
        approval: grantedWf2Approval,
        fresh_snapshot:
          input.wf2_fresh_snapshot !== undefined
            ? input.wf2_fresh_snapshot
            : executor.freshReadFetcher
              ? undefined
              : defaultWf2Snapshot,
      });
      unlockedWf2.chain_d_result = chainDResult;
      if (chainDResult.ok) {
        remainingPendingDraft = null;
      }
    }
  }

  const nextState: IntakeEpisodeState = {
    ...state,
    chain_id: chainId,
    resolved_candidate_id: resolvedCandidateId,
    resolved_application_id: resolvedApplicationId,
    resolved_interview_id: resolvedInterviewId,
    pending_wf2_draft: remainingPendingDraft,
    unlocked_wf2_episode_id: unlockedWf2?.episode_id ?? state.unlocked_wf2_episode_id,
  };

  const finalStatus = chainCResult.ok
    ? episode.status === 'CANCELLED_PENDING_DELETE'
      ? 'CANCELLED'
      : 'COMPLETED'
    : `FAILED_${chainCResult.status.toUpperCase()}`;

  executor.store.upsertEpisode<IntakeEpisodeState>({
    episode_id: episode.episode_id,
    workflow: 'wf1_intake',
    application_id: resolvedApplicationId,
    candidate_id: resolvedCandidateId,
    job_id: state.job_id,
    stage_id: state.initial_stage_id,
    status: finalStatus,
    state: nextState,
    now: executor.nowIso(),
  });

  return {
    chain_c_result: chainCResult,
    candidate_id: resolvedCandidateId,
    application_id: resolvedApplicationId,
    unlocked_wf2: unlockedWf2,
  };
}
