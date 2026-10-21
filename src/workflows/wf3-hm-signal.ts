import { sha256 } from '../../worker/ledger.mjs';
import {
  type ApprovalRow,
  type ChainStepRow,
  type EpisodeRow,
  type HmSignalRow,
  SqliteCoordinatorStore,
} from '../store/sqlite.ts';
import {
  type ChainStepContext,
  type ChainStepDefinition,
  DeterministicExecutor,
  type ExecuteChainResult,
  type ExpectedFreshState,
  type FreshReadSnapshot,
  SAM_EMAIL,
  SAM_GREENHOUSE_USER_ID,
} from '../executor/index.ts';

export const PILOT_JOB_ID = 5149015004;
export const FIELD_ENGINEERING_HIRING_CHANNEL_ID = 'C0C9VEPBAJC';
export const HIRING_MANAGER_REVIEW_STAGE_ID = 12579938004;
export const TURING_ASSESSMENT_STAGE_ID = 12579939004;
export const MANAGER_TECH_SCREEN_STAGE_ID = 12579940004;
export const KHIEM_DOAN_USER_ID = 5372540004;

export interface JobStageMetadata {
  id: number;
  name: string;
  priority: number;
  has_auto_email_rule?: boolean;
}

export const PILOT_JOB_ORDERED_STAGES: readonly JobStageMetadata[] = [
  { id: 12579936004, name: 'Application Review', priority: 1 },
  { id: 12579937004, name: 'Recruiter Phone Screen', priority: 2 },
  { id: 12579938004, name: 'Hiring Manager Review', priority: 3 },
  { id: 12579939004, name: 'Turing Assessment', priority: 4 },
  { id: 12579940004, name: 'Manager / Tech Screen', priority: 5 },
  { id: 12579941004, name: 'Onsite Interviews', priority: 6 },
];

export const POSITIVE_EMOJI_REACTIONS = new Set([
  '+1',
  'thumbsup',
  'white_check_mark',
  'heavy_check_mark',
  'rocket',
  'fire',
  '100',
  'yes',
]);

export interface SlateCandidateItem {
  application_id: number;
  candidate_id?: number | null;
  candidate_name: string;
  candidate_email: string;
  current_stage_id: number;
}

export interface EvaluateHmSignalInput {
  channel_id: string;
  message_ts: string;
  reactor_or_reply_id: string;
  allow_self_signal?: boolean;
  signal_type: 'reaction' | 'reply';
  reaction_emoji?: string;
  reply_text?: string;
  message_candidates: SlateCandidateItem[];
  job_id?: number;
  job_name?: string;
  job_stages?: readonly JobStageMetadata[];
  explicit_target_stage_id?: number;
  default_route_after_hm_review?: 'turing_assessment' | 'manager_tech_screen';
  stage_has_auto_email_rule?: boolean;
  stage_auto_email_rules?: Record<number, boolean>;
  designated_interviewer_id?: number;
  designated_interviewer_name?: string;
  gmail_thread_id?: string | null;
  gmail_last_message_id?: string | null;
  now?: string;
}

export interface Workflow3EpisodeState {
  signal_key: string;
  channel_id: string;
  message_ts: string;
  reactor_or_reply_id: string;
  signal_type: 'reaction' | 'reply';
  application_id: number;
  candidate_id: number | null;
  candidate_name: string;
  candidate_email: string;
  job_id: number;
  job_name: string;
  from_stage_id: number;
  target_stage_id: number;
  target_stage_name: string;
  route_kind: 'turing_assessment' | 'manager_tech_screen' | 'next_stage';
  stage_has_auto_email_rule: boolean;
  suppress_outreach_email: boolean;
  outreach_subject: string | null;
  outreach_body_html: string | null;
  designated_interviewer_id: number;
  designated_interviewer_name: string;
  gmail_thread_id: string | null;
  gmail_last_message_id: string | null;
  chain_id: string;
}

export function buildHmSignalKey(input: {
  channel_id: string;
  message_ts: string;
  reactor_or_reply_id: string;
  application_id: number;
  stage_id: number;
}): string {
  return `hm_signal:${input.channel_id}:${input.message_ts}:${input.reactor_or_reply_id}:${input.application_id}:${input.stage_id}`;
}

/**
 * Resolves which candidate on a Slack presentation post a positive signal applies to,
 * enforcing Ruling 3:
 * - Emoji reactions (`:thumbsup:`) are valid ONLY on single-candidate posts.
 * - Multi-candidate slates require a thread reply explicitly naming the candidate (or application ID).
 */
export function resolveCandidateFromSlackPost(input: {
  signal_type: 'reaction' | 'reply';
  reaction_emoji?: string;
  reply_text?: string;
  message_candidates: SlateCandidateItem[];
}): {
  ok: boolean;
  candidate?: SlateCandidateItem;
  reason?:
    | 'EMPTY_CANDIDATE_LIST'
    | 'UNRECOGNIZED_REACTION_EMOJI'
    | 'MULTI_CANDIDATE_EMOJI_AMBIGUOUS'
    | 'REPLY_CANDIDATE_NOT_NAMED_OR_AMBIGUOUS'
    | 'NEGATIVE_OR_NON_POSITIVE_REPLY';
} {
  if (!input.message_candidates || input.message_candidates.length === 0) {
    return { ok: false, reason: 'EMPTY_CANDIDATE_LIST' };
  }

  if (input.signal_type === 'reaction') {
    const cleanEmoji = (input.reaction_emoji ?? '').replace(/^:+|:+$/g, '').toLowerCase();
    if (!POSITIVE_EMOJI_REACTIONS.has(cleanEmoji)) {
      return { ok: false, reason: 'UNRECOGNIZED_REACTION_EMOJI' };
    }
    if (input.message_candidates.length > 1) {
      return { ok: false, reason: 'MULTI_CANDIDATE_EMOJI_AMBIGUOUS' };
    }
    return { ok: true, candidate: input.message_candidates[0] };
  }

  // Thread reply
  const reply = (input.reply_text ?? '').trim();
  const replyLower = reply.toLowerCase();
  if (!replyLower) {
    return { ok: false, reason: 'NEGATIVE_OR_NON_POSITIVE_REPLY' };
  }

  // Reject questions or negative/pass/hold replies
  if (
    /\?/.test(reply) ||
    /\b(no|not|pass|reject|do\s+not\s+advance|don't\s+advance|dont\s+advance|hold|skip|wait|defer|later|no\s+hire)\b/i.test(
      reply,
    )
  ) {
    return { ok: false, reason: 'NEGATIVE_OR_NON_POSITIVE_REPLY' };
  }

  // Require positive advance / routing intent in the reply
  const cleanReplyToken = reply.replace(/^:+|:+$/g, '').toLowerCase();
  const hasPositiveIntent =
    POSITIVE_EMOJI_REACTIONS.has(cleanReplyToken) ||
    /(?:^|\s|:)\+1(?:\b|\s|:|$)|👍|✅|🚀|🔥|💯/i.test(reply) ||
    /\b(advance|move|yes|proceed|schedule|interview|tech\s*screen|manager\s*screen|assessment|take[-\s]*home|coding\s+challenge|khiem|lgtm|approved|let's\s+chat|lets\s+chat|good\s+to\s+go|thumbsup|white_check_mark|heavy_check_mark|rocket)\b/i.test(
      reply,
    );
  if (!hasPositiveIntent) {
    return { ok: false, reason: 'NEGATIVE_OR_NON_POSITIVE_REPLY' };
  }

  if (input.message_candidates.length === 1) {
    return { ok: true, candidate: input.message_candidates[0] };
  }

  // Multi-candidate slate: check exact full-name or application_id matches first
  // so candidates sharing a first or last name (e.g. "Alex Kim" vs "Blake Kim")
  // disambiguate cleanly when the full name is written.
  const exactMatches = input.message_candidates.filter(cand => {
    const fullLower = cand.candidate_name.toLowerCase().trim();
    if (fullLower && replyLower.includes(fullLower)) return true;
    if (new RegExp(`\\b${escapeRegExp(String(cand.application_id))}\\b`).test(reply)) return true;
    return false;
  });
  if (exactMatches.length === 1) {
    return { ok: true, candidate: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    return { ok: false, reason: 'REPLY_CANDIDATE_NOT_NAMED_OR_AMBIGUOUS' };
  }

  // Fall back to unique first or last name token match
  const matched = input.message_candidates.filter(cand => {
    const fullLower = cand.candidate_name.toLowerCase().trim();
    const parts = fullLower.split(/\s+/).filter(p => p.length >= 2);
    const first = parts[0];
    const last = parts.length > 1 ? parts[parts.length - 1] : null;
    if (first && new RegExp(`\\b${escapeRegExp(first)}\\b`, 'i').test(reply)) return true;
    if (last && new RegExp(`\\b${escapeRegExp(last)}\\b`, 'i').test(reply)) return true;
    return false;
  });

  if (matched.length !== 1) {
    return { ok: false, reason: 'REPLY_CANDIDATE_NOT_NAMED_OR_AMBIGUOUS' };
  }

  return { ok: true, candidate: matched[0] };
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Dynamically resolves the target stage after `Hiring Manager Review` (or `current_stage_id`)
 * using the job's ordered stages and HM routing instructions.
 */
export function resolveNextStageForHmSignal(input: {
  current_stage_id: number;
  reply_text?: string;
  explicit_target_stage_id?: number;
  default_route_after_hm_review?: 'turing_assessment' | 'manager_tech_screen';
  job_stages?: readonly JobStageMetadata[];
  stage_has_auto_email_rule?: boolean;
  stage_auto_email_rules?: Record<number, boolean>;
}): {
  target_stage_id: number;
  target_stage_name: string;
  route_kind: 'turing_assessment' | 'manager_tech_screen' | 'next_stage';
  stage_has_auto_email_rule: boolean;
} {
  const stages = [...(input.job_stages ?? PILOT_JOB_ORDERED_STAGES)].sort(
    (a, b) => a.priority - b.priority,
  );
  const byId = new Map<number, JobStageMetadata>(stages.map(s => [s.id, s]));

  let targetStage: JobStageMetadata | undefined;
  let routeKind: 'turing_assessment' | 'manager_tech_screen' | 'next_stage' = 'next_stage';

  const reply = (input.reply_text ?? '').trim();

  const currentIdx = stages.findIndex(s => s.id === input.current_stage_id);
  const laterStages = currentIdx >= 0 ? stages.slice(currentIdx + 1) : stages;

  if (input.explicit_target_stage_id !== undefined) {
    targetStage = byId.get(input.explicit_target_stage_id) ?? {
      id: input.explicit_target_stage_id,
      name: `Stage ${input.explicit_target_stage_id}`,
      priority: 99,
    };
  } else if (
    /\b(tech\s*screen|manager\s*screen|manager\s*\/\s*tech|khiem|direct\s+to\s+screen|skip\s+assessment)\b/i.test(
      reply,
    )
  ) {
    targetStage =
      laterStages.find(s => /manager\s*\/\s*tech|tech\s*screen/i.test(s.name)) ??
      stages.find(s => /manager\s*\/\s*tech|tech\s*screen/i.test(s.name)) ??
      byId.get(MANAGER_TECH_SCREEN_STAGE_ID);
  } else if (
    /\b(turing\s*assessment|take[-\s]*home|assessment|coding\s+challenge)\b/i.test(reply)
  ) {
    targetStage =
      laterStages.find(s => /assessment/i.test(s.name)) ??
      stages.find(s => /assessment/i.test(s.name)) ??
      byId.get(TURING_ASSESSMENT_STAGE_ID);
  } else if (
    input.current_stage_id === HIRING_MANAGER_REVIEW_STAGE_ID &&
    input.default_route_after_hm_review === 'manager_tech_screen'
  ) {
    targetStage =
      laterStages.find(s => /manager\s*\/\s*tech|tech\s*screen/i.test(s.name)) ??
      stages.find(s => /manager\s*\/\s*tech|tech\s*screen/i.test(s.name)) ??
      byId.get(MANAGER_TECH_SCREEN_STAGE_ID);
  } else {
    if (currentIdx >= 0 && currentIdx + 1 < stages.length) {
      targetStage = stages[currentIdx + 1];
    } else {
      targetStage = byId.get(TURING_ASSESSMENT_STAGE_ID) ?? stages[0];
    }
  }

  const resolvedStage = targetStage ?? {
    id: TURING_ASSESSMENT_STAGE_ID,
    name: 'Turing Assessment',
    priority: 4,
  };

  if (
    resolvedStage.id === TURING_ASSESSMENT_STAGE_ID ||
    /assessment/i.test(resolvedStage.name)
  ) {
    routeKind = 'turing_assessment';
  } else if (
    resolvedStage.id === MANAGER_TECH_SCREEN_STAGE_ID ||
    /manager|tech\s*screen/i.test(resolvedStage.name)
  ) {
    routeKind = 'manager_tech_screen';
  }

  const autoEmailRule =
    input.stage_has_auto_email_rule !== undefined
      ? input.stage_has_auto_email_rule
      : input.stage_auto_email_rules?.[resolvedStage.id] !== undefined
        ? Boolean(input.stage_auto_email_rules[resolvedStage.id])
        : Boolean(resolvedStage.has_auto_email_rule);

  return {
    target_stage_id: resolvedStage.id,
    target_stage_name: resolvedStage.name,
    route_kind: routeKind,
    stage_has_auto_email_rule: autoEmailRule,
  };
}

export function buildWf3CandidateOutreachDraft(input: {
  candidate_name: string;
  job_name: string;
  route_kind: 'turing_assessment' | 'manager_tech_screen' | 'next_stage';
  target_stage_name: string;
  designated_interviewer_name: string;
}): { subject: string; body_html: string } {
  const firstName = input.candidate_name.split(/\s+/)[0] || input.candidate_name;
  if (input.route_kind === 'turing_assessment') {
    return {
      subject: `Next Steps with Turing — ${input.job_name} (Turing Assessment)`,
      body_html: `<p>Hi ${firstName},</p><p>Great speaking with you! Our hiring team reviewed your profile for the <strong>${input.job_name}</strong> role and would love to invite you to the <strong>${input.target_stage_name}</strong> stage.</p><p>Please let us know once you have completed the assessment or if you have any questions.</p><p>Best,<br/>Sam Vangelos</p>`,
    };
  }
  return {
    subject: `Interview Availability — ${input.job_name} (${input.target_stage_name})`,
    body_html: `<p>Hi ${firstName},</p><p>Our hiring manager reviewed your profile for the <strong>${input.job_name}</strong> role and would love to schedule your <strong>${input.target_stage_name}</strong> with ${input.designated_interviewer_name}.</p><p>Could you share a few times over the next few business days that work well for you (including your time zone)?</p><p>Best,<br/>Sam Vangelos</p>`,
  };
}

/**
 * Evaluates a Slack HM positive signal (emoji reaction or thread reply):
 * 1. Enforces Ruling 3 (emoji reaction valid only on single-candidate posts; multi-candidate slates require explicit name in reply).
 * 2. Verifies the candidate is currently in `Hiring Manager Review` (`12579938004`, or expected stage).
 * 3. Claims the single-consumption signal key `hm_signal:{channel_id}:{message_ts}:{reactor_or_reply_id}:{application_id}:{stage_id}`
 *    at most once per `(application_id, stage_id)`.
 * 4. Dynamically routes to `Turing Assessment` (`12579939004`) or `Manager / Tech Screen` (`12579940004`),
 *    suppressing Gmail candidate outreach when `stage_has_auto_email_rule === true`.
 */
export function evaluateHmPositiveSignal(
  store: SqliteCoordinatorStore,
  input: EvaluateHmSignalInput,
): {
  action:
    | 'proposed_advance'
    | 'noop_duplicate_or_consumed'
    | 'noop_wrong_stage'
    | 'blocked_multi_candidate_emoji_ambiguous'
    | 'ignored_non_positive_or_unresolved';
  reason?: string;
  signal_key?: string;
  hm_signal_row?: HmSignalRow;
  episode?: EpisodeRow<Workflow3EpisodeState>;
  approval?: ApprovalRow;
} {
  const now = input.now ?? new Date().toISOString();
  if (input.reactor_or_reply_id === 'U07RJJ6RLN6' && !input.allow_self_signal) {
    return {
      action: 'ignored_non_positive_or_unresolved',
      reason: 'SELF_SIGNAL_IGNORED',
    };
  }

  const resolvedCand = resolveCandidateFromSlackPost({
    signal_type: input.signal_type,
    reaction_emoji: input.reaction_emoji,
    reply_text: input.reply_text,
    message_candidates: input.message_candidates,
  });

  if (!resolvedCand.ok || !resolvedCand.candidate) {
    if (resolvedCand.reason === 'MULTI_CANDIDATE_EMOJI_AMBIGUOUS') {
      return {
        action: 'blocked_multi_candidate_emoji_ambiguous',
        reason:
          'Emoji reaction on a multi-candidate slate is ambiguous (Ruling 3); reply in thread naming the specific candidate.',
      };
    }
    return {
      action: 'ignored_non_positive_or_unresolved',
      reason: resolvedCand.reason,
    };
  }

  const candidate = resolvedCand.candidate;
  const currentStageId = candidate.current_stage_id;

  // Verify the candidate has not already moved past Hiring Manager Review
  if (currentStageId !== HIRING_MANAGER_REVIEW_STAGE_ID) {
    return {
      action: 'noop_wrong_stage',
      reason: `Candidate application ${candidate.application_id} is in stage ${currentStageId}, not Hiring Manager Review (${HIRING_MANAGER_REVIEW_STAGE_ID}).`,
    };
  }

  const signalKey = buildHmSignalKey({
    channel_id: input.channel_id,
    message_ts: input.message_ts,
    reactor_or_reply_id: input.reactor_or_reply_id,
    application_id: candidate.application_id,
    stage_id: currentStageId,
  });

  const route = resolveNextStageForHmSignal({
    current_stage_id: currentStageId,
    reply_text: input.reply_text,
    explicit_target_stage_id: input.explicit_target_stage_id,
    default_route_after_hm_review: input.default_route_after_hm_review,
    job_stages: input.job_stages,
    stage_has_auto_email_rule: input.stage_has_auto_email_rule,
    stage_auto_email_rules: input.stage_auto_email_rules,
  });

  const episodeId = `wf3:${candidate.application_id}:${currentStageId}`;
  const chainId = `wf3_chain:${candidate.application_id}:${currentStageId}:${route.target_stage_id}`;

  const claimRes = store.claimHmSignal({
    signal_key: signalKey,
    application_id: candidate.application_id,
    stage_id: currentStageId,
    channel_id: input.channel_id,
    message_ts: input.message_ts,
    reactor_or_reply_id: input.reactor_or_reply_id,
    target_stage_id: route.target_stage_id,
    episode_id: episodeId,
    details: {
      signal_type: input.signal_type,
      reaction_emoji: input.reaction_emoji ?? null,
      reply_text: input.reply_text ?? null,
      route_kind: route.route_kind,
      stage_has_auto_email_rule: route.stage_has_auto_email_rule,
    },
    now,
  });

  if (!claimRes.claimed) {
    return {
      action: 'noop_duplicate_or_consumed',
      reason: claimRes.reason,
      signal_key: signalKey,
      hm_signal_row: claimRes.row,
    };
  }

  const jobId = input.job_id ?? PILOT_JOB_ID;
  const jobName = input.job_name ?? 'Field Engineer, AI Labs - US';
  const interviewerId = input.designated_interviewer_id ?? KHIEM_DOAN_USER_ID;
  const interviewerName = input.designated_interviewer_name ?? 'Khiem Doan';

  const suppressOutreach = route.stage_has_auto_email_rule;
  const outreachDraft = suppressOutreach
    ? null
    : buildWf3CandidateOutreachDraft({
        candidate_name: candidate.candidate_name,
        job_name: jobName,
        route_kind: route.route_kind,
        target_stage_name: route.target_stage_name,
        designated_interviewer_name: interviewerName,
      });

  const state: Workflow3EpisodeState = {
    signal_key: signalKey,
    channel_id: input.channel_id,
    message_ts: input.message_ts,
    reactor_or_reply_id: input.reactor_or_reply_id,
    signal_type: input.signal_type,
    application_id: candidate.application_id,
    candidate_id: candidate.candidate_id ?? null,
    candidate_name: candidate.candidate_name,
    candidate_email: candidate.candidate_email,
    job_id: jobId,
    job_name: jobName,
    from_stage_id: currentStageId,
    target_stage_id: route.target_stage_id,
    target_stage_name: route.target_stage_name,
    route_kind: route.route_kind,
    stage_has_auto_email_rule: route.stage_has_auto_email_rule,
    suppress_outreach_email: suppressOutreach,
    outreach_subject: outreachDraft?.subject ?? null,
    outreach_body_html: outreachDraft?.body_html ?? null,
    designated_interviewer_id: interviewerId,
    designated_interviewer_name: interviewerName,
    gmail_thread_id: input.gmail_thread_id ?? null,
    gmail_last_message_id: input.gmail_last_message_id ?? null,
    chain_id: chainId,
  };

  const episode = store.upsertEpisode<Workflow3EpisodeState>({
    episode_id: episodeId,
    workflow: 'wf3_hm_signal',
    application_id: candidate.application_id,
    candidate_id: candidate.candidate_id ?? null,
    job_id: jobId,
    stage_id: currentStageId,
    status: 'PENDING_APPROVAL',
    state,
    now,
  });

  const expectedState: ExpectedFreshState = {
    application_id: candidate.application_id,
    application_status: ['active', 'in_process'],
    stage_id: currentStageId,
    require_no_reaction_removal: true,
    require_no_hm_override: true,
    ...(input.gmail_last_message_id ? { gmail_last_message_id: input.gmail_last_message_id } : {}),
  };

  const approval = store.registerProposal({
    episode_id: episodeId,
    action_key: chainId,
    chain_id: chainId,
    workflow: 'wf3_hm_signal',
    params: {
      signal_key: signalKey,
      application_id: candidate.application_id,
      from_stage_id: currentStageId,
      target_stage_id: route.target_stage_id,
      target_stage_name: route.target_stage_name,
      route_kind: route.route_kind,
      stage_has_auto_email_rule: route.stage_has_auto_email_rule,
      suppress_outreach_email: suppressOutreach,
      outreach_subject: outreachDraft?.subject ?? null,
    },
    expected_state: expectedState,
    draft_sha256: outreachDraft ? sha256(outreachDraft.body_html) : null,
    now,
  });

  store.clearPendingChainSteps(chainId);
  store.supersedeApprovalsForEpisode(episodeId, 'Superseded by updated WF3 HM signal proposal', {
    keepProposalHash: approval.proposal_hash,
    now,
  });

  return {
    action: 'proposed_advance',
    signal_key: signalKey,
    hm_signal_row: claimRes.row,
    episode,
    approval,
  };
}

export function buildWorkflow3Steps(
  state: Workflow3EpisodeState,
  executor: DeterministicExecutor,
): ChainStepDefinition[] {
  const steps: ChainStepDefinition[] = [
    {
      step_index: 10,
      step_key: 'advance_application_stage',
      action_key: `wf3_stage_move:${state.application_id}:${state.target_stage_id}`,
      service: 'greenhouse',
      operation: 'application_stage_move',
      buildInput: () => ({
        application_id: state.application_id,
        to_stage_id: state.target_stage_id,
        email_from_user_id: SAM_GREENHOUSE_USER_ID,
      }),
    },
  ];

  // Double-email prevention: only send Gmail candidate outreach if the target stage
  // does NOT have an automated Greenhouse stage-transition email rule configured.
  if (!state.suppress_outreach_email && state.outreach_body_html && state.outreach_subject) {
    steps.push(
      {
        step_index: 20,
        step_key: 'send_candidate_outreach_email',
        action_key: `wf3_outreach_email:${state.application_id}:${state.target_stage_id}`,
        service: 'gmail',
        operation: 'users.messages.send',
        outboundBody: (_ctx, input) => String(input.htmlBody ?? ''),
        buildInput: () => ({
          to: state.candidate_email,
          from: SAM_EMAIL,
          subject: state.outreach_subject!,
          htmlBody: state.outreach_body_html!,
          ...(state.gmail_thread_id ? { threadId: state.gmail_thread_id } : {}),
        }),
        execute: async (_ctx, input) => {
          if (!executor.gmail) {
            throw new Error('No GmailProvider configured for send_candidate_outreach_email.');
          }
          const res = await executor.gmail.sendMessage({
            to: String(input.to),
            from: String(input.from ?? SAM_EMAIL),
            subject: String(input.subject),
            htmlBody: String(input.htmlBody),
            threadId: input.threadId ? String(input.threadId) : undefined,
          });
          return {
            provider_id: res.message_id,
            output: {
              message_id: res.message_id,
              thread_id: res.thread_id ?? state.gmail_thread_id,
            },
          };
        },
        reconcile: async (_ctx: ChainStepContext, stepRow: ChainStepRow) => {
          if (stepRow.provider_id) {
            return {
              reconciled: true,
              provider_id: stepRow.provider_id,
              output: stepRow.output,
            };
          }
          return { reconciled: false };
        },
      },
      {
        step_index: 30,
        step_key: 'log_outreach_email_note',
        action_key: `wf3_email_note:${state.application_id}:${state.target_stage_id}`,
        service: 'greenhouse',
        operation: 'candidate_note_create',
        buildInput: () => ({
          application_id: state.application_id,
          body: `Per Sam Vangelos — assistant acted: Advanced to ${state.target_stage_name} after HM positive signal in Slack (${state.signal_key}) and sent candidate outreach email ("${state.outreach_subject}").`,
          visibility: 'admin_only',
          note_type: 'EMAIL',
          subject: state.outreach_subject!,
          email_from: [SAM_EMAIL],
          email_to: [state.candidate_email],
          email_cc: [],
        }),
      },
    );
  } else {
    steps.push({
      step_index: 20,
      step_key: 'log_stage_advance_note',
      action_key: `wf3_advance_note:${state.application_id}:${state.target_stage_id}`,
      service: 'greenhouse',
      operation: 'candidate_note_create',
      buildInput: () => ({
        application_id: state.application_id,
        body: `Per Sam Vangelos — assistant acted: Advanced to ${state.target_stage_name} after HM positive signal in Slack (${state.signal_key}). Separate Gmail outreach suppressed because stage has an automated Greenhouse stage-transition email rule.`,
        visibility: 'admin_only',
        note_type: 'NOTE',
      }),
    });
  }

  return steps;
}

/**
 * Executes Workflow 3 stage advance & optional outreach after <= 120s fresh-read verification
 * (including Slack reaction removal and HM override checks).
 */
export async function executeWorkflow3HmSignalChain(
  executor: DeterministicExecutor,
  input: {
    episode_id: string;
    approval?: ApprovalRow | null;
    fresh_snapshot?: FreshReadSnapshot | null | (() => Promise<FreshReadSnapshot>);
  },
): Promise<ExecuteChainResult> {
  const episode = executor.store.getEpisode<Workflow3EpisodeState>(input.episode_id);
  if (!episode) {
    throw new Error(`Unknown WF3 episode '${input.episode_id}'.`);
  }
  const state = episode.state;

  const moveRow = executor.store.getChainStep(state.chain_id, 'advance_application_stage');
  const moveAlreadyDone =
    moveRow != null &&
    (moveRow.status === 'succeeded' ||
      moveRow.status === 'dispatched' ||
      moveRow.status === 'reconciled');

  const emailRow = executor.store.getChainStep(state.chain_id, 'send_candidate_outreach_email');
  const emailAlreadyDone =
    emailRow != null &&
    (emailRow.status === 'succeeded' ||
      emailRow.status === 'dispatched' ||
      emailRow.status === 'reconciled');

  const expectedGmailMessageId = emailAlreadyDone
    ? (emailRow?.provider_id ?? undefined)
    : (state.gmail_last_message_id ?? undefined);

  const expectedState: ExpectedFreshState = {
    application_id: state.application_id,
    application_status: ['active', 'in_process'],
    stage_id: moveAlreadyDone ? state.target_stage_id : state.from_stage_id,
    ...(moveAlreadyDone
      ? {}
      : {
          require_no_reaction_removal: true,
          require_no_hm_override: true,
        }),
    ...(expectedGmailMessageId ? { gmail_last_message_id: expectedGmailMessageId } : {}),
  };

  const steps = buildWorkflow3Steps(state, executor);

  const result = await executor.executeChain({
    chain_id: state.chain_id,
    episode_id: episode.episode_id,
    workflow: 'wf3_hm_signal',
    approval: input.approval ?? null,
    expected_state: expectedState,
    fresh_snapshot: input.fresh_snapshot,
    steps,
  });

  const moveRowAfter = executor.store.getChainStep(state.chain_id, 'advance_application_stage');
  const moveDoneNow =
    moveAlreadyDone ||
    (moveRowAfter != null &&
      (moveRowAfter.status === 'succeeded' ||
        moveRowAfter.status === 'dispatched' ||
        moveRowAfter.status === 'reconciled'));

  if (result.ok) {
    executor.store.updateHmSignalStatus(state.signal_key, 'executed', executor.nowIso());
    executor.store.upsertEpisode<Workflow3EpisodeState>({
      episode_id: episode.episode_id,
      workflow: 'wf3_hm_signal',
      application_id: state.application_id,
      candidate_id: state.candidate_id,
      job_id: state.job_id,
      stage_id: state.target_stage_id,
      status: 'COMPLETED',
      state,
      now: executor.nowIso(),
    });
  } else if (moveDoneNow) {
    // Stage move already committed in Greenhouse — keep the HM signal locked ('executed')
    // and retain the new stage_id so a retry can finish the remaining email/note steps.
    executor.store.updateHmSignalStatus(state.signal_key, 'executed', executor.nowIso());
    executor.store.upsertEpisode<Workflow3EpisodeState>({
      episode_id: episode.episode_id,
      workflow: 'wf3_hm_signal',
      application_id: state.application_id,
      candidate_id: state.candidate_id,
      job_id: state.job_id,
      stage_id: state.target_stage_id,
      status: 'PARTIAL_FAILED',
      state,
      now: executor.nowIso(),
    });
  } else if (result.status === 'aborted_stale') {
    const isTransientSnapshotStale = Boolean(result.reason?.startsWith('STALE_SNAPSHOT:'));
    if (!isTransientSnapshotStale) {
      executor.store.updateHmSignalStatus(state.signal_key, 'aborted_stale', executor.nowIso());
      executor.store.upsertEpisode<Workflow3EpisodeState>({
        episode_id: episode.episode_id,
        workflow: 'wf3_hm_signal',
        application_id: state.application_id,
        candidate_id: state.candidate_id,
        job_id: state.job_id,
        stage_id: state.from_stage_id,
        status: 'ABORTED_STALE',
        state,
        now: executor.nowIso(),
      });
    }
  }

  return result;
}
