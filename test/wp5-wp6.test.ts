import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  type ActionApplyResponse,
  type ActionPreviewResponse,
  type ActionServiceLike,
  DeterministicExecutor,
  type FreshReadSnapshot,
  type GmailProvider,
  normalizeGreenhousePreviewInput,
  SAM_GREENHOUSE_USER_ID,
  type SlackProvider,
} from '../src/executor/index.ts';
import { SqliteCoordinatorStore } from '../src/store/sqlite.ts';
import {
  APPLICATION_REVIEW_STAGE_ID,
  capturePendingWf2DraftDuringJobMappingHold,
  computeBookingFingerprint,
  executeWorkflow1IntakeChain,
  handleJobMappingUrgentReminderTimer,
  ingestBookingSignal,
  resolveJobMapping,
  roundTo5MinIso,
  SAM_REFERRER_ID,
} from '../src/workflows/wf1-intake.ts';
import {
  adaptSystemsAdminDraftToScorecardSubmit,
  executeWorkflow2ChainD,
  FIELD_ENGINEERING_HIRING_CHANNEL_ID,
  handleManualNotesExpiryOrCompletion,
  handleMissingNotesPromptTimer,
  HIRING_MANAGER_REVIEW_STAGE_ID,
  PILOT_JOB_ID,
  prepareWorkflow2ScorecardProposal,
  RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID,
  RECRUITER_PHONE_SCREEN_KIT_ID,
  RECRUITER_PHONE_SCREEN_STAGE_ID,
  SAM_SLACK_USER_ID,
  scheduleMissingNotesWatch,
  type SystemsAdminScorecardDraft,
  validateSystemsAdminScorecardDraft,
} from '../src/workflows/wf2-scorecard.ts';
import {
  buildHmSignalKey,
  evaluateHmPositiveSignal,
  executeWorkflow3HmSignalChain,
  MANAGER_TECH_SCREEN_STAGE_ID,
  TURING_ASSESSMENT_STAGE_ID,
} from '../src/workflows/wf3-hm-signal.ts';
import {
  evaluateMissingOwnerHygiene,
  evaluateStageDriftRepair,
  executeMissingOwnerHygiene,
  executeStageDriftRepair,
  executeWorkflow5AChainE,
  prepareWorkflow5ACrossReqProposal,
} from '../src/workflows/wf5-grooming.ts';
import { runExecutorTick } from '../worker/executor-tick.mjs';

function makeTempDir(prefix = 'wp5-wp6-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTestHarness(fixedNowIso = '2026-06-15T18:00:00.000Z') {
  const dataDir = makeTempDir();
  const store = new SqliteCoordinatorStore(dataDir);
  let currentNow = new Date(fixedNowIso);

  const previewCalls: Array<{
    kind: string;
    input: Record<string, unknown>;
    actor: any;
    client: any;
  }> = [];
  const applyCalls: Array<{
    kind: string;
    request: any;
    extraPayloadOrActor: any;
    client: any;
  }> = [];
  const slackCalls: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const gmailCalls: Array<{
    to: string;
    from?: string;
    subject: string;
    htmlBody: string;
    threadId?: string;
  }> = [];

  let nextResourceId = 80001;
  let customPreviewHandler:
    | ((kind: string, input: Record<string, unknown>) => Promise<ActionPreviewResponse | null>)
    | null = null;
  let customApplyHandler:
    | ((kind: string, req: any, extra?: any) => Promise<ActionApplyResponse | null>)
    | null = null;

  const actionService: ActionServiceLike = {
    async preview(kind, input, actor, client) {
      previewCalls.push({ kind, input, actor, client });
      if (customPreviewHandler) {
        const custom = await customPreviewHandler(kind, input);
        if (custom) return custom;
      }
      return {
        status: 'ready',
        changeRequired: true,
        intent: { kind, input },
        approval: { token: `tok_${kind}` },
      };
    },
    async apply(kind, request, extraPayloadOrActor, client) {
      applyCalls.push({ kind, request, extraPayloadOrActor, client });
      if (customApplyHandler) {
        const custom = await customApplyHandler(kind, request, extraPayloadOrActor);
        if (custom) return custom;
      }
      const id = nextResourceId++;
      return {
        status: 'applied',
        state: 'succeeded',
        result_resource_id: id,
        provider_id: String(id),
        result: { id },
      };
    },
  };

  const slack: SlackProvider = {
    async sendMessage(input) {
      slackCalls.push(input);
      return {
        ts: `1750000.${slackCalls.length}`,
        channel: input.channel,
      };
    },
  };

  const gmail: GmailProvider = {
    async sendMessage(input) {
      gmailCalls.push(input);
      return {
        message_id: `msg_${gmailCalls.length}`,
        thread_id: input.threadId ?? `thr_${gmailCalls.length}`,
      };
    },
  };

  const executor = new DeterministicExecutor({
    store,
    dataDir,
    actionService,
    slack,
    gmail,
    now: () => currentNow,
  });

  return {
    dataDir,
    store,
    executor,
    previewCalls,
    applyCalls,
    slackCalls,
    gmailCalls,
    setNow: (iso: string) => {
      currentNow = new Date(iso);
    },
    setCustomPreview: (
      fn: ((kind: string, input: Record<string, unknown>) => Promise<ActionPreviewResponse | null>) | null,
    ) => {
      customPreviewHandler = fn;
    },
    setCustomApply: (
      fn: ((kind: string, req: any, extra?: any) => Promise<ActionApplyResponse | null>) | null,
    ) => {
      customApplyHandler = fn;
    },
    cleanup: () => {
      store.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

// =============================================================================
// Suite 1: Workflow 2 — Granola Screen -> Scorecard Submission + Coupled Step 2
// =============================================================================

describe('WP-5 Workflow 2: Granola Screen -> Scorecard Submission & Coupled Decision (Chain D)', () => {
  const sampleTranscript = [
    'Sam Vangelos: Thanks for joining today, Jordan.',
    'Jordan Vance: Excited to be here. Over the last 6 years I built distributed inference pipelines in Python and Go serving 40 enterprise customers.',
    'Sam Vangelos: How did you handle customer production incidents?',
    'Jordan Vance: I led the on-call rotation and reduced p99 latency by 45 percent across three regions.',
  ].join('\n');

  const sampleSamNotes = [
    'Strong Yes overall. Distributed systems rating: strong_yes. Customer communication: yes.',
    'Candidate is available to start in 3 weeks and targeting $195000 base.',
  ].join('\n');

  it('validates quote-grounding, omits unsupported attributes, and adapts systems-admin draft to scorecard_submit schema', () => {
    const validDraft: SystemsAdminScorecardDraft = {
      transcript: sampleTranscript,
      sam_notes: sampleSamNotes,
      overall_recommendation: 'strong_yes',
      key_takeaways: [
        {
          text: '6 years building distributed inference pipelines in Python and Go for 40 enterprise customers.',
          quote: 'last 6 years I built distributed inference pipelines in Python and Go serving 40 enterprise customers',
        },
        {
          text: 'Reduced p99 latency by 45 percent across three regions.',
          quote: 'reduced p99 latency by 45 percent across three regions',
        },
      ],
      attributes: [
        {
          id: 9001,
          name: 'Distributed Systems',
          value: 'strong_yes',
          note: 'Production Go/Python inference pipelines',
          sam_quote: 'Distributed systems rating: strong_yes',
        },
        {
          id: 9002,
          name: 'Unassessed Attribute (should be omitted, not guessed)',
          value: null,
        },
      ],
      questions: [
        {
          id: 7001,
          label: 'Notice Period',
          text: 'Available to start in 3 weeks.',
          quote: 'Candidate is available to start in 3 weeks',
        },
        {
          id: 7002,
          label: 'Authorized to work in US',
          boolean_value: true,
        },
        {
          id: 7003,
          label: 'Work Arrangement',
          option_ids: [301, 302],
        },
      ],
    };

    const validation = validateSystemsAdminScorecardDraft(validDraft);
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.omitted_attribute_ids, [9002]);

    const mapped = adaptSystemsAdminDraftToScorecardSubmit(validDraft, {
      application_id: 61001,
    });

    assert.equal(mapped.application_id, 61001);
    assert.equal(mapped.job_interview_id, RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID);
    assert.equal(mapped.interview_kit_id, RECRUITER_PHONE_SCREEN_KIT_ID);
    assert.equal(mapped.interviewer_id, SAM_GREENHOUSE_USER_ID);
    assert.equal(mapped.candidate_rating, 'strong_yes');
    assert.equal(mapped.overall_recommendation, 'strong_yes');
    assert.ok(mapped.notes.includes('40 enterprise customers'));
    assert.equal(mapped.attribute_ratings.length, 1);
    assert.deepEqual(mapped.attribute_ratings[0], {
      job_candidate_attribute_id: 9001,
      candidate_attribute_rating: 'strong_yes',
      rating: 'strong_yes',
      note: 'Production Go/Python inference pipelines',
    });
    assert.equal(mapped.question_answers.length, 3);

    // Verify strict action-mcp wire normalization strips non-catalog keys
    const wire = normalizeGreenhousePreviewInput(
      'scorecard_submit',
      mapped as unknown as Record<string, unknown>,
    );
    assert.equal('notes' in wire, false);
    assert.equal('interview_kit_id' in wire, false);
    assert.equal(typeof wire.private_notes, 'string');
    assert.equal(
      'candidate_attribute_rating' in ((wire.attribute_ratings as any[])[0] ?? {}),
      false,
    );
  });

  it('rejects ungrounded claims, fabricated quotes, number mismatches, and non-rating decisions ("Advance")', () => {
    const ungroundedDraft: SystemsAdminScorecardDraft = {
      transcript: sampleTranscript,
      sam_notes: 'Advance to next stage. Not a strong yes yet.',
      overall_recommendation: 'Advance',
      key_takeaways: [
        {
          text: 'Built Kubernetes clusters for 99 enterprise customers.',
          quote: 'last 6 years I built distributed inference pipelines in Python and Go serving 40 enterprise customers',
        },
        {
          text: 'Claim without any quote at all.',
        },
        {
          text: 'Claim with a fabricated quote not in transcript.',
          quote: 'I architected a global Rust compiler team at scale',
        },
      ],
      questions: [
        {
          id: 7001,
          text: 'Free-text answer without a supporting quote',
        },
      ],
    };

    const validation = validateSystemsAdminScorecardDraft(ungroundedDraft);
    assert.equal(validation.ok, false);
    assert.ok(
      validation.errors.some(e => e.includes('Invalid overall_recommendation')),
      'Should reject "Advance" used as a rating',
    );
    assert.ok(
      validation.errors.some(e => e.includes("cites number '99'")),
      'Should reject number in claim that is absent from supporting quote',
    );
    assert.ok(
      validation.errors.some(e => e.includes('missing a verbatim supporting quote')),
      'Should reject unquoted takeaway',
    );
    assert.ok(
      validation.errors.some(e => e.includes('was not found verbatim')),
      'Should reject fabricated quote',
    );
    assert.ok(
      validation.errors.some(e => e.includes('questions[0]')),
      'Should reject unquoted free-text question answer',
    );

    assert.throws(
      () =>
        adaptSystemsAdminDraftToScorecardSubmit(ungroundedDraft, {
          application_id: 61001,
        }),
      (err: any) => err?.code === 'UNGROUNDED_SCORECARD_CLAIM',
    );
  });

  it('executes Chain D advance branch (yes/strong_yes): scorecard_submit -> stage move to 12579938004 -> Slack #field-engineering-hiring post', async () => {
    const h = createTestHarness();
    try {
      const draft: SystemsAdminScorecardDraft = {
        transcript: sampleTranscript,
        sam_notes: sampleSamNotes,
        overall_recommendation: 'strong_yes',
        key_takeaways: [
          {
            text: 'Built distributed inference pipelines for 40 enterprise customers.',
            quote: 'built distributed inference pipelines in Python and Go serving 40 enterprise customers',
          },
        ],
      };

      const prepared = prepareWorkflow2ScorecardProposal(h.store, {
        application_id: 61002,
        candidate_id: 51002,
        candidate_name: 'Jordan Vance',
        job_id: PILOT_JOB_ID,
        interview_ended_at: '2026-06-15T17:30:00.000Z',
        draft,
      });

      assert.equal(prepared.decision_branch, 'advance');
      const approved = h.store.grantApproval({
        proposal_hash: prepared.approval.proposal_hash,
        decision: 'approved',
      });

      const snapshot: FreshReadSnapshot = {
        fetched_at: h.executor.nowIso(),
        application: {
          id: 61002,
          status: 'in_process',
          current_stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
        },
        scorecards: [],
      };

      const result = await executeWorkflow2ChainD(h.executor, {
        episode_id: prepared.episode.episode_id,
        approval: approved,
        fresh_snapshot: snapshot,
      });

      assert.equal(result.ok, true);
      assert.equal(h.previewCalls.length, 2);
      assert.equal(h.previewCalls[0].kind, 'scorecard_submit');
      assert.equal(h.previewCalls[1].kind, 'application_stage_move');
      assert.deepEqual(h.previewCalls[1].input, {
        application_id: 61002,
        to_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        email_from_user_id: SAM_GREENHOUSE_USER_ID,
      });

      assert.equal(h.slackCalls.length, 1);
      assert.equal(h.slackCalls[0].channel, FIELD_ENGINEERING_HIRING_CHANNEL_ID);
      assert.ok(h.slackCalls[0].text.includes('Jordan Vance'));

      const epAfter = h.store.getEpisode(prepared.episode.episode_id);
      assert.equal(epAfter?.status, 'COMPLETED_ADVANCED_TO_HM_REVIEW');
      assert.equal(epAfter?.stage_id, HIRING_MANAGER_REVIEW_STAGE_ID);
    } finally {
      h.cleanup();
    }
  });

  it('executes Chain D reject branch (no/strong_no): scorecard_submit -> enqueues WF4 Chain B deliberated rejection timer', async () => {
    const h = createTestHarness('2026-06-15T18:00:00.000Z');
    try {
      const negativeDraft: SystemsAdminScorecardDraft = {
        transcript: 'Candidate: I have worked exclusively on static HTML templates for 2 years.',
        sam_notes: 'Overall rating: no. Missing production backend engineering depth.',
        overall_recommendation: 'no',
        key_takeaways: [
          {
            text: 'Worked exclusively on static HTML templates for 2 years.',
            quote: 'worked exclusively on static HTML templates for 2 years',
          },
        ],
      };

      const prepared = prepareWorkflow2ScorecardProposal(h.store, {
        application_id: 61003,
        candidate_id: 51003,
        candidate_name: 'Morgan Vale',
        candidate_tz: 'Eastern Time (US & Canada)',
        job_id: PILOT_JOB_ID,
        interview_ended_at: '2026-06-15T17:30:00.000Z',
        draft: negativeDraft,
      });

      assert.equal(prepared.decision_branch, 'reject');
      const approved = h.store.grantApproval({
        proposal_hash: prepared.approval.proposal_hash,
        decision: 'approved',
      });

      const result = await executeWorkflow2ChainD(h.executor, {
        episode_id: prepared.episode.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 61003,
            status: 'in_process',
            current_stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
          },
          scorecards: [],
        },
      });

      assert.equal(result.ok, true);
      assert.equal(h.previewCalls.length, 1);
      assert.equal(h.previewCalls[0].kind, 'scorecard_submit');

      const epAfter = h.store.getEpisode(prepared.episode.episode_id);
      assert.equal(epAfter?.status, 'COMPLETED_REJECTION_DELIBERATION_SCHEDULED');
      const timerKey = epAfter?.state.rejection_timer_key as string;
      assert.ok(timerKey?.startsWith('wf4_reject:61003:'));

      const deliberationTimer = h.store.getTimer(timerKey);
      assert.ok(deliberationTimer);
      assert.equal(deliberationTimer?.status, 'pending');
    } finally {
      h.cleanup();
    }
  });

  it('resumes Coupled Step 2 after a crash between Step 1 (scorecard_submit) and Step 2 even when live scan now shows a completed scorecard', async () => {
    const h = createTestHarness();
    try {
      const draft: SystemsAdminScorecardDraft = {
        transcript: sampleTranscript,
        sam_notes: sampleSamNotes,
        overall_recommendation: 'yes',
        key_takeaways: [
          {
            text: 'Reduced p99 latency by 45 percent across three regions.',
            quote: 'reduced p99 latency by 45 percent across three regions',
          },
        ],
      };

      const prepared = prepareWorkflow2ScorecardProposal(h.store, {
        application_id: 61004,
        candidate_id: 51004,
        candidate_name: 'Casey Lin',
        job_id: PILOT_JOB_ID,
        interview_ended_at: '2026-06-15T17:30:00.000Z',
        draft,
      });

      const approved = h.store.grantApproval({
        proposal_hash: prepared.approval.proposal_hash,
        decision: 'approved',
      });

      // Simulate crash on Step 2 (application_stage_move) during first run after Step 1 succeeds
      let failStageMoveOnce = true;
      h.setCustomPreview(async kind => {
        if (kind === 'application_stage_move' && failStageMoveOnce) {
          failStageMoveOnce = false;
          throw new Error('Simulated transient network drop right after scorecard_submit');
        }
        return null;
      });

      const firstRun = await executeWorkflow2ChainD(h.executor, {
        episode_id: prepared.episode.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 61004,
            status: 'in_process',
            current_stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
          },
          scorecards: [],
        },
      });

      assert.equal(firstRun.ok, false);
      assert.equal(firstRun.failed_step_key, 'advance_to_hm_review');
      const epMid = h.store.getEpisode(prepared.episode.episode_id);
      assert.equal(epMid?.status, 'PARTIAL_STEP1_COMPLETE_STEP2_PENDING');

      // On the next scan/resume, Greenhouse now returns the completed scorecard from Step 1!
      // Verify Step 2 still runs to completion without re-running Step 1 or failing the incomplete-scorecard gate.
      const secondRun = await executeWorkflow2ChainD(h.executor, {
        episode_id: prepared.episode.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 61004,
            status: 'in_process',
            current_stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
          },
          scorecards: [
            {
              id: 80001,
              application_id: 61004,
              stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
              interviewer: { id: SAM_GREENHOUSE_USER_ID },
              status: 'complete',
              overall_recommendation: 'yes',
            },
          ],
        },
      });

      assert.equal(secondRun.ok, true);
      // Step 1 was NOT re-executed; only Step 2 + Slack post ran on resume
      const scorecardSubmitApplies = h.applyCalls.filter(c => c.kind === 'scorecard_submit');
      assert.equal(scorecardSubmitApplies.length, 1);
      assert.equal(h.slackCalls.length, 1);

      const epFinal = h.store.getEpisode(prepared.episode.episode_id);
      assert.equal(epFinal?.status, 'COMPLETED_ADVANCED_TO_HM_REVIEW');
    } finally {
      h.cleanup();
    }
  });

  it('handles AWAITING_MANUAL_NOTES at ends_at + 95m and transitions to CLOSED_MANUAL after 5 business days or manual scorecard submission', async () => {
    const h = createTestHarness('2026-06-15T16:00:00.000Z');
    try {
      const watch = scheduleMissingNotesWatch(h.store, {
        application_id: 61005,
        candidate_name: 'Riley Chen',
        interview_ends_at: '2026-06-15T16:00:00.000Z',
        now: h.executor.nowIso(),
      });

      assert.equal(watch.timer.fire_at, '2026-06-15T17:35:00.000Z'); // +95m

      // Advance clock to ends_at + 95m
      h.setNow('2026-06-15T17:36:00.000Z');
      const promptRes = await handleMissingNotesPromptTimer(watch.timer, h.executor, {
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 61005,
            status: 'in_process',
            current_stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
          },
          scorecards: [],
        },
      });

      assert.equal(promptRes.outcome, 'prompted_sam');
      assert.equal(h.slackCalls.length, 1);
      assert.equal(h.slackCalls[0].channel, SAM_SLACK_USER_ID);
      assert.equal(
        h.store.getEpisode(watch.episode.episode_id)?.status,
        'AWAITING_MANUAL_NOTES',
      );
      assert.ok(promptRes.expiry_timer);

      // Transition to CLOSED_MANUAL upon expiry
      const closed = await handleManualNotesExpiryOrCompletion(h.store, {
        episode_id: watch.episode.episode_id,
        timer_key: promptRes.expiry_timer?.timer_key,
        now: promptRes.expiry_timer?.fire_at,
      });
      assert.equal(closed.status, 'CLOSED_MANUAL');
    } finally {
      h.cleanup();
    }
  });
});

// =============================================================================
// Suite 2: Workflow 1 — Candidate Books Time with Sam (Intake & Chain C)
// =============================================================================

describe('WP-5 Workflow 1: Candidate Books Time with Sam (3-Signal Correlation, Hold, Chain C)', () => {
  it('correlates Calendly, Gmail, and Google Calendar signals via booking_fingerprint and updates in place on reschedule or cancel', () => {
    const h = createTestHarness();
    try {
      const fp1 = computeBookingFingerprint('alex.rivera@example.com', '2026-06-20T18:01:12.000Z');
      const fp2 = computeBookingFingerprint('Alex.Rivera@example.com ', '2026-06-20T18:00:00.000Z');
      assert.equal(roundTo5MinIso('2026-06-20T18:01:12.000Z'), '2026-06-20T18:00:00.000Z');
      assert.equal(fp1, fp2);

      // Signal 1: Gmail booking confirmation (no invitee_uri yet)
      const s1 = ingestBookingSignal(h.store, {
        source: 'gmail',
        gmail_message_id: 'gmail_msg_01',
        candidate_email: 'Alex.Rivera@example.com',
        full_name: 'Alex Rivera',
        starts_at: '2026-06-20T18:01:00.000Z',
        ends_at: '2026-06-20T18:30:00.000Z',
        job_id: PILOT_JOB_ID,
      });
      assert.equal(s1.correlated_existing, false);

      // Signal 2: Google Calendar event (matched via booking_fingerprint)
      const s2 = ingestBookingSignal(h.store, {
        source: 'calendar',
        calendar_event_id: 'gcal_evt_99',
        ical_uid: 'ical_99@google.com',
        candidate_email: 'alex.rivera@example.com',
        starts_at: '2026-06-20T18:00:00.000Z',
        ends_at: '2026-06-20T18:30:00.000Z',
        video_conferencing_url: 'https://meet.google.com/abc-defg-hij',
      });
      assert.equal(s2.correlated_existing, true);
      assert.equal(s2.episode.episode_id, s1.episode.episode_id);

      // Signal 3: Calendly API enrichment with invitee_uri, phone, LinkedIn, and resume
      const resumeBytes = Buffer.from('Sample Fictional Resume PDF Content for Alex Rivera', 'utf8');
      const s3 = ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/ev1/invitees/inv1',
        candidate_email: 'alex.rivera@example.com',
        phone: '+1-415-555-0142',
        linkedin_url: 'https://www.linkedin.com/in/alex-rivera-fictional',
        starts_at: '2026-06-20T18:00:00.000Z',
        ends_at: '2026-06-20T18:30:00.000Z',
        resume_filename: 'alex_rivera_resume.pdf',
        resume_base64: resumeBytes.toString('base64'),
      });
      assert.equal(s3.correlated_existing, true);
      assert.equal(s3.episode.episode_id, s1.episode.episode_id);
      assert.deepEqual(s3.episode.state.signals_received.sort(), [
        'calendar',
        'calendly',
        'gmail',
      ]);

      // Reschedule in place via invitee_uri
      const rescheduled = ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/ev1/invitees/inv2',
        old_invitee_uri: 'https://api.calendly.com/scheduled_events/ev1/invitees/inv1',
        candidate_email: 'alex.rivera@example.com',
        starts_at: '2026-06-21T19:00:00.000Z',
        ends_at: '2026-06-21T19:30:00.000Z',
        status: 'rescheduled',
      });
      assert.equal(rescheduled.correlated_existing, true);
      assert.equal(rescheduled.was_rescheduled, true);
      assert.equal(rescheduled.episode.episode_id, s1.episode.episode_id);
      assert.equal(rescheduled.episode.state.reschedule_count, 1);
      assert.equal(
         h.store.listEpisodes({ workflow: 'wf1_intake' }).length,
        1,
        'Must update existing IntakeEpisode in place rather than spawning a second episode',
      );

      // Cancel in place
      const cancelled = ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/ev1/invitees/inv2',
        candidate_email: 'alex.rivera@example.com',
        starts_at: '2026-06-21T19:00:00.000Z',
        ends_at: '2026-06-21T19:30:00.000Z',
        status: 'canceled',
      });
      assert.equal(cancelled.was_cancelled, true);
      assert.equal(cancelled.episode.status, 'CANCELLED');
    } finally {
      h.cleanup();
    }
  });

  it('enforces Ruling 1 (AWAITING_JOB_MAPPING), fires urgent reminder at starts_at - 2h, captures WF2 Granola draft during hold, and unlocks Chain C + Chain D in sequence when job_id is supplied', async () => {
    const h = createTestHarness('2026-06-15T14:00:00.000Z');
    try {
      const resumeBuf = Buffer.from('Fictional Resume for Taylor Swift-Cloud', 'utf8');
      const ingested = ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/ev2/invitees/inv_hold',
        calendar_event_id: 'gcal_hold_01',
        candidate_email: 'taylor.cloud@example.com',
        first_name: 'Taylor',
        last_name: 'Cloud',
        starts_at: '2026-06-15T17:00:00.000Z',
        ends_at: '2026-06-15T17:30:00.000Z',
        resume_filename: 'taylor_cloud.pdf',
        resume_base64: resumeBuf.toString('base64'),
        job_id: null, // Unmapped Calendly link -> AWAITING_JOB_MAPPING
      });

      assert.equal(ingested.episode.status, 'AWAITING_JOB_MAPPING');
      assert.ok(ingested.urgent_timer);
      assert.equal(ingested.urgent_timer?.fire_at, '2026-06-15T15:00:00.000Z'); // starts_at - 2h

      // Fire urgent reminder at starts_at - 2h
      h.setNow('2026-06-15T15:01:00.000Z');
      const reminderRes = await handleJobMappingUrgentReminderTimer(
        ingested.urgent_timer!,
        h.executor,
      );
      assert.equal(reminderRes.sent, true);
      assert.equal(h.slackCalls.length, 1);
      assert.equal(h.slackCalls[0].channel, SAM_SLACK_USER_ID);

      // Call finishes while still in AWAITING_JOB_MAPPING -> WF2 captures quote-grounded Granola draft!
      h.setNow('2026-06-15T17:40:00.000Z');
      const draftDuringHold: SystemsAdminScorecardDraft = {
        transcript:
          'Taylor Cloud: I designed multi-tenant Kubernetes control planes for 120 financial clients.',
        sam_notes: 'Overall recommendation: strong_yes. Excellent infrastructure depth.',
        overall_recommendation: 'strong_yes',
        key_takeaways: [
          {
            text: 'Designed multi-tenant Kubernetes control planes for 120 financial clients.',
            quote: 'designed multi-tenant Kubernetes control planes for 120 financial clients',
          },
        ],
      };

      const heldWithDraft = capturePendingWf2DraftDuringJobMappingHold(h.store, {
        episode_id: ingested.episode.episode_id,
        draft: draftDuringHold,
        interview_ended_at: '2026-06-15T17:30:00.000Z',
      });
      assert.equal(heldWithDraft.status, 'AWAITING_JOB_MAPPING');
      assert.ok(heldWithDraft.state.pending_wf2_draft);

      // Sam now supplies job_id -> unlocks Chain C and Chain D in sequence!
      const mapped = resolveJobMapping(h.store, {
        episode_id: ingested.episode.episode_id,
        job_id: PILOT_JOB_ID,
      });
      assert.equal(mapped.episode.status, 'PENDING_APPROVAL');
      assert.equal(mapped.has_pending_wf2_draft, true);

      const approvedChainC = h.store.grantApproval({
        proposal_hash: mapped.approval.proposal_hash,
        decision: 'approved',
      });

      const execRes = await executeWorkflow1IntakeChain(h.executor, {
        episode_id: ingested.episode.episode_id,
        approval: approvedChainC,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
        },
      });

      assert.equal(execRes.chain_c_result.ok, true);
      assert.equal(execRes.candidate_id, 80001);
      assert.equal(execRes.application_id, 80002);

      // Verify Chain C steps (candidate_create -> application_create -> attachment_create -> interview_create)
      // AND Chain D steps (scorecard_submit -> application_stage_move -> Slack post) all ran in sequence!
      assert.deepEqual(
        h.previewCalls.map(c => c.kind),
        [
          'candidate_create',
          'application_create',
          'attachment_create',
          'interview_create',
          'scorecard_submit',
          'application_stage_move',
        ],
      );

      // Verify attachment_create received SHA-256 + byte_length in preview and out-of-band base64 payload in apply
      const attachPreview = h.previewCalls.find(c => c.kind === 'attachment_create')!;
      assert.equal(attachPreview.input.application_id, 80002);
      assert.equal(attachPreview.input.byte_length, resumeBuf.byteLength);
      assert.equal(typeof attachPreview.input.content_sha256, 'string');
      const attachApply = h.applyCalls.find(c => c.kind === 'attachment_create')!;
      assert.equal(attachApply.request.payload?.content, resumeBuf.toString('base64'));

      // Verify Chain D unlocked and completed
      assert.equal(execRes.unlocked_wf2?.chain_d_result?.ok, true);
      assert.equal(h.slackCalls.length, 2); // 1 urgent DM + 1 #field-engineering-hiring presentation
      assert.equal(h.slackCalls[1].channel, FIELD_ENGINEERING_HIRING_CHANNEL_ID);
    } finally {
      h.cleanup();
    }
  });

  it('propagates newly returned application_id when Chain C converts an existing prospect application via prospect_convert', async () => {
    const h = createTestHarness();
    try {
      const resumeBuf = Buffer.from('Fictional Prospect Resume Content', 'utf8');
      const ingested = ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/ev3/invitees/inv_prospect',
        calendar_event_id: 'gcal_prospect_01',
        candidate_email: 'devon.prospect@example.com',
        first_name: 'Devon',
        last_name: 'Prospect',
        starts_at: '2026-06-22T18:00:00.000Z',
        ends_at: '2026-06-22T18:30:00.000Z',
        job_id: PILOT_JOB_ID,
        existing_candidate_id: 77001,
        prospect_application_id: 91000, // Old prospect application ID
        resume_filename: 'devon_resume.pdf',
        resume_base64: resumeBuf.toString('base64'),
      });

      // Mock prospect_convert returning a brand-new candidate application_id (92555)
      h.setCustomApply(async kind => {
        if (kind === 'prospect_convert') {
          return {
            status: 'applied',
            state: 'succeeded',
            result_resource_id: 92555,
            provider_id: '92555',
            result: { id: 92555, converted_from_application_id: 91000 },
          };
        }
        return null;
      });

      const approved = h.store.grantApproval({
        proposal_hash: ingested.approval!.proposal_hash,
        decision: 'approved',
      });

      const res = await executeWorkflow1IntakeChain(h.executor, {
        episode_id: ingested.episode.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
        },
      });

      assert.equal(res.chain_c_result.ok, true);
      assert.equal(res.candidate_id, 77001);
      assert.equal(res.application_id, 92555);

      // Existing candidate was reused (no candidate_create preview call)
      assert.deepEqual(
        h.previewCalls.map(c => c.kind),
        ['prospect_convert', 'attachment_create', 'interview_create'],
      );
      assert.deepEqual(h.previewCalls[0].input, {
        application_id: 91000,
        job_id: PILOT_JOB_ID,
        to_job_interview_stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
      });
      // Downstream attachment_create and interview_create MUST use the newly returned 92555 application_id!
      assert.equal(h.previewCalls[1].input.application_id, 92555);
      assert.equal(h.previewCalls[2].input.application_id, 92555);
    } finally {
      h.cleanup();
    }
  });
});

// =============================================================================
// Suite 3: Workflow 3 — Hiring Team Positive Signal in Slack
// =============================================================================

describe('WP-6 Workflow 3: Hiring Team Positive Signal in Slack', () => {
  it('enforces single-consumption per (application_id, stage_id) and Ruling 3 multi-candidate slate disambiguation', () => {
    const h = createTestHarness();
    try {
      // Multi-candidate slate: emoji reaction alone must be rejected (Ruling 3)
      const multiSlate = [
        {
          application_id: 71001,
          candidate_name: 'Avery Brooks',
          candidate_email: 'avery@example.com',
          current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        },
        {
          application_id: 71002,
          candidate_name: 'Blake Kim',
          candidate_email: 'blake@example.com',
          current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        },
      ];

      const ambigRes = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1750010.001',
        reactor_or_reply_id: 'U_HM_01',
        signal_type: 'reaction',
        reaction_emoji: 'thumbsup',
        message_candidates: multiSlate,
      });
      assert.equal(ambigRes.action, 'blocked_multi_candidate_emoji_ambiguous');

      // Thread reply naming "Blake Kim" with "tech screen with Khiem" routes to Manager / Tech Screen (12579940004)
      const namedRes = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1750010.001',
        reactor_or_reply_id: '1750010.099',
        signal_type: 'reply',
        reply_text: 'Let us advance Blake Kim directly to Manager / Tech Screen with Khiem.',
        message_candidates: multiSlate,
      });
      assert.equal(namedRes.action, 'proposed_advance');
      assert.equal(namedRes.episode?.state.application_id, 71002);
      assert.equal(namedRes.episode?.state.target_stage_id, MANAGER_TECH_SCREEN_STAGE_ID);
      assert.equal(
        namedRes.signal_key,
        buildHmSignalKey({
          channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
          message_ts: '1750010.001',
          reactor_or_reply_id: '1750010.099',
          application_id: 71002,
          stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        }),
      );

      // Second positive signal on the same (application_id, stage_id) must be a no-op!
      const duplicateRes = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1750010.001',
        reactor_or_reply_id: '1750010.105',
        signal_type: 'reply',
        reply_text: '+1 on Blake Kim',
        message_candidates: multiSlate,
      });
      assert.equal(duplicateRes.action, 'noop_duplicate_or_consumed');
      assert.equal(duplicateRes.reason, 'STAGE_ALREADY_CONSUMED');
    } finally {
      h.cleanup();
    }
  });

  it('aborts with SLACK_REACTION_REMOVED on <= 120s fresh read when HM removes reaction before execution', async () => {
    const h = createTestHarness();
    try {
      const sig = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1750020.001',
        reactor_or_reply_id: 'U_HM_01',
        signal_type: 'reaction',
        reaction_emoji: '+1',
        message_candidates: [
          {
            application_id: 71003,
            candidate_name: 'Quinn Harper',
            candidate_email: 'quinn@example.com',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        ],
      });
      assert.equal(sig.action, 'proposed_advance');

      const approved = h.store.grantApproval({
        proposal_hash: sig.approval!.proposal_hash,
        decision: 'approved',
      });

      const execRes = await executeWorkflow3HmSignalChain(h.executor, {
        episode_id: sig.episode!.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 71003,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
          slack: {
            reaction_removed: true,
          },
        },
      });

      assert.equal(execRes.ok, false);
      assert.equal(execRes.status, 'aborted_stale');
      assert.ok(execRes.reason?.includes('SLACK_REACTION_REMOVED'));
      assert.equal(h.previewCalls.length, 0);
      assert.equal(h.gmailCalls.length, 0);
      assert.equal(h.store.getHmSignal(sig.signal_key!)?.status, 'aborted_stale');
    } finally {
      h.cleanup();
    }
  });

  it('suppresses separate Gmail candidate outreach when target stage has an automated Greenhouse email rule (double-email prevention)', async () => {
    const h = createTestHarness();
    try {
      // Case 1: Target stage (Turing Assessment 12579939004) HAS an automated Greenhouse stage-transition email rule
      const withAutoRule = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1750030.001',
        reactor_or_reply_id: 'U_HM_01',
        signal_type: 'reaction',
        reaction_emoji: 'thumbsup',
        stage_has_auto_email_rule: true,
        message_candidates: [
          {
            application_id: 71004,
            candidate_name: 'Rowan Diaz',
            candidate_email: 'rowan@example.com',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        ],
      });

      assert.equal(withAutoRule.episode?.state.target_stage_id, TURING_ASSESSMENT_STAGE_ID);
      assert.equal(withAutoRule.episode?.state.suppress_outreach_email, true);

      const approved1 = h.store.grantApproval({
        proposal_hash: withAutoRule.approval!.proposal_hash,
        decision: 'approved',
      });

      const res1 = await executeWorkflow3HmSignalChain(h.executor, {
        episode_id: withAutoRule.episode!.episode_id,
        approval: approved1,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 71004,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
          slack: { reaction_removed: false, has_hm_override: false },
        },
      });

      assert.equal(res1.ok, true);
      assert.equal(h.gmailCalls.length, 0, 'Must NOT send Gmail outreach when stage_has_auto_email_rule=true');
      assert.deepEqual(
        h.previewCalls.map(c => c.kind),
        ['application_stage_move', 'candidate_note_create'],
      );

      // Case 2: Target stage (Manager / Tech Screen 12579940004) does NOT have an auto-email rule -> sends Gmail availability request
      const withoutAutoRule = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1750030.002',
        reactor_or_reply_id: '1750030.050',
        signal_type: 'reply',
        reply_text: 'Move Skylar Cruz to tech screen with Khiem',
        stage_has_auto_email_rule: false,
        message_candidates: [
          {
            application_id: 71005,
            candidate_name: 'Skylar Cruz',
            candidate_email: 'skylar@example.com',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        ],
      });

      assert.equal(withoutAutoRule.episode?.state.target_stage_id, MANAGER_TECH_SCREEN_STAGE_ID);
      assert.equal(withoutAutoRule.episode?.state.suppress_outreach_email, false);

      const approved2 = h.store.grantApproval({
        proposal_hash: withoutAutoRule.approval!.proposal_hash,
        decision: 'approved',
      });

      const res2 = await executeWorkflow3HmSignalChain(h.executor, {
        episode_id: withoutAutoRule.episode!.episode_id,
        approval: approved2,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 71005,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
          slack: { reaction_removed: false, has_hm_override: false },
        },
      });

      assert.equal(res2.ok, true);
      assert.equal(h.gmailCalls.length, 1);
      assert.equal(h.gmailCalls[0].to, 'skylar@example.com');
    } finally {
      h.cleanup();
    }
  });
});

// =============================================================================
// Suite 4: Workflow 5 — Greenhouse Grooming & Hygiene (5A, 5B, 5C)
// =============================================================================

describe('WP-6 Workflow 5: Cross-Job Transfers/Forks (5A), Forward-Only Drift Repair (5B), and Missing Owner Hygiene (5C)', () => {
  it('executes Workflow 5A Chain E in both transfer mode and fork mode', async () => {
    const h = createTestHarness();
    try {
      // 1. Transfer mode (lands on dest stage 1, then advances to deeper target stage, then logs audit note)
      const transferPrep = prepareWorkflow5ACrossReqProposal(h.store, {
        mode: 'transfer',
        application_id: 81001,
        candidate_id: 71001,
        candidate_name: 'Hayden Brooks',
        from_job_id: PILOT_JOB_ID,
        from_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        to_job_id: 5149099004,
        dest_stage_1_id: 2200001004,
        dest_target_stage_id: 2200003004,
      });

      const approvedTransfer = h.store.grantApproval({
        proposal_hash: transferPrep.approval.proposal_hash,
        decision: 'approved',
      });

      const transferRes = await executeWorkflow5AChainE(h.executor, {
        episode_id: transferPrep.episode.episode_id,
        approval: approvedTransfer,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 81001,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        },
      });

      assert.equal(transferRes.result.ok, true);
      assert.deepEqual(
        h.previewCalls.map(c => c.kind),
        ['application_job_transfer', 'application_stage_move', 'candidate_note_create'],
      );
      assert.equal('from_stage_id' in h.previewCalls[0].input, false);
      assert.ok(
        String(h.previewCalls[2].input.body).startsWith('Per Sam Vangelos — assistant acted:'),
      );

      h.previewCalls.length = 0;
      h.applyCalls.length = 0;

      // 2. Fork mode (creates application on destination job, copies resume via attachment_create, logs audit note)
      const forkResume = Buffer.from('Fictional Forked Resume PDF Bytes', 'utf8');
      const forkPrep = prepareWorkflow5ACrossReqProposal(h.store, {
        mode: 'fork',
        application_id: 81002,
        candidate_id: 71002,
        candidate_name: 'Emerson Park',
        from_job_id: PILOT_JOB_ID,
        from_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        to_job_id: 5149099004,
        dest_stage_1_id: 2200001004,
        dest_target_stage_id: 2200002004,
        resume_filename: 'emerson_park.pdf',
        resume_base64: forkResume.toString('base64'),
      });

      const approvedFork = h.store.grantApproval({
        proposal_hash: forkPrep.approval.proposal_hash,
        decision: 'approved',
      });

      const forkRes = await executeWorkflow5AChainE(h.executor, {
        episode_id: forkPrep.episode.episode_id,
        approval: approvedFork,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 81002,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        },
      });

      assert.equal(forkRes.result.ok, true);
      assert.ok(forkRes.resulting_application_id && forkRes.resulting_application_id !== 81002);
      assert.deepEqual(
        h.previewCalls.map(c => c.kind),
        ['application_create', 'attachment_create', 'candidate_note_create'],
      );
      assert.equal(h.previewCalls[0].input.referrer_id, SAM_REFERRER_ID);
      assert.equal(h.previewCalls[1].input.application_id, forkRes.resulting_application_id);
      assert.equal(h.previewCalls[2].input.application_id, forkRes.resulting_application_id);
    } finally {
      h.cleanup();
    }
  });

  it('enforces Workflow 5B forward-only stage drift repair (repairs forward on scheduled/awaiting_feedback, never moves backward on completed interviews)', async () => {
    const h = createTestHarness();
    try {
      // 1. Historical `complete` interview in earlier stage OR later stage must NEVER trigger stage move
      const backwardOrComplete = evaluateStageDriftRepair(h.store, {
        application_id: 82001,
        job_id: PILOT_JOB_ID,
        current_stage_id: MANAGER_TECH_SCREEN_STAGE_ID, // priority 5
        interviews: [
          {
            id: 501,
            stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID, // priority 2 (earlier)
            status: 'scheduled',
          },
          {
            id: 502,
            stage_id: 12579941004, // Onsite Interviews priority 6 (later, but already `complete`)
            status: 'complete',
          },
        ],
      });
      assert.equal(backwardOrComplete.action, 'noop_no_forward_active_interview');

      // 2. Active `scheduled` interview in a later stage (Manager / Tech Screen 12579940004 while app is in HM Review 12579938004)
      const forwardDrift = evaluateStageDriftRepair(h.store, {
        application_id: 82002,
        job_id: PILOT_JOB_ID,
        current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID, // priority 3
        interviews: [
          {
            id: 503,
            stage_id: MANAGER_TECH_SCREEN_STAGE_ID, // priority 5
            status: 'scheduled',
          },
        ],
      });
      assert.equal(forwardDrift.action, 'proposed_forward_repair');
      assert.equal(forwardDrift.episode?.state.target_stage_id, MANAGER_TECH_SCREEN_STAGE_ID);

      const approved = h.store.grantApproval({
        proposal_hash: forwardDrift.approval!.proposal_hash,
        decision: 'approved',
      });

      const res = await executeStageDriftRepair(h.executor, {
        episode_id: forwardDrift.episode!.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 82002,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        },
      });
      assert.equal(res.ok, true);
      assert.deepEqual(
        h.previewCalls.map(c => c.kind),
        ['application_stage_move', 'candidate_note_create'],
      );
      assert.equal(h.previewCalls[0].input.to_stage_id, MANAGER_TECH_SCREEN_STAGE_ID);
    } finally {
      h.cleanup();
    }
  });

  it('executes Workflow 5C missing owner assignment via application_assignment_change and runs via executor-tick', async () => {
    const h = createTestHarness();
    try {
      const hygiene = evaluateMissingOwnerHygiene(h.store, {
        application_id: 83001,
        job_id: PILOT_JOB_ID,
        current_stage_id: APPLICATION_REVIEW_STAGE_ID,
        current_recruiter_id: null,
        current_coordinator_id: null,
      });
      assert.equal(hygiene.action, 'proposed_owner_assignment');

      h.store.grantApproval({
        proposal_hash: hygiene.approval!.proposal_hash,
        decision: 'approved',
      });

      const tickSummary = await runExecutorTick({
        store: h.store,
        dataDir: h.dataDir,
        actionService: h.executor.actionService,
        slack: h.executor.slack,
        gmail: h.executor.gmail,
        now: () => h.executor.now(),
        defaultFreshSnapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 83001,
            status: 'active',
            current_stage_id: APPLICATION_REVIEW_STAGE_ID,
          },
        },
      });

      assert.equal(tickSummary.acquired, true);
      assert.equal(tickSummary.approvalsProcessed, 1);
      assert.equal(tickSummary.errors.length, 0);

      assert.deepEqual(
        h.previewCalls.map(c => c.kind),
        [
          'application_assignment_change',
          'application_assignment_change',
          'candidate_note_create',
        ],
      );
      assert.deepEqual(h.previewCalls[0].input, {
        application_id: 83001,
        assignment_role: 'recruiter',
        proposed_user_id: SAM_GREENHOUSE_USER_ID,
      });
      assert.deepEqual(h.previewCalls[1].input, {
        application_id: 83001,
        assignment_role: 'coordinator',
        proposed_user_id: SAM_GREENHOUSE_USER_ID,
      });
      assert.equal(h.store.getEpisode(hygiene.episode!.episode_id)?.status, 'COMPLETED');
    } finally {
      h.cleanup();
    }
  });
});

describe('Phase 4 Adversarial Review Regressions (WP-5 & WP-6)', () => {
  it('WF3: enforces EMAIL note array schema, recovers after post-move/post-email crash without unlocking HM signal, disambiguates shared last names, and allows re-claim after decline', async () => {
    const h = createTestHarness();
    try {
      // 1. Multi-candidate slate with shared last name ("Alex Kim" vs "Blake Kim")
      const sharedLastNameSlate = [
        {
          application_id: 91001,
          candidate_name: 'Alex Kim',
          candidate_email: 'alex.kim@example.com',
          current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        },
        {
          application_id: 91002,
          candidate_name: 'Blake Kim',
          candidate_email: 'blake.kim@example.com',
          current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        },
      ];

      // Question or non-positive comment must be ignored
      const questionReply = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1760000.001',
        reactor_or_reply_id: '1760000.010',
        signal_type: 'reply',
        reply_text: 'Should we advance Blake Kim to tech screen?',
        message_candidates: sharedLastNameSlate,
      });
      assert.equal(questionReply.action, 'ignored_non_positive_or_unresolved');

      // Ambiguous last-name-only reply ("Advance Kim") must be rejected
      const ambigLastName = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1760000.001',
        reactor_or_reply_id: '1760000.011',
        signal_type: 'reply',
        reply_text: 'Advance Kim to tech screen',
        message_candidates: sharedLastNameSlate,
      });
      assert.equal(ambigLastName.action, 'ignored_non_positive_or_unresolved');
      assert.equal(ambigLastName.reason, 'REPLY_CANDIDATE_NOT_NAMED_OR_AMBIGUOUS');

      // Full-name reply ("Advance Blake Kim to tech screen") disambiguates cleanly
      const exactFullName = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1760000.001',
        reactor_or_reply_id: '1760000.012',
        signal_type: 'reply',
        reply_text: 'Advance Blake Kim to tech screen with Khiem',
        message_candidates: sharedLastNameSlate,
        gmail_thread_id: 'thr_blake_91002',
        gmail_last_message_id: 'msg_initial_1',
      });
      assert.equal(exactFullName.action, 'proposed_advance');
      assert.equal(exactFullName.episode?.state.application_id, 91002);
      assert.ok(
        exactFullName.episode?.state.outreach_body_html?.includes('over the next few business days'),
      );

      // Declining the approval marks wf3_hm_signals as aborted_stale so a subsequent HM signal can re-claim
      h.store.grantApproval({
        proposal_hash: exactFullName.approval!.proposal_hash,
        decision: 'declined',
      });
      assert.equal(h.store.getHmSignal(exactFullName.signal_key!)?.status, 'aborted_stale');

      // Re-claiming after decline succeeds
      const reclaimed = evaluateHmPositiveSignal(h.store, {
        channel_id: FIELD_ENGINEERING_HIRING_CHANNEL_ID,
        message_ts: '1760000.001',
        reactor_or_reply_id: '1760000.012',
        signal_type: 'reply',
        reply_text: 'Advance Blake Kim to tech screen with Khiem',
        message_candidates: sharedLastNameSlate,
        gmail_thread_id: 'thr_blake_91002',
        gmail_last_message_id: 'msg_initial_1',
      });
      assert.equal(reclaimed.action, 'proposed_advance');
      const approved = h.store.grantApproval({
        proposal_hash: reclaimed.approval!.proposal_hash,
        decision: 'approved',
      });

      // 2. Simulate crash/failure on Step 3 (log_outreach_email_note) after Step 1 (stage move) and Step 2 (email) succeed
      let failEmailNoteOnce = true;
      h.setCustomApply(async (kind) => {
        if (kind === 'candidate_note_create' && failEmailNoteOnce) {
          failEmailNoteOnce = false;
          throw new Error('Transient network failure on candidate_note_create');
        }
        return null;
      });

      const firstRun = await executeWorkflow3HmSignalChain(h.executor, {
        episode_id: reclaimed.episode!.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 91002,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
          gmail_thread: {
            thread_id: 'thr_blake_91002',
            last_message_id: 'msg_initial_1',
            has_unsent_sam_draft: false,
          },
          slack_signal: {
            reaction_removed: false,
            hm_override_detected: false,
          },
        },
      });
      assert.equal(firstRun.ok, false);
      // Because Step 1 already moved the stage, wf3_hm_signals MUST be locked ('executed'), not 'aborted_stale'!
      assert.equal(h.store.getHmSignal(reclaimed.signal_key!)?.status, 'executed');
      assert.equal(h.store.getEpisode(reclaimed.episode!.episode_id)?.stage_id, MANAGER_TECH_SCREEN_STAGE_ID);

      // Resume on next tick: stage is now MANAGER_TECH_SCREEN_STAGE_ID and Gmail last_message_id is msg_1 (the sent outreach email)
      const secondRun = await executeWorkflow3HmSignalChain(h.executor, {
        episode_id: reclaimed.episode!.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 91002,
            status: 'in_process',
            current_stage_id: MANAGER_TECH_SCREEN_STAGE_ID,
          },
          gmail_thread: {
            thread_id: 'thr_blake_91002',
            last_message_id: 'msg_1',
            has_unsent_sam_draft: false,
          },
        },
      });
      assert.equal(secondRun.ok, true);
      assert.equal(h.gmailCalls.length, 1); // Outreach email sent only once!

      const emailNotePreview = h.previewCalls.find(
        c => c.kind === 'candidate_note_create' && c.input.note_type === 'EMAIL',
      );
      assert.ok(emailNotePreview);
      assert.deepEqual(emailNotePreview!.input.email_from, ['sam.vangelos@turing.com']);
      assert.deepEqual(emailNotePreview!.input.email_to, ['blake.kim@example.com']);
      assert.deepEqual(emailNotePreview!.input.email_cc, []);
    } finally {
      h.cleanup();
    }
  });

  it('WF2: enforces contraction negation, speaker-turn verification, native systems-admin draft shape, and SCORECARD_ALREADY_COMPLETE recovery', async () => {
    const h = createTestHarness();
    try {
      // 1. Contraction negation ("I don't think this is a strong yes") must reject 'strong_yes'
      const negatedDraft: SystemsAdminScorecardDraft = {
        overall_recommendation: 'strong_yes',
        key_takeaways: [
          {
            statement: 'Candidate built Python microservices.',
            verbatim_quote: 'I built Python microservices for 4 years.',
          },
        ],
        attributes: [],
        questions: [],
      };
      const negatedRes = validateSystemsAdminScorecardDraft(negatedDraft, {
        granola_transcript: 'Candidate: I built Python microservices for 4 years.',
        sam_notes: "I don't think this is a strong yes — pass for now.",
      });
      assert.equal(negatedRes.ok, false);
      assert.ok(negatedRes.errors.some(e => e.includes('not supported by Sam')));

      // 2. Speaker-labeled transcript: quote from Sam's own interviewer turn must be rejected
      const interviewerQuoteDraft: SystemsAdminScorecardDraft = {
        overall_recommendation: 'yes',
        key_takeaways: [
          {
            statement: 'Candidate has 8 years of Kubernetes experience.',
            verbatim_quote: 'We need someone with 8 years of Kubernetes experience.',
          },
        ],
        attributes: [],
        questions: [],
      };
      const speakerRes = validateSystemsAdminScorecardDraft(interviewerQuoteDraft, {
        granola_transcript:
          'Sam Vangelos: We need someone with 8 years of Kubernetes experience.\nCandidate: I have 3 years of Docker experience.',
        sam_notes: 'Overall recommendation: yes',
      });
      assert.equal(speakerRes.ok, false);
      assert.ok(speakerRes.errors.some(e => e.includes('spoken by the interviewer')));

      // 3. Native systems-admin ScorecardDraft shape (`key_takeaway_statements`, `job_candidate_attribute_id`, `rating`, `sentences`)
      const nativeDraft: SystemsAdminScorecardDraft = {
        overall_recommendation: 'strong_yes',
        key_takeaway_statements: [
          {
            statement: 'Led 12 production LLM deployments.',
            evidence: {
              quote: 'I led 12 production LLM deployments last year.',
              source: 'transcript',
            },
          },
        ],
        attributes: [
          {
            job_candidate_attribute_id: 9001,
            name: 'Technical Depth',
            rating: 'strong_yes',
            sentences: [
              {
                text: 'Strong distributed systems background with 12 deployments.',
                evidence: {
                  quote: 'I led 12 production LLM deployments last year.',
                  source: 'transcript',
                },
              },
            ],
          },
        ],
        questions: [
          {
            scorecard_question_id: 7001,
            value: '12 deployments in production.',
            statements: [
              {
                statement: '12 deployments in production.',
                evidence: {
                  quote: 'I led 12 production LLM deployments last year.',
                  source: 'transcript',
                },
              },
            ],
          },
        ],
      };

      const prep = prepareWorkflow2ScorecardProposal(h.store, {
        application_id: 92001,
        candidate_id: 5001,
        candidate_name: 'Maya Lin',
        draft: nativeDraft,
        sources: {
          granola_transcript: 'Maya Lin: I led 12 production LLM deployments last year.',
          sam_notes: 'Overall: strong_yes. Technical Depth: strong_yes.',
        },
      });
      assert.equal(prep.episode.state.coupled_decision, 'advance');
      assert.equal(prep.scorecard_input.attribute_ratings?.length, 1);
      assert.equal(prep.scorecard_input.question_answers?.length, 1);

      // 4. Simulate Step 1 in 'intent' state and SCORECARD_ALREADY_COMPLETE on retry -> reconciles and runs Coupled Step 2
      const approved = h.store.grantApproval({
        proposal_hash: prep.approval.proposal_hash,
        decision: 'approved',
      });
      h.store.upsertChainStep({
        chain_id: prep.chain_id,
        episode_id: prep.episode.episode_id,
        step_index: 10,
        step_key: 'submit_recruiter_scorecard',
        action_key: `wf2_submit_scorecard:92001:${RECRUITER_PHONE_SCREEN_STAGE_ID}`,
        idempotency_key: 'idem_92001_step1',
        service: 'greenhouse',
        operation: 'scorecard_submit',
        input: prep.scorecard_input as unknown as Record<string, unknown>,
        status: 'intent',
      });

      h.setCustomPreview(async (kind) => {
        if (kind === 'scorecard_submit') {
          const err: any = new Error('Scorecard is already complete');
          err.code = 'SCORECARD_ALREADY_COMPLETE';
          throw err;
        }
        return null;
      });

      const res = await executeWorkflow2ChainD(h.executor, {
        episode_id: prep.episode.episode_id,
        approval: approved,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 92001,
            status: 'in_process',
            current_stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
          },
          scorecards: [
            {
              id: 88001,
              application_id: 92001,
              stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
              interviewer_id: SAM_GREENHOUSE_USER_ID,
              status: 'complete',
            },
          ],
        },
      });
      assert.equal(res.ok, true);
      assert.equal(h.slackCalls.length, 1);
      assert.equal(h.slackCalls[0].channel, FIELD_ENGINEERING_HIRING_CHANNEL_ID);
    } finally {
      h.cleanup();
    }
  });

  it('WF1 & WF5B: enforces cancelled/rescheduled booking guards, post-Chain-C interview update/delete, forward-only advance_existing, and WF5B crash recovery', async () => {
    const h = createTestHarness();
    try {
      // 1. Booking cancelled after approval -> executeWorkflow1IntakeChain aborts with BOOKING_CANCELLED
      const booking1 = ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/EV_9301/invitees/INV_9301',
        candidate_name: 'Noah Patel',
        candidate_email: 'noah.patel@example.com',
        starts_at: '2026-06-18T17:00:00.000Z',
        ends_at: '2026-06-18T17:30:00.000Z',
        job_id: PILOT_JOB_ID,
      });
      const approved1 = h.store.grantApproval({
        proposal_hash: booking1.approval!.proposal_hash,
        decision: 'approved',
      });

      // Cancel booking before execution
      ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/EV_9301/invitees/INV_9301',
        candidate_name: 'Noah Patel',
        candidate_email: 'noah.patel@example.com',
        starts_at: '2026-06-18T17:00:00.000Z',
        ends_at: '2026-06-18T17:30:00.000Z',
        booking_status: 'canceled',
      });

      const cancelExec = await executeWorkflow1IntakeChain(h.executor, {
        episode_id: booking1.episode.episode_id,
        approval: approved1,
      });
      assert.equal(cancelExec.chain_c_result.ok, false);
      assert.ok(cancelExec.chain_c_result.reason?.startsWith('BOOKING_CANCELLED'));

      // 2. Existing application already in Hiring Manager Review (12579938004) > Recruiter Phone Screen (12579937004):
      // advance_existing must NOT move the stage backward!
      const booking2 = ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/EV_9302/invitees/INV_9302',
        candidate_name: 'Olivia Chen',
        candidate_email: 'olivia.chen@example.com',
        starts_at: '2026-06-18T18:00:00.000Z',
        ends_at: '2026-06-18T18:30:00.000Z',
        job_id: PILOT_JOB_ID,
        initial_stage_id: RECRUITER_PHONE_SCREEN_STAGE_ID,
        existing_candidate_id: 6002,
        existing_application_id: 93002,
        existing_application_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        existing_application_prospective: false,
      });
      const approved2 = h.store.grantApproval({
        proposal_hash: booking2.approval!.proposal_hash,
        decision: 'approved',
      });
      const exec2 = await executeWorkflow1IntakeChain(h.executor, {
        episode_id: booking2.episode.episode_id,
        approval: approved2,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 93002,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        },
      });
      assert.equal(exec2.chain_c_result.ok, true);
      assert.equal(
        h.previewCalls.some(c => c.kind === 'application_stage_move'),
        false,
        'Must not move application stage backward from HM Review to Phone Screen',
      );
      assert.equal(
        h.previewCalls.some(c => c.kind === 'interview_create'),
        true,
      );

      // Now reschedule booking2 AFTER Chain C completed -> transitions to RESCHEDULED_PENDING_UPDATE and runs interview_update
      const resched2 = ingestBookingSignal(h.store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/EV_9302/invitees/INV_9302',
        candidate_name: 'Olivia Chen',
        candidate_email: 'olivia.chen@example.com',
        starts_at: '2026-06-19T18:00:00.000Z',
        ends_at: '2026-06-19T18:30:00.000Z',
        booking_status: 'rescheduled',
      });
      assert.equal(resched2.episode.status, 'RESCHEDULED_PENDING_UPDATE');
      const approvedResched2 = h.store.grantApproval({
        proposal_hash: resched2.approval!.proposal_hash,
        decision: 'approved',
      });
      const execResched2 = await executeWorkflow1IntakeChain(h.executor, {
        episode_id: resched2.episode.episode_id,
        approval: approvedResched2,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 93002,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        },
      });
      assert.equal(execResched2.chain_c_result.ok, true);
      assert.equal(
        h.previewCalls.some(c => c.kind === 'interview_update'),
        true,
      );

      // 3. WF5B crash recovery after Step 1 (repair_stage_drift) succeeds and Step 2 (log_stage_drift_note) fails
      const drift = evaluateStageDriftRepair(h.store, {
        application_id: 94001,
        job_id: PILOT_JOB_ID,
        current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
        interviews: [
          {
            id: 701,
            stage_id: MANAGER_TECH_SCREEN_STAGE_ID,
            status: 'scheduled',
          },
        ],
      });
      const approvedDrift = h.store.grantApproval({
        proposal_hash: drift.approval!.proposal_hash,
        decision: 'approved',
      });

      let failDriftNoteOnce = true;
      h.setCustomApply(async (kind) => {
        if (kind === 'candidate_note_create' && failDriftNoteOnce) {
          failDriftNoteOnce = false;
          throw new Error('Transient failure on drift note');
        }
        return null;
      });

      const driftRun1 = await executeStageDriftRepair(h.executor, {
        episode_id: drift.episode!.episode_id,
        approval: approvedDrift,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 94001,
            status: 'in_process',
            current_stage_id: HIRING_MANAGER_REVIEW_STAGE_ID,
          },
        },
      });
      assert.equal(driftRun1.ok, false);
      assert.equal(h.store.getEpisode(drift.episode!.episode_id)?.stage_id, MANAGER_TECH_SCREEN_STAGE_ID);

      // Retry with live stage now at MANAGER_TECH_SCREEN_STAGE_ID
      const driftRun2 = await executeStageDriftRepair(h.executor, {
        episode_id: drift.episode!.episode_id,
        approval: approvedDrift,
        fresh_snapshot: {
          fetched_at: h.executor.nowIso(),
          application: {
            id: 94001,
            status: 'in_process',
            current_stage_id: MANAGER_TECH_SCREEN_STAGE_ID,
          },
        },
      });
      assert.equal(driftRun2.ok, true);
      assert.equal(h.store.getEpisode(drift.episode!.episode_id)?.status, 'COMPLETED');
    } finally {
      h.cleanup();
    }
  });
});
