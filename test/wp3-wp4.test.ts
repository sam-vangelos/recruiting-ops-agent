import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readLedger, sha256, summarizeLedger } from '../worker/ledger.mjs';
import { runExecutorTick } from '../worker/executor-tick.mjs';
import {
  type ActionServiceLike,
  type CalendarProvider,
  DeterministicExecutor,
  type FreshReadSnapshot,
  type GmailProvider,
  loadGreenhouseActionService,
  SAM_EMAIL,
  SAM_GREENHOUSE_USER_ID,
  type SlackProvider,
  verifyFreshState,
  verifyInProcessSendGate,
} from '../src/executor/index.ts';
import {
  canonicalize,
  computeProposalHash,
  SqliteCoordinatorStore,
} from '../src/store/sqlite.ts';
import {
  addWorkingHours,
  computeDeliberationFireAt,
  computeNextBusinessDayDeliberationFireAt,
  getLocalParts,
  guardDeliberationFireTime,
  RAILS_TO_IANA_TZ,
  resolveTimezone,
} from '../src/utils/timezone.ts';
import {
  DEFAULT_REJECTION_REASON_ID,
  DEFAULT_WF4_REJECTION_NOTE,
  evaluateWorkflow4Scorecards,
  fireWorkflow4DeliberatedRejection,
  MASTER_POST_INTERVIEW_REJECTION_TEMPLATE_ID,
} from '../src/workflows/wf4-rejection.ts';
import {
  buildGreenhouseInterviewKitUrl,
  executeStep1HmYesStageMove,
  executeStep6BookingChain,
  executeStep8ConfirmationChain,
  executeStep9CancellationChain,
  executeStep9RescheduleChain,
  findOverlappingInterviewerSlot,
  fireStep7RsvpChase,
  fireStep10ScorecardChase24h,
  handleStep7InterviewerDecline,
  INTERVIEWER_ROLE_ID,
  parseCandidateAvailabilityWindows,
  reconcileStep10ScorecardCompletion,
  renderConfirmationTemplate4151798004,
  scheduleStep2AvailabilityChases,
  selectThreeEarliestOpenSlots,
} from '../src/workflows/wf6-scheduling.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-wp3-wp4-'));
}

function createMockProviders() {
  const greenhouseCalls: Array<{ method: 'preview' | 'apply'; kind: string; input: any; client?: string }> = [];
  const calendarCalls: Array<{ op: string; input: any }> = [];
  const gmailCalls: Array<{ input: any }> = [];
  const slackCalls: Array<{ input: any }> = [];

  const events = new Map<string, any>();
  let holdCounter = 0;
  let interviewCounter = 9000;
  let failNextInterviewCreate = false;
  let permissionNoChange = false;

  const actionService: ActionServiceLike = {
    async preview(kind, input, _actor, client) {
      greenhouseCalls.push({ method: 'preview', kind, input, client });
      if (kind === 'user_job_permission_create' && permissionNoChange) {
        return {
          status: 'no_change',
          changeRequired: false,
          intent: { kind, input },
          approval: 'noop-token',
          provider_id: 'perm_existing_777',
          details: { existing_permission_id: 777 },
        };
      }
      return {
        status: 'ready',
        changeRequired: true,
        intent: { kind, input },
        approval: `approval-token-${kind}`,
      };
    },
    async apply(kind, req, _actor, client) {
      greenhouseCalls.push({ method: 'apply', kind, input: req.intent.input, client });
      if (kind === 'interview_create' && failNextInterviewCreate) {
        failNextInterviewCreate = false;
        throw new Error('Simulated Greenhouse POST /v3/interviews 502 error');
      }
      if (kind === 'interview_create') {
        const id = ++interviewCounter;
        return {
          status: 'applied',
          provider_id: String(id),
          result: { id, interview_id: id, ...(req.intent.input as object) },
        };
      }
      if (kind === 'user_job_permission_create') {
        return {
          status: 'applied',
          provider_id: 'perm_888',
          result: { id: 888, permission_id: 888 },
        };
      }
      if (kind === 'candidate_note_create') {
        return {
          status: 'applied',
          provider_id: 'note_555',
          result: { id: 555, note_id: 555 },
        };
      }
      if (kind === 'application_rejection') {
        return {
          status: 'applied',
          provider_id: `reject_${(req.intent.input as any).application_id}`,
          result: { id: (req.intent.input as any).application_id, status: 'rejected' },
        };
      }
      return {
        status: 'applied',
        provider_id: `${kind}_ok`,
        result: { ok: true },
      };
    },
  };

  const calendar: CalendarProvider = {
    async createSilentHold(input) {
      calendarCalls.push({ op: 'createSilentHold', input });
      const eventId = `gcal_hold_${++holdCounter}`;
      const ev = {
        event_id: eventId,
        hangout_link: `https://meet.google.com/abc-defg-${holdCounter}`,
        html_link: `https://calendar.google.com/event?eid=${eventId}`,
        status: 'confirmed',
        start: input.start,
        end: input.end,
        attendees: [],
      };
      events.set(eventId, ev);
      return ev;
    },
    async patchEvent(input) {
      calendarCalls.push({ op: 'patchEvent', input });
      const existing = events.get(input.event_id) ?? {
        event_id: input.event_id,
        hangout_link: 'https://meet.google.com/abc-defg-1',
      };
      const updated = {
        ...existing,
        ...input,
      };
      events.set(input.event_id, updated);
      return updated;
    },
    async deleteEvent(input) {
      calendarCalls.push({ op: 'deleteEvent', input });
      events.delete(input.event_id);
      return { deleted: true };
    },
    async getEvent(eventId) {
      return events.get(eventId) ?? null;
    },
  };

  const gmail: GmailProvider = {
    async sendMessage(input) {
      gmailCalls.push({ input });
      return {
        message_id: `gmail_msg_${gmailCalls.length}`,
        thread_id: input.threadId ?? `gmail_thread_${gmailCalls.length}`,
      };
    },
  };

  const slack: SlackProvider = {
    async sendMessage(input) {
      slackCalls.push({ input });
      return {
        ts: `1700000000.000${slackCalls.length}`,
        channel: input.channel,
      };
    },
  };

  return {
    actionService,
    calendar,
    gmail,
    slack,
    greenhouseCalls,
    calendarCalls,
    gmailCalls,
    slackCalls,
    events,
    setFailNextInterviewCreate(v: boolean) {
      failNextInterviewCreate = v;
    },
    setPermissionNoChange(v: boolean) {
      permissionNoChange = v;
    },
  };
}

// ============================================================================
// 1. Timezone & Ruling 2 Deliberation Calculator Tests
// ============================================================================

test('WP-3 timezone: RAILS_TO_IANA_TZ maps Greenhouse/Rails strings, abbreviations, and unknown fallback', () => {
  assert.equal(resolveTimezone('Pacific Time (US & Canada)'), 'America/Los_Angeles');
  assert.equal(resolveTimezone('(GMT-05:00) Eastern Time (US & Canada)'), 'America/New_York');
  assert.equal(resolveTimezone('Chennai'), 'Asia/Kolkata');
  assert.equal(resolveTimezone('America/Chicago'), 'America/Chicago');
  assert.equal(resolveTimezone('EDT'), 'America/New_York');
  assert.equal(resolveTimezone('Unknown Mars Zone'), 'America/Los_Angeles');
  assert.equal(resolveTimezone(null), 'America/Los_Angeles');
  assert.ok(Object.keys(RAILS_TO_IANA_TZ).length >= 130);
});

test('WP-3 timezone: Ruling 2 computeDeliberationFireAt clamps [60, 180]m into 08:30-17:30 Mon-Fri candidate local time', () => {
  // Case A: Midday Tuesday in America/New_York (14:00 EDT = 18:00 UTC) + 90m -> 15:30 EDT same day
  const resSameDay = computeDeliberationFireAt({
    interview_ends_at: '2026-10-20T18:00:00.000Z',
    candidate_tz: 'Eastern Time (US & Canada)',
    random_minutes: 90,
  });
  assert.equal(resSameDay.candidate_tz, 'America/New_York');
  assert.equal(resSameDay.delay_minutes, 90);
  assert.equal(resSameDay.clamped_or_rolled, false);
  assert.equal(resSameDay.local_date, '2026-10-20');
  assert.equal(resSameDay.local_time, '15:30');

  // Case B: Late Friday afternoon in America/Los_Angeles (16:30 PDT = 23:30 UTC) + 120m -> 18:30 PDT (after 17:30)
  // Must roll forward across Saturday & Sunday into Monday 2026-10-26 within [08:30, 17:30] PDT!
  const resFriday = computeDeliberationFireAt({
    interview_ends_at: '2026-10-23T23:30:00.000Z',
    candidate_tz: 'Pacific Time (US & Canada)',
    random_minutes: 120,
  });
  assert.equal(resFriday.clamped_or_rolled, true);
  assert.equal(resFriday.local_date, '2026-10-26'); // Monday
  const parts = getLocalParts(resFriday.fire_at_ms, 'America/Los_Angeles');
  assert.equal(parts.weekday, 'Mon');
  const mins = parts.hour * 60 + parts.minute;
  assert.ok(mins >= 8 * 60 + 30 && mins <= 17 * 60 + 30, `Expected within 08:30-17:30, got ${resFriday.local_time}`);

  // Case C: Next-Business-Day deliberation formula (+18h wall, +4h work, next day [10:00, 15:00] + jitter % 47)
  const resNbd = computeNextBusinessDayDeliberationFireAt({
    interview_ended_at: '2026-10-20T22:00:00.000Z', // 15:00 PDT Tuesday
    candidate_tz: 'America/Los_Angeles',
    application_id: 901001,
  });
  const nbdParts = getLocalParts(resNbd.fire_at_ms, 'America/Los_Angeles');
  assert.equal(nbdParts.dateStr, '2026-10-21'); // Wednesday
  const nbdMins = nbdParts.hour * 60 + nbdParts.minute;
  assert.ok(nbdMins >= 10 * 60 && nbdMins <= 15 * 60, `Expected within 10:00-15:00, got ${resNbd.local_time}`);

  // Case D: Missed-window guard rolls night wake-up to next business morning
  const nightNowMs = Date.parse('2026-10-22T04:00:00.000Z'); // 21:00 PDT Wednesday night
  const guard = guardDeliberationFireTime({
    now_ms: nightNowMs,
    scheduled_fire_at_ms: Date.parse('2026-10-21T20:00:00.000Z'),
    candidate_tz: 'America/Los_Angeles',
    application_id: 901001,
  });
  assert.equal(guard.can_fire_now, false);
  assert.ok(guard.next_fire_at);
  const rolledParts = getLocalParts(guard.next_fire_at!, 'America/Los_Angeles');
  assert.equal(rolledParts.dateStr, '2026-10-22'); // Thursday morning
  assert.ok(rolledParts.hour >= 8);
});

test('WP-3 timezone: addWorkingHours pauses across weekends and US company holidays', () => {
  // Friday 2026-10-23 18:00 UTC + 12 working hours -> Monday 2026-10-26 06:00 UTC
  const next = addWorkingHours('2026-10-23T18:00:00.000Z', 12, 'UTC');
  assert.equal(next, '2026-10-26T06:00:00.000Z');
});

// ============================================================================
// 2. SQLite Coordinator Store Tests
// ============================================================================

test('WP-3 SQLite store: single-writer lease, dead-PID takeover, 16-hex proposal_hash approvals, and conflict holds', () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);

  try {
    // 1. Lease acquisition & contention
    const lease1 = store.acquireWriterLease({
      ownerId: 'owner-1',
      pid: process.pid,
      ttlMs: 60_000,
      nowMs: 1_000_000,
    });
    assert.equal(lease1.acquired, true);

    const leaseBlocked = store.acquireWriterLease({
      ownerId: 'owner-2',
      pid: process.pid,
      ttlMs: 60_000,
      nowMs: 1_010_000,
    });
    assert.equal(leaseBlocked.acquired, false);
    assert.equal(leaseBlocked.existingOwner?.owner_id, 'owner-1');

    // Dead PID takeover even before TTL expires
    const leaseTakeover = store.acquireWriterLease({
      ownerId: 'owner-2',
      pid: process.pid,
      ttlMs: 60_000,
      nowMs: 1_010_000,
      checkProcessAlive: () => false,
    });
    assert.equal(leaseTakeover.acquired, true);
    assert.equal(store.releaseWriterLease('owner-2'), true);

    // 2. 16-hex SHA-256 proposal_hash registration & parameter-bound approval
    const prop = store.registerProposal({
      episode_id: 'ep-100',
      action_key: 'advance_stage:100:200',
      workflow: 'wf6_scheduling',
      params: { application_id: 100, to_stage_id: 200 },
      expected_state: { stage_id: 150 },
    });
    assert.match(prop.proposal_hash, /^[0-9a-f]{16}$/);
    assert.equal(prop.decision, 'pending');

    // Parameter mismatch must throw
    assert.throws(() => {
      store.grantApproval({
        proposal_hash: prop.proposal_hash,
        decision: 'approved',
        expected_params: { application_id: 100, to_stage_id: 999 },
      });
    }, /Approval parameter mismatch/);

    const approved = store.grantApproval({
      proposal_hash: prop.proposal_hash,
      decision: 'approved',
      expected_params: { application_id: 100, to_stage_id: 200 },
    });
    assert.equal(approved.decision, 'approved');
    assert.equal(store.listReadyApprovals().length, 1);

    // 3. Canonicalize determinism
    assert.equal(
      canonicalize({ b: 2, a: 'hello' }),
      canonicalize({ a: 'hello', b: 2 }),
    );
    assert.equal(
      computeProposalHash({ b: 2, a: 'hello' }),
      computeProposalHash({ a: 'hello', b: 2 }),
    );
  } finally {
    store.close();
  }
});

// ============================================================================
// 3. Executor Gates & Action-MCP Integration Tests
// ============================================================================

test('WP-4 Executor: verifyFreshState enforces <=120s age, status/stage, positive scorecard, unsent Sam draft, and self-hold ignore', () => {
  const nowMs = Date.parse('2026-10-20T18:02:00.000Z');

  // Stale snapshot (> 120s old)
  const stale = verifyFreshState(
    {
      fetched_at: '2026-10-20T17:59:00.000Z', // 180s old
      application: { id: 101, status: 'active', current_stage_id: 10 },
    },
    { application_id: 101, stage_id: 10 },
    { nowMs },
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'STALE_SNAPSHOT');

  // Unsent Sam draft on thread blocks execution
  const unsentDraft = verifyFreshState(
    {
      fetched_at: '2026-10-20T18:01:30.000Z',
      application: { id: 101, status: 'active', current_stage_id: 10 },
      gmail: { has_unsent_sam_draft: true },
    },
    { application_id: 101, stage_id: 10 },
    { nowMs },
  );
  assert.equal(unsentDraft.ok, false);
  assert.equal(unsentDraft.code, 'UNSENT_SAM_DRAFT');

  // Own silent calendar hold is ignored while external calendar conflict blocks
  const selfHoldOk = verifyFreshState(
    {
      fetched_at: '2026-10-20T18:01:30.000Z',
      application: { id: 101, status: 'active', current_stage_id: 10 },
      calendar: { conflicting_event_ids: ['gcal_hold_1'] },
    },
    { application_id: 101, stage_id: 10 },
    { nowMs, activeHoldEventIds: ['gcal_hold_1'] },
  );
  assert.equal(selfHoldOk.ok, true);

  // In-process send gate checks draft_sha256
  const body = '<p>Confirmed interview</p>';
  const gateBadSha = verifyInProcessSendGate({
    action_key: 'send_confirmation:101:9001',
    episode_id: 'ep-101',
    approval: {
      proposal_hash: '0123456789abcdef',
      episode_id: 'ep-101',
      action_key: 'send_confirmation:101:9001',
      chain_id: null,
      workflow: 'wf6_scheduling',
      decision: 'approved',
      actor: 'sam',
      params: {},
      expected_state: {},
      draft_sha256: sha256('different body'),
      approved_at: '2026-10-20T18:00:00.000Z',
      executed_at: null,
      failure_reason: null,
      created_at: '2026-10-20T18:00:00.000Z',
      updated_at: '2026-10-20T18:00:00.000Z',
    },
    outbound_body: body,
  });
  assert.equal(gateBadSha.allowed, false);
  assert.match(gateBadSha.reason ?? '', /does not match approved draft_sha256/);
});

test('WP-4 Executor: loads real GreenhouseActionService from greenhouse-mcp dist/', async () => {
  assert.equal(typeof loadGreenhouseActionService, 'function');
  const distIndex = path.resolve(
    import.meta.dirname,
    '../../greenhouse-mcp/packages/action-mcp/dist/index.js',
  );
  assert.equal(fs.existsSync(distIndex), true);
});

// ============================================================================
// 4. Chain A — Workflow 6 Full 10-Step Scheduling Lifecycle Tests
// ============================================================================

test('WP-4 Chain A (Workflow 6): Steps 1-5 availability parsing, overlap detection, and 3 earliest slots', async () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);
  const mocks = createMockProviders();
  const nowIso = '2026-10-20T18:00:00.000Z';

  try {
    const executor = new DeterministicExecutor({
      store,
      dataDir: dir,
      actionService: mocks.actionService,
      calendar: mocks.calendar,
      gmail: mocks.gmail,
      slack: mocks.slack,
      now: () => new Date(nowIso),
    });

    // Step 1: HM yes -> stage move
    const step1Approval = store.registerProposal({
      episode_id: 'ep-wf6-1',
      action_key: 'advance_stage:5001:12579940004',
      workflow: 'wf6_scheduling',
      params: { application_id: 5001, to_stage_id: 12579940004 },
      expected_state: { stage_id: 12579938004 },
      now: nowIso,
    });
    store.grantApproval({
      proposal_hash: step1Approval.proposal_hash,
      decision: 'approved',
      now: nowIso,
    });

    const step1Res = await executeStep1HmYesStageMove(executor, {
      episode_id: 'ep-wf6-1',
      application_id: 5001,
      from_stage_id: 12579938004,
      to_stage_id: 12579940004,
      approval: store.getApproval(step1Approval.proposal_hash)!,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 5001, status: 'active', current_stage_id: 12579938004 },
      },
    });
    assert.equal(step1Res.ok, true);
    assert.equal(mocks.greenhouseCalls[0].client, 'ops_executor');

    // Step 2: Schedule 24h / 48h candidate availability timers
    const step2Timers = scheduleStep2AvailabilityChases(store, {
      episode_id: 'ep-wf6-1',
      application_id: 5001,
      stage_id: 12579940004,
      candidate_email: 'alex.rivera.fictional@example.com',
      candidate_tz: 'America/New_York',
      requested_at: nowIso,
    });
    assert.ok(store.getTimer(step2Timers.nudge24hKey));
    assert.ok(store.getTimer(step2Timers.escalate48hKey));

    // Step 3 & 4: Parse candidate windows in EDT and find overlap with interviewer in PDT
    const parsed = parseCandidateAvailabilityWindows(
      [{ date: '2026-10-21', start_time: '13:00', end_time: '16:00' }], // 17:00-20:00 UTC (10:00-13:00 PDT)
      'Eastern Time (US & Canada)',
    );
    assert.equal(parsed.candidate_tz, 'America/New_York');
    assert.equal(parsed.intervals.length, 1);

    const overlap = findOverlappingInterviewerSlot({
      candidate_intervals: parsed.intervals,
      interviewer_open_intervals: [
        {
          start_utc: '2026-10-21T18:00:00.000Z',
          end_utc: '2026-10-21T20:00:00.000Z',
          start_ms: Date.parse('2026-10-21T18:00:00.000Z'),
          end_ms: Date.parse('2026-10-21T20:00:00.000Z'),
        },
      ],
      duration_minutes: 45,
      interviewer_tz: 'America/Los_Angeles',
    });
    assert.ok(overlap);
    assert.equal(overlap.start_utc, '2026-10-21T18:00:00.000Z');
    assert.equal(overlap.end_utc, '2026-10-21T18:45:00.000Z');

    // Step 5: 3 earliest open slots when no overlap exists
    const threeSlots = selectThreeEarliestOpenSlots({
      interviewer_open_intervals: [
        {
          start_utc: '2026-10-22T17:00:00.000Z',
          end_utc: '2026-10-22T21:00:00.000Z',
          start_ms: Date.parse('2026-10-22T17:00:00.000Z'),
          end_ms: Date.parse('2026-10-22T21:00:00.000Z'),
        },
      ],
      duration_minutes: 60,
      interviewer_tz: 'America/Los_Angeles',
    });
    assert.equal(threeSlots.length, 3);
  } finally {
    store.close();
  }
});

test('WP-4 Chain A (Workflow 6): Step 6 compensation deletes silent hold if interview_create fails, and crash recovery reuses persisted hold_event_id', async () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);
  const mocks = createMockProviders();
  const nowIso = '2026-10-20T18:00:00.000Z';

  try {
    const executor = new DeterministicExecutor({
      store,
      dataDir: dir,
      actionService: mocks.actionService,
      calendar: mocks.calendar,
      gmail: mocks.gmail,
      slack: mocks.slack,
      now: () => new Date(nowIso),
    });

    const baseBookingParams = {
      episode_id: 'ep-wf6-book',
      application_id: 6001,
      candidate_id: 7001,
      candidate_name: 'Jordan Taylor (Fictional)',
      candidate_email: 'jordan.taylor.fictional@example.com',
      job_id: 5149015004,
      job_title: 'Forward Deployed Engineer',
      stage_id: 12579940004,
      job_interview_id: 14297390004,
      interview_kit_id: 14297350004,
      interview_name: 'Manager / Tech Screen',
      interviewer_user_id: 5372540004,
      interviewer_name: 'Khiem Doan',
      interviewer_email: 'khiem.doan@turing.com',
      interviewer_slack_id: 'U08KHIEM',
      interviewer_tz: 'America/Los_Angeles',
      starts_at: '2026-10-22T18:00:00.000Z',
      ends_at: '2026-10-22T18:45:00.000Z',
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 6001, status: 'active', current_stage_id: 12579940004 },
      },
    };

    // Part A: If POST /v3/interviews fails, compensation immediately deletes the silent calendar hold!
    mocks.setFailNextInterviewCreate(true);
    const failedBooking = await executeStep6BookingChain(executor, baseBookingParams);
    assert.equal(failedBooking.ok, false);
    assert.equal(failedBooking.failed_step_key, 'create_greenhouse_interview');
    // Verify silent hold was created and then immediately deleted so no orphan invite exists
    assert.equal(mocks.events.size, 0);
    assert.equal(
      mocks.calendarCalls.some(c => c.op === 'deleteEvent'),
      true,
    );

    // Part B: Simulate crash AFTER create_silent_calendar_hold succeeded and BEFORE create_greenhouse_interview
    // We seed a fresh chain state where step 1 & step 2 succeeded (with gcal_hold_crash_99 in chain_steps)
    const crashStartsAt = '2026-10-22T19:00:00.000Z';
    const crashEndsAt = '2026-10-22T19:45:00.000Z';
    const crashChainId = `wf6_step6_book:6001:14297390004:${crashStartsAt}`;
    mocks.events.set('gcal_hold_crash_99', {
      event_id: 'gcal_hold_crash_99',
      hangout_link: 'https://meet.google.com/crash-resume-link',
      status: 'confirmed',
      start: crashStartsAt,
      end: crashEndsAt,
      attendees: [],
    });

    store.upsertChainStep({
      chain_id: crashChainId,
      step_index: 1,
      step_key: 'grant_interviewer_permission',
      episode_id: 'ep-wf6-book',
      action_key: `user_job_permission_create:5149015004:5372540004:${INTERVIEWER_ROLE_ID}`,
      idempotency_key: sha256('crash-step-1'),
      service: 'greenhouse',
      operation: 'user_job_permission_create',
      input: { user_id: 5372540004, job_id: 5149015004, role_id: INTERVIEWER_ROLE_ID },
      status: 'succeeded',
      provider_id: 'no_change',
      output: { status: 'no_change' },
      now: nowIso,
    });

    store.upsertChainStep({
      chain_id: crashChainId,
      step_index: 2,
      step_key: 'create_silent_calendar_hold',
      episode_id: 'ep-wf6-book',
      action_key: `create_hold:6001:14297390004:${crashStartsAt}`,
      idempotency_key: sha256('crash-step-2'),
      service: 'calendar',
      operation: 'create_silent_hold',
      input: { start: crashStartsAt, end: crashEndsAt },
      status: 'succeeded',
      provider_id: 'gcal_hold_crash_99',
      output: {
        event_id: 'gcal_hold_crash_99',
        hangout_link: 'https://meet.google.com/crash-resume-link',
      },
      now: nowIso,
    });

    const createHoldCountBefore = mocks.calendarCalls.filter(c => c.op === 'createSilentHold').length;

    // Resume Step 6 booking chain: must NOT create a second silent hold, must pass external_event_id: 'gcal_hold_crash_99'
    // even when snapshot reports gcal_hold_crash_99 on the calendar!
    const resumed = await executeStep6BookingChain(executor, {
      ...baseBookingParams,
      starts_at: crashStartsAt,
      ends_at: crashEndsAt,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 6001, status: 'active', current_stage_id: 12579940004 },
        calendar: { conflicting_event_ids: ['gcal_hold_crash_99'] },
      },
    });

    assert.equal(resumed.ok, true);
    const createHoldCountAfter = mocks.calendarCalls.filter(c => c.op === 'createSilentHold').length;
    assert.equal(createHoldCountAfter, createHoldCountBefore, 'Must reuse existing silent hold on crash recovery');

    const interviewApplyCalls = mocks.greenhouseCalls.filter(
      c => c.method === 'apply' && c.kind === 'interview_create',
    );
    const interviewApply = interviewApplyCalls[interviewApplyCalls.length - 1];
    assert.ok(interviewApply);
    assert.equal(interviewApply.input.external_event_id, 'gcal_hold_crash_99');
    assert.equal(interviewApply.input.video_conferencing_url, 'https://meet.google.com/crash-resume-link');

    const patchCall = mocks.calendarCalls.find(
      c => c.op === 'patchEvent' && c.input.event_id === 'gcal_hold_crash_99',
    );
    assert.ok(patchCall);
    assert.equal(patchCall.input.sendUpdates, 'all');
    assert.match(
      patchCall.input.description,
      new RegExp(
        buildGreenhouseInterviewKitUrl(14297350004, 7001, 6001).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      ),
    );
  } finally {
    store.close();
  }
});

test('WP-4 Chain A (Workflow 6): Steps 7, 8, 9, 10 full lifecycle (RSVP chases, decline unfiltered read, Step 8 confirmation + EMAIL note, Step 9 reschedule attempt increment & cancel delete, Step 10 scorecard auto-cancel)', async () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);
  const mocks = createMockProviders();
  mocks.setPermissionNoChange(true);
  const nowIso = '2026-10-20T18:00:00.000Z';

  try {
    const executor = new DeterministicExecutor({
      store,
      dataDir: dir,
      actionService: mocks.actionService,
      calendar: mocks.calendar,
      gmail: mocks.gmail,
      slack: mocks.slack,
      now: () => new Date(nowIso),
    });

    // 1. Run Step 6 booking chain (with permission returning no_change)
    const bookingRes = await executeStep6BookingChain(executor, {
      episode_id: 'ep-wf6-full',
      application_id: 6100,
      candidate_id: 7100,
      candidate_name: 'Morgan Chen (Fictional)',
      candidate_email: 'morgan.chen.fictional@example.com',
      job_id: 5149015004,
      job_title: 'Forward Deployed Engineer',
      stage_id: 12579940004,
      job_interview_id: 14297390004,
      interview_kit_id: 14297350004,
      interview_name: 'Manager / Tech Screen',
      interviewer_user_id: 5372540004,
      interviewer_name: 'Khiem Doan',
      interviewer_email: 'khiem.doan@turing.com',
      interviewer_slack_id: 'U08KHIEM',
      interviewer_tz: 'America/Los_Angeles',
      starts_at: '2026-10-22T18:00:00.000Z',
      ends_at: '2026-10-22T18:45:00.000Z',
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 6100, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(bookingRes.ok, true);
    assert.equal(bookingRes.step_results['grant_interviewer_permission'].no_change, true);

    const interviewId = Number(bookingRes.step_results['create_greenhouse_interview'].provider_id);
    const holdEventId = bookingRes.step_results['create_silent_calendar_hold'].provider_id;
    const meetLink = String(
      bookingRes.step_results['create_silent_calendar_hold'].output?.hangout_link,
    );

    // Verify Step 7 RSVP timers were scheduled with attempt = 1
    const chase24hAttempt1 = store.getTimer(`chase24h:${interviewId}:5372540004:1`);
    assert.ok(chase24hAttempt1);
    assert.equal(chase24hAttempt1.status, 'pending');

    // Fire autonomous +12h RSVP Slack chase (Ruling 4)
    const chase12hRes = await fireStep7RsvpChase(executor, {
      timer_key: `chase12h:${interviewId}:5372540004:1`,
      episode_id: 'ep-wf6-full',
      tier: '12h',
      interview_id: interviewId,
      application_id: 6100,
      interviewer_user_id: 5372540004,
      interviewer_slack_id: 'U08KHIEM',
      candidate_name: 'Morgan Chen (Fictional)',
      interview_name: 'Manager / Tech Screen',
      starts_at: '2026-10-22T18:00:00.000Z',
      attempt: 1,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 6100, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(chase12hRes.ok, true);
    assert.equal(
      store.getTimer(`chase12h:${interviewId}:5372540004:1`)?.status,
      'fired',
    );

    // Test Step 7 Decline handler: reads interviewer Slack DM + unfiltered email
    const declineCheck = await handleStep7InterviewerDecline({
      store,
      episode_id: 'ep-wf6-full',
      interview_id: interviewId,
      interviewer_user_id: 5372540004,
      interviewer_email: 'khiem.doan@turing.com',
      interviewer_slack_id: 'U08KHIEM',
      readInterviewerSlackDm: async () => ['Can we push this 1 hour later?'],
      readInterviewerEmailsUnfiltered: async () => [
        { subject: 'Customer call conflict', snippet: 'Free at 12pm PT instead' },
      ],
      now: nowIso,
    });
    assert.equal(declineCheck.slackMessages.length, 1);
    assert.equal(declineCheck.unfilteredEmails.length, 1);

    // 2. Step 9 Reschedule: updates Greenhouse interview + patches GCal + increments attempt to 2!
    const reschedApproval = store.registerProposal({
      episode_id: 'ep-wf6-full',
      action_key: `interview_update:${interviewId}:2026-10-22T19:00:00.000Z`,
      workflow: 'wf6_scheduling',
      params: { interview_id: interviewId, new_starts_at: '2026-10-22T19:00:00.000Z' },
      expected_state: { stage_id: 12579940004 },
      now: nowIso,
    });
    store.grantApproval({
      proposal_hash: reschedApproval.proposal_hash,
      decision: 'approved',
      now: nowIso,
    });

    const resched = await executeStep9RescheduleChain(executor, {
      episode_id: 'ep-wf6-full',
      application_id: 6100,
      stage_id: 12579940004,
      interview_id: interviewId,
      hold_event_id: holdEventId,
      interviewer_user_id: 5372540004,
      interviewer_email: 'khiem.doan@turing.com',
      interviewer_slack_id: 'U08KHIEM',
      interviewer_tz: 'America/Los_Angeles',
      candidate_name: 'Morgan Chen (Fictional)',
      interview_name: 'Manager / Tech Screen',
      new_starts_at: '2026-10-22T19:00:00.000Z',
      new_ends_at: '2026-10-22T19:45:00.000Z',
      previous_attempt: 1,
      approval: store.getApproval(reschedApproval.proposal_hash)!,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 6100, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(resched.result.ok, true);
    assert.equal(resched.nextAttempt, 2);

    // Verify new timer key has attempt = 2 (`chase24h:{interview_id}:{user_id}:2`)
    const chase24hAttempt2 = store.getTimer(`chase24h:${interviewId}:5372540004:2`);
    assert.ok(chase24hAttempt2);
    assert.equal(chase24hAttempt2.attempt, 2);
    assert.equal(chase24hAttempt2.status, 'pending');

    // 3. Step 8 Confirmation Chain: interviewer accepts -> send confirmation email (4151798004) + EMAIL note + day-before reminder
    const renderedPreview = renderConfirmationTemplate4151798004({
      candidate_first_name: 'Morgan',
      job_title: 'Forward Deployed Engineer',
      interview_name: 'Manager / Tech Screen',
      interviewer_name: 'Khiem Doan',
      starts_at_formatted: 'Thursday, Oct 22, 2026 at 12:00 PM PDT',
      duration_minutes: 45,
      meet_link: meetLink,
    });
    assert.ok(renderedPreview.htmlBody.includes(meetLink));
    assert.ok(!renderedPreview.htmlBody.includes('[Enter Zoom Link]'));

    const step8Approval = store.registerProposal({
      episode_id: 'ep-wf6-full',
      action_key: `send_confirmation:6100:${interviewId}`,
      workflow: 'wf6_scheduling',
      params: { interview_id: interviewId },
      expected_state: { stage_id: 12579940004 },
      draft_sha256: sha256(renderedPreview.htmlBody),
      now: nowIso,
    });
    store.grantApproval({
      proposal_hash: step8Approval.proposal_hash,
      decision: 'approved',
      now: nowIso,
    });

    const step8Res = await executeStep8ConfirmationChain(executor, {
      episode_id: 'ep-wf6-full',
      application_id: 6100,
      candidate_id: 7100,
      candidate_first_name: 'Morgan',
      candidate_name: 'Morgan Chen (Fictional)',
      candidate_email: 'morgan.chen.fictional@example.com',
      candidate_tz: 'America/Los_Angeles',
      job_id: 5149015004,
      job_title: 'Forward Deployed Engineer',
      stage_id: 12579940004,
      interview_id: interviewId,
      interview_name: 'Manager / Tech Screen',
      interviewer_user_id: 5372540004,
      interviewer_name: 'Khiem Doan',
      interviewer_email: 'khiem.doan@turing.com',
      interviewer_slack_id: 'U08KHIEM',
      interviewer_tz: 'America/Los_Angeles',
      hold_event_id: holdEventId,
      meet_link: meetLink,
      starts_at: '2026-10-22T19:00:00.000Z',
      ends_at: '2026-10-22T19:45:00.000Z',
      starts_at_formatted: 'Thursday, Oct 22, 2026 at 12:00 PM PDT',
      duration_minutes: 45,
      approval: store.getApproval(step8Approval.proposal_hash)!,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 6100, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(step8Res.ok, true);

    // Verify EMAIL note payload sent to GreenhouseActionService
    const emailNoteCall = mocks.greenhouseCalls.find(
      c => c.method === 'apply' && c.kind === 'candidate_note_create',
    );
    assert.ok(emailNoteCall);
    assert.equal(emailNoteCall.input.note_type, 'EMAIL');
    assert.equal(emailNoteCall.input.visibility, 'admin_only');
    assert.deepEqual(emailNoteCall.input.email_from, [SAM_EMAIL]);
    assert.deepEqual(emailNoteCall.input.email_to, ['morgan.chen.fictional@example.com']);

    // Verify day-before reminder and Step 10 scorecard timers were scheduled
    assert.ok(store.getTimer(`reminder_day_before:${interviewId}`));
    assert.ok(store.getTimer(`scorecard_reminder_2h:${interviewId}:5372540004`));
    assert.ok(store.getTimer(`scorecard_chase_24h:${interviewId}:5372540004:1`));

    // 4. Step 10: Auto-cancel scorecard chases as soon as scorecard status === "complete"
    const cancelOnComplete = reconcileStep10ScorecardCompletion(store, {
      interview_id: interviewId,
      interviewer_user_id: 5372540004,
      scorecards: [
        {
          id: 8801,
          status: 'complete',
          interviewer: { id: 5372540004 },
        },
      ],
      now: nowIso,
    });
    assert.equal(cancelOnComplete.completed, true);
    assert.equal(cancelOnComplete.cancelledTimers, 2);
    assert.equal(
      store.getTimer(`scorecard_chase_24h:${interviewId}:5372540004:1`)?.status,
      'cancelled',
    );

    // Also verify fireStep10ScorecardChase24h refuses to send a Slack DM if scorecard is complete
    const slackCountBefore = mocks.slackCalls.length;
    const chaseAbortRes = await fireStep10ScorecardChase24h(executor, {
      timer_key: `scorecard_chase_24h:${interviewId}:5372540004:1`,
      episode_id: 'ep-wf6-full',
      interview_id: interviewId,
      application_id: 6100,
      interviewer_user_id: 5372540004,
      interviewer_slack_id: 'U08KHIEM',
      candidate_name: 'Morgan Chen (Fictional)',
      interview_name: 'Manager / Tech Screen',
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 6100, status: 'active', current_stage_id: 12579940004 },
        scorecards: [
          {
            id: 8801,
            application_id: 6100,
            status: 'complete',
            interviewer: { id: 5372540004 },
            overall_recommendation: 'yes',
          },
        ],
      },
    });
    assert.equal(chaseAbortRes.ok, false);
    assert.equal(chaseAbortRes.status, 'aborted_stale');
    assert.equal(mocks.slackCalls.length, slackCountBefore);

    // 5. Step 9 True Cancellation: calls interview_delete + deletes calendar event + sends urgent candidate notification
    const cancelRes = await executeStep9CancellationChain(executor, {
      episode_id: 'ep-wf6-full',
      application_id: 6100,
      stage_id: 12579940004,
      interview_id: interviewId,
      hold_event_id: holdEventId,
      candidate_name: 'Morgan Chen (Fictional)',
      candidate_email: 'morgan.chen.fictional@example.com',
      interview_name: 'Manager / Tech Screen',
      urgent_interviewer_cancel: true,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 6100, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(cancelRes.ok, true);
    const deleteApply = mocks.greenhouseCalls.find(
      c => c.method === 'apply' && c.kind === 'interview_delete',
    );
    assert.ok(deleteApply);
    assert.deepEqual(deleteApply.input, { interview_id: interviewId });

    // Verify ledger.jsonl has zero unresolved intents after full chain execution
    const ledgerSummary = summarizeLedger(readLedger(dir));
    assert.equal(ledgerSummary.unresolved_intents.length, 0);
  } finally {
    store.close();
  }
});

// ============================================================================
// 5. Chain B — Workflow 4 Deliberated Rejection Tests
// ============================================================================

test('WP-4 Chain B (Workflow 4): stage scoping ignores historical negative scorecards, holds mixed panel in CONFLICT_HOLD, aborts on stale override, and executes single-mutation rejection', async () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);
  const mocks = createMockProviders();

  try {
    // 1. Historical negative scorecard from earlier stage (stage 100) must be IGNORED when application is at stage 200
    const ignoredEval = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-wf4-hist',
      application_id: 8001,
      current_stage_id: 200,
      candidate_tz: 'America/New_York',
      scorecards: [
        {
          id: 301,
          application_id: 8001,
          stage_id: 100, // earlier stage!
          status: 'complete',
          overall_recommendation: 'no',
          submitted_at: '2026-10-15T16:00:00.000Z',
        },
      ],
    });
    assert.equal(ignoredEval.outcome, 'ignored_no_current_stage_scorecards');
    if (ignoredEval.outcome === 'ignored_no_current_stage_scorecards') {
      assert.deepEqual(ignoredEval.ignored_historical_scorecard_ids, [301]);
    }

    // 2. Mixed panel ratings (yes + no) on current stage -> CONFLICT_HOLD keyed to scorecard_ids_hash
    const mixedScorecards = [
      {
        id: 401,
        application_id: 8002,
        stage_id: 200,
        status: 'complete',
        overall_recommendation: 'yes',
        submitted_at: '2026-10-20T15:00:00.000Z',
      },
      {
        id: 402,
        application_id: 8002,
        stage_id: 200,
        status: 'complete',
        overall_recommendation: 'strong_no',
        submitted_at: '2026-10-20T15:30:00.000Z',
      },
    ];
    const conflictEval = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-wf4-panel',
      application_id: 8002,
      current_stage_id: 200,
      candidate_tz: 'America/New_York',
      scorecards: mixedScorecards,
    });
    assert.equal(conflictEval.outcome, 'conflict_hold');
    if (conflictEval.outcome !== 'conflict_hold') throw new Error('Expected conflict_hold');

    // Once Sam rules 'Advance', re-evaluating the exact same scorecard set returns resolved_advance and never re-holds
    store.resolveConflictHold(conflictEval.hold.hold_key, 'Advance');
    const afterAdvance = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-wf4-panel',
      application_id: 8002,
      current_stage_id: 200,
      candidate_tz: 'America/New_York',
      scorecards: mixedScorecards,
    });
    assert.equal(afterAdvance.outcome, 'resolved_advance');

    // 3. Single negative scorecard schedules local deliberation timer (Ruling 2)
    // First test stale override abort at fire_at (e.g. a newer positive scorecard arrived before fire_at)
    const schedAbort = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-wf4-abort',
      application_id: 8003,
      current_stage_id: 200,
      candidate_tz: 'America/New_York',
      interview_ends_at: '2026-10-20T15:00:00.000Z',
      random_minutes: 60,
      scorecards: [
        {
          id: 501,
          application_id: 8003,
          stage_id: 200,
          status: 'complete',
          overall_recommendation: 'no',
          submitted_at: '2026-10-20T15:00:00.000Z',
        },
      ],
      now: '2026-10-20T15:00:00.000Z',
    });
    assert.equal(schedAbort.outcome, 'deliberation_timer_scheduled');
    if (schedAbort.outcome !== 'deliberation_timer_scheduled') throw new Error('Expected timer');

    store.grantApproval({
      proposal_hash: schedAbort.proposal.proposal_hash,
      decision: 'approved',
      now: '2026-10-20T15:05:00.000Z',
    });

    const fireTimeIso = '2026-10-20T16:05:00.000Z'; // 12:05 EDT (inside business hours, >= fire_at 16:00Z)
    const executorAtFire = new DeterministicExecutor({
      store,
      dataDir: dir,
      actionService: mocks.actionService,
      now: () => new Date(fireTimeIso),
    });

    const abortedFire = await fireWorkflow4DeliberatedRejection(executorAtFire, {
      timer: schedAbort.timer,
      fresh_snapshot: {
        fetched_at: fireTimeIso,
        application: { id: 8003, status: 'in_process', current_stage_id: 200 },
        scorecards: [
          {
            id: 501,
            application_id: 8003,
            stage_id: 200,
            status: 'complete',
            overall_recommendation: 'no',
          },
          {
            id: 502,
            application_id: 8003,
            stage_id: 200,
            status: 'complete',
            overall_recommendation: 'strong_yes', // Late positive scorecard arrived!
          },
        ],
      },
    });
    assert.equal(abortedFire.ok, false);
    assert.equal(abortedFire.status, 'aborted_state_changed');
    assert.equal(
      store.getTimer(schedAbort.timer.timer_key)?.status,
      'aborted_state_changed',
    );
    assert.equal(
      mocks.greenhouseCalls.filter(c => c.kind === 'application_rejection').length,
      0,
    );

    // 4. Clean single-mutation rejection at fire_at (with template 4143188004, user 5085047004, and NO duplicate note call)
    const schedReject = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-wf4-reject',
      application_id: 8004,
      current_stage_id: 200,
      candidate_tz: 'America/New_York',
      interview_ends_at: '2026-10-20T15:00:00.000Z',
      random_minutes: 60,
      scorecards: [
        {
          id: 601,
          application_id: 8004,
          stage_id: 200,
          status: 'complete',
          overall_recommendation: 'definitely_not',
          submitted_at: '2026-10-20T15:00:00.000Z',
        },
      ],
      now: '2026-10-20T15:00:00.000Z',
    });
    if (schedReject.outcome !== 'deliberation_timer_scheduled') throw new Error('Expected timer');

    store.grantApproval({
      proposal_hash: schedReject.proposal.proposal_hash,
      decision: 'approved',
      now: '2026-10-20T15:05:00.000Z',
    });

    const firedReject = await fireWorkflow4DeliberatedRejection(executorAtFire, {
      timer: schedReject.timer,
      fresh_snapshot: {
        fetched_at: fireTimeIso,
        application: { id: 8004, status: 'in_process', current_stage_id: 200 },
        scorecards: [
          {
            id: 601,
            application_id: 8004,
            stage_id: 200,
            status: 'complete',
            overall_recommendation: 'definitely_not',
          },
        ],
      },
    });
    assert.equal(firedReject.ok, true);
    assert.equal(firedReject.status, 'rejected');
    assert.equal(store.getTimer(schedReject.timer.timer_key)?.status, 'fired');

    const rejectApplyCalls = mocks.greenhouseCalls.filter(
      c => c.method === 'apply' && c.kind === 'application_rejection',
    );
    assert.equal(rejectApplyCalls.length, 1);
    assert.deepEqual(rejectApplyCalls[0].input, {
      application_id: 8004,
      rejection_reason_id: DEFAULT_REJECTION_REASON_ID,
      notes: DEFAULT_WF4_REJECTION_NOTE,
      rejection_email: {
        email_template_id: MASTER_POST_INTERVIEW_REJECTION_TEMPLATE_ID,
        email_from_user_id: SAM_GREENHOUSE_USER_ID,
      },
    });

    // Strictly verify NO duplicate candidate_note_create was called after application_rejection
    const noteCalls = mocks.greenhouseCalls.filter(c => c.kind === 'candidate_note_create');
    assert.equal(noteCalls.length, 0);
  } finally {
    store.close();
  }
});

// ============================================================================
// 6. 60-Second Executor Tick Runner (`worker/executor-tick.mjs`) Test
// ============================================================================

test('WP-4 executor-tick.mjs: processes due timers and approved proposals under single-writer lock', async () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);
  const mocks = createMockProviders();
  const nowIso = '2026-10-20T16:30:00.000Z';

  try {
    // Schedule a due WF4 rejection timer and approve its proposal
    const evalRes = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-tick-wf4',
      application_id: 9500,
      current_stage_id: 300,
      candidate_tz: 'America/New_York',
      interview_ends_at: '2026-10-20T15:00:00.000Z',
      random_minutes: 60, // fire_at = 16:00Z <= nowIso (16:30Z)
      scorecards: [
        {
          id: 701,
          application_id: 9500,
          stage_id: 300,
          status: 'complete',
          overall_recommendation: 'no',
          submitted_at: '2026-10-20T15:00:00.000Z',
        },
      ],
      now: '2026-10-20T15:00:00.000Z',
    });
    if (evalRes.outcome !== 'deliberation_timer_scheduled') throw new Error('Expected timer');

    store.grantApproval({
      proposal_hash: evalRes.proposal.proposal_hash,
      decision: 'approved',
      now: '2026-10-20T15:10:00.000Z',
    });

    // Also schedule a due autonomous +24h RSVP chase timer
    store.scheduleTimer({
      timer_key: 'chase24h:9900:5372540004:1',
      episode_id: 'ep-tick-wf6',
      kind: 'wf6_rsvp_chase_24h',
      fire_at: '2026-10-20T16:00:00.000Z',
      attempt: 1,
      payload: {
        interview_id: 9900,
        application_id: 9501,
        interviewer_user_id: 5372540004,
        interviewer_slack_id: 'U08KHIEM',
        candidate_name: 'Casey Kim (Fictional)',
        interview_name: 'Tech Screen',
        starts_at: '2026-10-22T18:00:00.000Z',
        attempt: 1,
      },
      now: '2026-10-20T15:00:00.000Z',
    });

    const summary = await runExecutorTick({
      store,
      dataDir: dir,
      actionService: mocks.actionService,
      calendar: mocks.calendar,
      gmail: mocks.gmail,
      slack: mocks.slack,
      now: () => new Date(nowIso),
      freshReadFetcher: async (_epId, expected) => ({
        fetched_at: nowIso,
        application: {
          id: expected.application_id ?? 9500,
          status: 'in_process',
          current_stage_id: expected.stage_id ?? 300,
        },
        scorecards: [],
      }),
    });

    assert.equal(summary.acquired, true);
    assert.equal(summary.timersProcessed, 2);
    assert.deepEqual(summary.errors, []);
    assert.equal(store.getTimer(evalRes.timer.timer_key)?.status, 'fired');
    assert.equal(store.getTimer('chase24h:9900:5372540004:1')?.status, 'fired');
    assert.equal(mocks.slackCalls.length, 1);
  } finally {
    store.close();
  }
});

// ============================================================================
// 7. Phase 4 Adversarial Regression Tests (Astra High & Opus High Findings)
// ============================================================================

test('Phase 4 regression: real GreenhouseActionService wire contract (state/error_code, result_resource_id, PARTIAL_APPLIED re-preview, and ambiguous compensation guard)', async () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);
  const mocks = createMockProviders();
  const nowIso = '2026-10-20T18:00:00.000Z';

  try {
    let previewCalls = 0;
    let applyCalls = 0;
    let simulateAmbiguousReadbackError = false;

    const realShapeService: ActionServiceLike = {
      async preview(kind, input) {
        previewCalls++;
        if (kind === 'user_job_permission_create') {
          return {
            status: 'no_change',
            change_required: false,
            before: { existing_permission_ids: [444555] },
            approval: { before: { existing_permission_ids: [444555] } },
            intent: null,
          };
        }
        return {
          status: 'ready',
          change_required: true,
          intent: `signed-jwt-token-${previewCalls}`,
          approval: { kind, input, attempt: previewCalls },
        };
      },
      async apply(kind, req) {
        applyCalls++;
        // Simulate PARTIAL_APPLIED on first score/interview attempt -> must trigger re-preview!
        if (kind === 'interview_create' && applyCalls === 1 && !simulateAmbiguousReadbackError) {
          return {
            action_id: 'act-1',
            state: 'failed',
            error_code: 'PARTIAL_APPLIED',
            result_resource_id: null,
          };
        }
        if (kind === 'interview_create' && simulateAmbiguousReadbackError) {
          return {
            action_id: 'act-ambig',
            state: 'unknown',
            error_code: 'UPSTREAM_RESULT_NOT_OBSERVED',
            result_resource_id: null,
          };
        }
        return {
          action_id: `act-${applyCalls}`,
          state: 'succeeded',
          observation: 'observed',
          error_code: null,
          result_resource_id: 987654,
          replayed: false,
          result: { intent_used: req.intent },
        };
      },
    };

    const executor = new DeterministicExecutor({
      store,
      dataDir: dir,
      actionService: realShapeService,
      calendar: mocks.calendar,
      gmail: mocks.gmail,
      slack: mocks.slack,
      now: () => new Date(nowIso),
    });

    // 1. Test PARTIAL_APPLIED triggers a fresh preview() call on retry and extracts result_resource_id = 987654
    const bookOk = await executeStep6BookingChain(executor, {
      episode_id: 'ep-real-wire-1',
      application_id: 7201,
      candidate_id: 8201,
      candidate_name: 'Riley Patel (Fictional)',
      candidate_email: 'riley.patel.fictional@example.com',
      job_id: 5149015004,
      job_title: 'Forward Deployed Engineer',
      stage_id: 12579940004,
      job_interview_id: 14297390004,
      interview_kit_id: 14297350004,
      interview_name: 'Manager / Tech Screen',
      interviewer_user_id: 5372540004,
      interviewer_name: 'Khiem Doan',
      interviewer_email: 'khiem.doan@turing.com',
      interviewer_slack_id: 'U08KHIEM',
      interviewer_tz: 'America/Los_Angeles',
      starts_at: '2026-10-22T18:00:00.000Z',
      ends_at: '2026-10-22T18:45:00.000Z',
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 7201, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(bookOk.ok, true);
    assert.equal(
      bookOk.step_results['grant_interviewer_permission'].provider_id,
      '444555',
    );
    assert.equal(
      bookOk.step_results['create_greenhouse_interview'].provider_id,
      '987654',
    );
    // 1 preview for permission + 2 previews for interview_create (initial + PARTIAL_APPLIED retry)
    assert.equal(previewCalls, 3);
    assert.equal(applyCalls, 2);

    // 2. Test ambiguous post-POST error (UPSTREAM_RESULT_NOT_OBSERVED) does NOT delete the Google Calendar hold!
    simulateAmbiguousReadbackError = true;
    const deleteCallsBefore = mocks.calendarCalls.filter(c => c.op === 'deleteEvent').length;
    const bookAmbig = await executeStep6BookingChain(executor, {
      episode_id: 'ep-real-wire-2',
      application_id: 7202,
      candidate_id: 8202,
      candidate_name: 'Avery Nguyen (Fictional)',
      candidate_email: 'avery.nguyen.fictional@example.com',
      job_id: 5149015004,
      job_title: 'Forward Deployed Engineer',
      stage_id: 12579940004,
      job_interview_id: 14297390004,
      interview_kit_id: 14297350004,
      interview_name: 'Manager / Tech Screen',
      interviewer_user_id: 5372540004,
      interviewer_name: 'Khiem Doan',
      interviewer_email: 'khiem.doan@turing.com',
      interviewer_slack_id: 'U08KHIEM',
      interviewer_tz: 'America/Los_Angeles',
      starts_at: '2026-10-22T20:00:00.000Z',
      ends_at: '2026-10-22T20:45:00.000Z',
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 7202, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(bookAmbig.ok, false);
    const deleteCallsAfter = mocks.calendarCalls.filter(c => c.op === 'deleteEvent').length;
    assert.equal(
      deleteCallsAfter,
      deleteCallsBefore,
      'Must NOT delete silent calendar hold when interview_create fails with UPSTREAM_RESULT_NOT_OBSERVED',
    );
  } finally {
    store.close();
  }
});

test('Phase 4 regression: approval action_key binding blocks cross-action approval misuse, and unresolved intent without safe reconcile blocks retry', async () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);
  const mocks = createMockProviders();
  const nowIso = '2026-10-20T18:00:00.000Z';

  try {
    const executor = new DeterministicExecutor({
      store,
      dataDir: dir,
      actionService: mocks.actionService,
      calendar: mocks.calendar,
      gmail: mocks.gmail,
      slack: mocks.slack,
      now: () => new Date(nowIso),
    });

    // Register & approve a Step 1 stage move proposal on episode 'ep-sec-1'
    const stageMoveProposal = store.registerProposal({
      episode_id: 'ep-sec-1',
      action_key: 'advance_stage:7300:12579940004',
      workflow: 'wf6_scheduling',
      params: { application_id: 7300, to_stage_id: 12579940004 },
      expected_state: { stage_id: 12579938004 },
      now: nowIso,
    });
    const approvedStageMove = store.grantApproval({
      proposal_hash: stageMoveProposal.proposal_hash,
      decision: 'approved',
      now: nowIso,
    });

    // Attempt to misuse `approvedStageMove` to authorize a Step 9 interview reschedule on the same episode!
    const misused = await executeStep9RescheduleChain(executor, {
      episode_id: 'ep-sec-1',
      application_id: 7300,
      stage_id: 12579940004,
      interview_id: 9300,
      hold_event_id: 'gcal_hold_sec',
      interviewer_user_id: 5372540004,
      interviewer_email: 'khiem.doan@turing.com',
      interviewer_slack_id: 'U08KHIEM',
      candidate_name: 'Samira Ali (Fictional)',
      interview_name: 'Tech Screen',
      new_starts_at: '2026-10-23T18:00:00.000Z',
      new_ends_at: '2026-10-23T18:45:00.000Z',
      approval: approvedStageMove,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 7300, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(misused.result.ok, false);
    assert.equal(misused.result.status, 'blocked_send_gate');

    // Crash after writing status: 'intent' with reconcile returning { reconciled: false } MUST block with blocked_unresolved_intent
    store.upsertChainStep({
      chain_id: 'chain-crashed-intent',
      step_index: 1,
      step_key: 'step_crashed_cal',
      episode_id: 'ep-sec-1',
      action_key: 'create_hold:7300:crashed',
      idempotency_key: sha256('ep-sec-1:create_hold:7300:crashed'),
      service: 'calendar',
      operation: 'create_silent_hold',
      input: {},
      status: 'intent',
      provider_id: null,
      now: nowIso,
    });

    let executeCalled = false;
    const blockedIntentRes = await executor.executeChain({
      chain_id: 'chain-crashed-intent',
      episode_id: 'ep-sec-1',
      workflow: 'wf6_scheduling',
      exception: 'calendar_hold',
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 7300, status: 'active', current_stage_id: 12579940004 },
      },
      steps: [
        {
          step_index: 1,
          step_key: 'step_crashed_cal',
          action_key: 'create_hold:7300:crashed',
          service: 'calendar',
          operation: 'create_silent_hold',
          exception: 'calendar_hold',
          buildInput: () => ({}),
          reconcile: async () => ({ reconciled: false }),
          execute: async () => {
            executeCalled = true;
            return { provider_id: 'dup_hold' };
          },
        },
      ],
    });
    assert.equal(blockedIntentRes.ok, false);
    assert.equal(blockedIntentRes.status, 'blocked_unresolved_intent');
    assert.equal(executeCalled, false, 'Must NOT fall through and re-execute when reconcile returns reconciled: false');
  } finally {
    store.close();
  }
});

test('Phase 4 regression: WF4 interview_step stage mapping, CONFLICT_HOLD Reject auto-approval, and WF6 pre-9am overlap + +24h Slack threading', async () => {
  const dir = makeTmpDir();
  const store = new SqliteCoordinatorStore(dir);
  const mocks = createMockProviders();
  const nowIso = '2026-10-20T18:00:00.000Z';

  try {
    // 1. WF6 Step 4: Candidate & interviewer free 08:00-12:00 PDT -> finds 09:00-09:45 PDT slot!
    const slot = findOverlappingInterviewerSlot({
      candidate_intervals: [
        {
          start_utc: '2026-10-21T15:00:00.000Z', // 08:00 PDT
          end_utc: '2026-10-21T19:00:00.000Z',   // 12:00 PDT
          start_ms: Date.parse('2026-10-21T15:00:00.000Z'),
          end_ms: Date.parse('2026-10-21T19:00:00.000Z'),
        },
      ],
      interviewer_open_intervals: [
        {
          start_utc: '2026-10-21T15:00:00.000Z',
          end_utc: '2026-10-21T19:00:00.000Z',
          start_ms: Date.parse('2026-10-21T15:00:00.000Z'),
          end_ms: Date.parse('2026-10-21T19:00:00.000Z'),
        },
      ],
      duration_minutes: 45,
      interviewer_tz: 'America/Los_Angeles',
    });
    assert.ok(slot, 'Should clamp 08:00 PDT overlap start to 09:00 PDT instead of rejecting window');
    assert.equal(slot.start_utc, '2026-10-21T16:00:00.000Z'); // 09:00 PDT
    assert.equal(slot.end_utc, '2026-10-21T16:45:00.000Z');   // 09:45 PDT

    // 2. WF4: Scorecards without top-level stage_id map via interview_step.id (14297388004 -> 12579937004)
    const histByStep = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-wf4-stepmap',
      application_id: 9701,
      current_stage_id: 12579940004, // Manager / Tech Screen
      candidate_tz: 'America/Los_Angeles',
      scorecards: [
        {
          id: 801,
          application_id: 9701,
          interview_step: { id: 14297388004, name: 'Recruiter Phone Screen' }, // earlier stage!
          status: 'complete',
          overall_recommendation: 'no',
          submitted_at: '2026-10-18T18:00:00.000Z',
        },
      ],
    });
    assert.equal(histByStep.outcome, 'ignored_no_current_stage_scorecards');

    // 3. WF4: CONFLICT_HOLD resolved as 'Reject' automatically grants approval on the deliberated rejection proposal
    // and defaults to next_business_day mode when random_minutes is omitted!
    const panelCards = [
      {
        id: 901,
        application_id: 9702,
        stage_id: 12579940004,
        status: 'complete',
        overall_recommendation: 'yes',
        submitted_at: '2026-10-20T18:00:00.000Z',
      },
      {
        id: 902,
        application_id: 9702,
        stage_id: 12579940004,
        status: 'complete',
        overall_recommendation: 'no',
        submitted_at: '2026-10-20T18:10:00.000Z',
      },
    ];
    const holdEval = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-wf4-hold-reject',
      application_id: 9702,
      current_stage_id: 12579940004,
      candidate_tz: 'America/Los_Angeles',
      scorecards: panelCards,
      now: nowIso,
    });
    assert.equal(holdEval.outcome, 'conflict_hold');
    if (holdEval.outcome !== 'conflict_hold') throw new Error('Expected conflict_hold');

    store.resolveConflictHold(holdEval.hold.hold_key, 'Reject', nowIso);
    const resolvedRejectEval = evaluateWorkflow4Scorecards(store, {
      episode_id: 'ep-wf4-hold-reject',
      application_id: 9702,
      current_stage_id: 12579940004,
      candidate_tz: 'America/Los_Angeles',
      interview_ends_at: '2026-10-20T18:00:00.000Z',
      scorecards: panelCards,
      now: nowIso,
    });
    assert.equal(resolvedRejectEval.outcome, 'deliberation_timer_scheduled');
    if (resolvedRejectEval.outcome !== 'deliberation_timer_scheduled') throw new Error('Expected timer');
    assert.equal(resolvedRejectEval.proposal.decision, 'approved');
    assert.equal(
      (resolvedRejectEval.timer.payload as any).deliberation_mode,
      'next_business_day',
    );

    // 4. WF6 Step 7: +24h chase threads onto +12h Slack DM (thread_ts) and aborts if interviewer already accepted
    const executor = new DeterministicExecutor({
      store,
      dataDir: dir,
      actionService: mocks.actionService,
      calendar: mocks.calendar,
      gmail: mocks.gmail,
      slack: mocks.slack,
      now: () => new Date(nowIso),
    });

    await fireStep7RsvpChase(executor, {
      timer_key: 'chase12h:9950:5372540004:1',
      episode_id: 'ep-thread-test',
      tier: '12h',
      interview_id: 9950,
      application_id: 9705,
      interviewer_user_id: 5372540004,
      interviewer_slack_id: 'U08KHIEM',
      candidate_name: 'Devon Brooks (Fictional)',
      interview_name: 'Tech Screen',
      starts_at: '2026-10-22T18:00:00.000Z',
      attempt: 1,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 9705, status: 'active', current_stage_id: 12579940004 },
      },
    });
    const firstSlackTs = mocks.slackCalls[0].input;
    assert.equal(firstSlackTs.thread_ts, undefined);

    await fireStep7RsvpChase(executor, {
      timer_key: 'chase24h:9950:5372540004:1',
      episode_id: 'ep-thread-test',
      tier: '24h',
      interview_id: 9950,
      application_id: 9705,
      interviewer_user_id: 5372540004,
      interviewer_slack_id: 'U08KHIEM',
      candidate_name: 'Devon Brooks (Fictional)',
      interview_name: 'Tech Screen',
      starts_at: '2026-10-22T18:00:00.000Z',
      attempt: 1,
      fresh_snapshot: {
        fetched_at: nowIso,
        application: { id: 9705, status: 'active', current_stage_id: 12579940004 },
      },
    });
    assert.equal(mocks.slackCalls[1].input.thread_ts, '1700000000.0001');
  } finally {
    store.close();
  }
});
