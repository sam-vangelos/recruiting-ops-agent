import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  renderPendingApprovalsMarkdown,
  syncCheckpointToCoordinatorStore,
} from '../src/bridge/checkpoint-ingest.ts';
import {
  DeterministicExecutor,
  verifyFreshState,
} from '../src/executor/index.ts';
import {
  createGreenhouseV3HttpReadAdapter,
  createLiveFreshReadFetcher,
  createLiveProviders,
  FreshReadError,
  LiveCalendarProvider,
  LiveGmailProvider,
  LiveSlackProvider,
  ProviderTimeoutError,
  ProviderTransportError,
  SendGateBlockedError,
} from '../src/providers/live-providers.ts';
import {
  SqliteCoordinatorStore,
} from '../src/store/sqlite.ts';
import {
  ingestBookingSignal,
} from '../src/workflows/wf1-intake.ts';
import {
  evaluateWorkflow4Scorecards,
} from '../src/workflows/wf4-rejection.ts';
import {
  checkRuntimeDeployment,
  deployRuntime,
} from '../tools/deploy-runtime.mjs';
import {
  runCli,
  runExecutorTick,
  sanitizeParams,
} from '../worker/executor-tick.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

function makeTempDir(prefix = 'chunk4-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('Chunk 4 Phase 1.1: Live Providers & FreshReadFetcher', () => {
  it('assembles a live FreshReadSnapshot across Greenhouse, Gmail, Calendar, and Slack and passes verifyFreshState', async () => {
    const dir = makeTempDir();
    const store = new SqliteCoordinatorStore(dir);
    try {
      const fixedNow = new Date('2026-10-21T16:00:00.000Z');
      store.upsertEpisode({
        episode_id: 'ep-live-1',
        workflow: 'wf4_rejection',
        application_id: 7001001,
        stage_id: 12579940004,
        status: 'deliberation_holding',
        state: {
          gmail_thread_id: 'thread-abc',
          channel_id: 'C0123456',
          message_ts: '1729500000.000100',
        },
        now: fixedNow.toISOString(),
      });

      const fetcher = createLiveFreshReadFetcher({
        store,
        now: () => fixedNow,
        greenhouse: {
          getApplication: async appId => ({
            id: appId,
            candidate_id: 8001,
            job_id: 5149015004,
            status: 'in_process',
            current_stage_id: 12579940004,
          }),
          listScorecards: async appId => [
            {
              id: 9101,
              application_id: appId,
              stage_id: 12579940004,
              status: 'complete',
              overall_recommendation: 'no',
            },
          ],
          listInterviews: async () => [
            {
              id: 5501,
              status: 'scheduled',
              interviewers: [{ user_id: 9901, response_status: 'needs_action' }],
            },
          ],
        },
        gmail: {
          getThreadState: async ({ thread_id }) => ({
            thread_id,
            last_message_id: 'msg-100',
            has_unsent_sam_draft: false,
            has_newer_candidate_reply: false,
            candidate_withdrew: false,
          }),
        },
        calendar: {
          getBusyIntervals: async () => ({
            busy_intervals: [],
          }),
        },
        slack: {
          getMessageState: async () => ({
            reaction_removed: false,
            hm_override_detected: false,
          }),
        },
      });

      const expected = {
        application_id: 7001001,
        application_status: 'in_process' as const,
        stage_id: 12579940004,
        negative_scorecard_id: 9101,
        require_no_positive_scorecard: true,
        require_interviewer_rsvp_pending: {
          interview_id: 5501,
          interviewer_user_id: 9901,
        },
        gmail_last_message_id: 'msg-100',
        require_no_unsent_sam_draft: true,
        calendar_Check: {
          start: '2026-10-22T17:00:00.000Z',
          end: '2026-10-22T17:30:00.000Z',
        },
        require_no_reaction_removal: true,
        require_no_hm_override: true,
      };

      const snapshot = await fetcher('ep-live-1', expected);
      assert.equal(snapshot.fetched_at, fixedNow.toISOString());
      assert.equal(snapshot.application?.id, 7001001);
      assert.equal(snapshot.scorecards?.length, 1);
      assert.equal(snapshot.interviews?.length, 1);
      assert.equal(snapshot.gmail?.last_message_id, 'msg-100');
      assert.deepEqual(snapshot.calendar?.busy_intervals, []);
      assert.equal(snapshot.slack?.hm_override_detected, false);
      assert.equal(snapshot.slack?.reaction_removed, false);

      const gate = verifyFreshState(snapshot, expected, {
        nowMs: fixedNow.getTime() + 5_000,
      });
      assert.equal(gate.ok, true);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when any required read adapter is missing, returns null, or throws', async () => {
    const fetcherMissingGh = createLiveFreshReadFetcher({});
    await assert.rejects(
      () => fetcherMissingGh('ep-1', { application_id: 12345 }),
      (err: any) =>
        err instanceof FreshReadError &&
        err.code === 'GREENHOUSE_READ_UNCONFIGURED',
    );

    const fetcherMissingGmail = createLiveFreshReadFetcher({
      greenhouse: {
        getApplication: async id => ({
          id,
          status: 'active',
          current_stage_id: 10,
        }),
      },
    });
    await assert.rejects(
      () =>
        fetcherMissingGmail('ep-1', {
          application_id: 12345,
          require_no_unsent_sam_draft: true,
        }),
      (err: any) =>
        err instanceof FreshReadError && err.code === 'GMAIL_READ_UNCONFIGURED',
    );

    const fetcherMissingCal = createLiveFreshReadFetcher({});
    await assert.rejects(
      () =>
        fetcherMissingCal('ep-1', {
          calendar_Check: {
            start: '2026-10-22T17:00:00Z',
            end: '2026-10-22T17:30:00Z',
          },
        }),
      (err: any) =>
        err instanceof FreshReadError &&
        err.code === 'CALENDAR_READ_UNCONFIGURED',
    );

    const fetcherMissingSlack = createLiveFreshReadFetcher({});
    await assert.rejects(
      () =>
        fetcherMissingSlack('ep-1', {
          require_no_reaction_removal: true,
        }),
      (err: any) =>
        err instanceof FreshReadError && err.code === 'SLACK_READ_UNCONFIGURED',
    );
  });

  it('supports Greenhouse v3 HTTP read adapter and surfaces busy_intervals / hm_override_detected in verifyFreshState', async () => {
    const ghAdapter = createGreenhouseV3HttpReadAdapter({
      baseUrl: 'https://harvest.example.test',
      accessToken: 'test-token',
      fetchFn: (async (url: string) => {
        if (url.includes('/v3/applications/777')) {
          return new Response(
            JSON.stringify({
              id: 777,
              candidate_id: 888,
              status: 'active',
              current_stage: { id: 12579937004 },
            }),
            { status: 200 },
          );
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
    });

    const app = await ghAdapter.getApplication(777);
    assert.equal(app?.id, 777);
    assert.equal(app?.current_stage_id, 12579937004);

    await assert.rejects(
      () => ghAdapter.getApplication(999),
      (err: any) => err instanceof ProviderTransportError && err.statusCode === 404,
    );

    const nowIso = '2026-10-21T16:00:00.000Z';
    const busyGate = verifyFreshState(
      {
        fetched_at: nowIso,
        calendar: {
          busy_intervals: [
            {
              start: '2026-10-22T17:00:00Z',
              end: '2026-10-22T17:30:00Z',
              event_id: 'evt-conflict-1',
            },
          ],
        },
      },
      { calendar_Check: true },
      { nowMs: Date.parse(nowIso) + 1000 },
    );
    assert.equal(busyGate.ok, false);
    assert.equal(busyGate.code, 'CALENDAR_CONFLICT');

    const slackGate = verifyFreshState(
      {
        fetched_at: nowIso,
        slack: {
          hm_override_detected: true,
        },
      },
      { require_no_hm_override: true },
      { nowMs: Date.parse(nowIso) + 1000 },
    );
    assert.equal(slackGate.ok, false);
    assert.equal(slackGate.code, 'SLACK_HM_OVERRIDE');
  });

  it('supports adapter, HTTP, CLI bridge, timeout, dry-run mode, and send-gate blocking on Calendar/Gmail/Slack providers', async () => {
    // 1. Timeout enforcement
    const slowGmail = new LiveGmailProvider({
      timeoutMs: 30,
      transport: {
        type: 'adapter',
        invoke: async () => {
          await new Promise(r => setTimeout(r, 150));
          return { message_id: 'late' };
        },
      },
    });
    await assert.rejects(
      () =>
        slowGmail.sendMessage({
          to: 'candidate@example.test',
          subject: 'Hello',
          htmlBody: '<p>Hi</p>',
        }),
      (err: any) => err instanceof ProviderTimeoutError && err.service === 'gmail',
    );

    // 2. Send-gate blocking when unapproved
    const gatedSlack = new LiveSlackProvider({
      gateContext: {
        action_key: 'slack_dm:1',
        episode_id: 'ep-1',
        approval: null,
        exception: null,
      },
      transport: {
        type: 'adapter',
        invoke: async () => ({ ts: '1.1', channel: 'C1' }),
      },
    });
    await assert.rejects(
      () => gatedSlack.sendMessage({ channel: 'C1', text: 'Unapproved DM' }),
      (err: any) => err instanceof SendGateBlockedError,
    );

    // 3. CLI transport bridge
    const cliCal = new LiveCalendarProvider({
      transport: {
        type: 'cli',
        command: process.execPath,
        args: [
          '-e',
          `const [service, op, payloadJson] = process.argv.slice(1);
           const p = JSON.parse(payloadJson);
           process.stdout.write(JSON.stringify({ event_id: 'cli_evt_1', summary: p.summary, status: 'confirmed' }));`,
        ],
      },
    });
    const hold = await cliCal.createSilentHold({
      summary: 'Hold — Candidate',
      start: '2026-10-22T17:00:00Z',
      end: '2026-10-22T17:45:00Z',
    });
    assert.equal(hold.event_id, 'cli_evt_1');

    // 4. Dry-run mode logs intended calls without mutating external services
    const providers = createLiveProviders({ dryRun: true });
    const dryHold = await providers.calendar.createSilentHold({
      summary: 'Dry Run Hold',
      start: '2026-10-22T18:00:00Z',
      end: '2026-10-22T18:30:00Z',
    });
    const dryEmail = await providers.gmail.sendMessage({
      to: 'cand@example.test',
      subject: 'Dry Run Subject',
      htmlBody: '<p>Dry Run</p>',
    });
    const drySlack = await providers.slack.sendMessage({
      channel: 'C123',
      text: 'Dry Run Slack',
    });
    assert.ok(dryHold.event_id.startsWith('dryrun_calendar_create_silent_hold_'));
    assert.ok(dryEmail.message_id.startsWith('dryrun_gmail_send_message_'));
    assert.ok(drySlack.ts.startsWith('dryrun_slack_send_message_'));
    assert.equal(providers.dryRunLog.length, 3);
  });
});

describe('Chunk 4 Phase 1.2: Checkpoint-to-SQLite Ingestion Bridge', () => {
  it('idempotently ingests checkpoint episodes/proposals without resetting in-progress chain_steps, granted approvals, or consumed HM signals', () => {
    const dir = makeTempDir();
    const store = new SqliteCoordinatorStore(dir);
    try {
      const now = '2026-10-21T16:30:00.000Z';

      // Pre-populate an in-progress chain_step and a claimed WF3 HM signal
      store.upsertEpisode({
        episode_id: 'ep-in-flight',
        workflow: 'wf3_hm_signal',
        application_id: 5001,
        stage_id: 12579937004,
        status: 'AWAITING_MANUAL_NOTES',
        state: { custom_field: 'keep_me' },
        now,
      });
      store.upsertChainStep({
        chain_id: 'chain-in-flight-1',
        step_index: 1,
        step_key: 'move_stage',
        episode_id: 'ep-in-flight',
        action_key: 'move_stage:5001',
        idempotency_key: 'idem-in-flight-1',
        service: 'greenhouse',
        operation: 'application_stage_move',
        input: { application_id: 5001 },
        status: 'dispatched',
        provider_id: 'gh-prov-1',
        now,
      });
      store.claimHmSignal({
        signal_key: 'sig:5001:12579937004',
        application_id: 5001,
        stage_id: 12579937004,
        channel_id: 'C999',
        message_ts: '1729500.1',
        reactor_or_reply_id: 'U_HM',
        target_stage_id: 12579939004,
        episode_id: 'ep-in-flight',
        details: { note: 'original_claim' },
        now,
      });

      const checkpoint = {
        scanned_at: now,
        report: {
          episodes: [
            {
              episode_id: 'ep-in-flight',
              status: 'open',
              workflow: 'wf3_hm_signal',
              application_id: 5001,
              candidate_name: 'Alex Rivera',
              facts: [{ text: 'HM reacted positively on application_id: 5001' }],
              next_actions: [
                {
                  action_key: 'advance_and_email:5001',
                  text: 'Advance Alex Rivera to Turing Assessment',
                  draft: 'Hi Alex, we would love to invite you to the next stage.',
                  evidence: ['r1'],
                },
              ],
              unknowns: [],
            },
            {
              episode_id: 'ep-sched-2',
              status: 'open',
              workflow: 'wf6_scheduling',
              application_id: 5002,
              candidate_name: 'Jordan Lee',
              facts: [{ text: 'Candidate shared availability' }],
              next_actions: [
                {
                  action_key: 'confirm_interview:5002',
                  text: 'Send calendar invite and confirmation email to Jordan Lee',
                  draft: 'Hi Jordan, your interview is confirmed for Thursday at 10am PT.',
                  evidence: ['r2'],
                },
              ],
              unknowns: [],
            },
          ],
          unknowns: [],
        },
        hm_signals: [
          {
            signal_key: 'sig:5001:12579937004',
            application_id: 5001,
            stage_id: 12579937004,
            channel_id: 'C999',
            message_ts: '1729500.1',
            reactor_or_reply_id: 'U_HM',
            target_stage_id: 999999,
            episode_id: 'ep-in-flight',
            details: { note: 'attempted_overwrite' },
          },
        ],
      };

      const firstSync = syncCheckpointToCoordinatorStore(store, checkpoint, {
        dataDir: dir,
        now,
      });
      assert.equal(firstSync.episodes_upserted, 2);
      assert.equal(firstSync.episodes_preserved_in_flight, 1);
      assert.equal(firstSync.proposals_registered, 2);
      assert.equal(firstSync.hm_signals_preserved, 1);
      assert.equal(firstSync.pending_approvals.length, 2);

      // Approve one proposal before re-ingesting the same checkpoint
      const approvedHash = firstSync.pending_approvals[0].proposal_hash;
      store.grantApproval({
        proposal_hash: approvedHash,
        decision: 'approved',
        now,
      });

      // Re-ingest identical checkpoint
      const secondSync = syncCheckpointToCoordinatorStore(store, checkpoint, {
        dataDir: dir,
        now: '2026-10-21T16:35:00.000Z',
      });
      assert.equal(secondSync.proposals_registered, 0);
      assert.equal(secondSync.proposals_preserved, 2);

      // Verify in-progress chain step, granted approval, protected episode status, and HM signal were NOT reset
      const stepAfter = store.getChainStep('chain-in-flight-1', 'move_stage');
      assert.equal(stepAfter?.status, 'dispatched');
      assert.equal(stepAfter?.provider_id, 'gh-prov-1');

      const approvalAfter = store.getApproval(approvedHash);
      assert.equal(approvalAfter?.decision, 'approved');

      const epAfter = store.getEpisode('ep-in-flight');
      assert.equal(epAfter?.status, 'AWAITING_MANUAL_NOTES');
      assert.equal((epAfter?.state as any)?.custom_field, 'keep_me');

      const sigAfter = store.getHmSignal('sig:5001:12579937004');
      assert.equal(sigAfter?.target_stage_id, 12579939004);
      assert.equal((sigAfter?.details as any)?.note, 'original_claim');

      // Verify APPROVALS.md and DRAFTS.md exist with 0600 permissions and contain remaining pending proposal hash
      const approvalsMdPath = path.join(dir, 'APPROVALS.md');
      const draftsMdPath = path.join(dir, 'DRAFTS.md');
      assert.equal(fs.statSync(approvalsMdPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(draftsMdPath).mode & 0o777, 0o600);
      const mdText = fs.readFileSync(approvalsMdPath, 'utf8');
      const remainingPendingHash = firstSync.pending_approvals[1].proposal_hash;
      assert.ok(mdText.includes(remainingPendingHash));
      assert.ok(mdText.includes(`approve ${remainingPendingHash}`));
      assert.ok(mdText.includes(`decline ${remainingPendingHash}`));
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Chunk 4 Phase 2.1: Operator CLI Subcommands in worker/executor-tick.mjs', () => {
  it('supports list-proposals, approve, decline (releasing wf3_hm_signals and wf4_conflict_holds), resolve-job, resolve-conflict, status, and tick --dry-run', async () => {
    const dir = makeTempDir();
    const store = new SqliteCoordinatorStore(dir);
    try {
      const now = '2026-10-21T17:00:00.000Z';

      // 1. Seed a WF1 episode in AWAITING_JOB_MAPPING
      const wf1Ingested = ingestBookingSignal(store, {
        source: 'calendly',
        invitee_uri: 'https://api.calendly.com/scheduled_events/ev1/invitees/inv1',
        candidate_email: 'pat.candidate@example.test',
        candidate_name: 'Pat Candidate',
        starts_at: '2026-10-22T18:00:00.000Z',
        ends_at: '2026-10-22T18:30:00.000Z',
        resume_filename: 'pat_resume.pdf',
        resume_base64: Buffer.from('fictional resume pdf').toString('base64'),
        now,
      });
      assert.equal(wf1Ingested.episode.status, 'AWAITING_JOB_MAPPING');

      // 2. Seed a WF4 mixed-panel conflict hold
      const wf4Eval = evaluateWorkflow4Scorecards(store, {
        episode_id: 'wf4_ep_conflict',
        application_id: 600100,
        current_stage_id: 12579940004,
        candidate_tz: 'America/New_York',
        scorecards: [
          {
            id: 701,
            application_id: 600100,
            stage_id: 12579940004,
            status: 'complete',
            overall_recommendation: 'yes',
          },
          {
            id: 702,
            application_id: 600100,
            stage_id: 12579940004,
            status: 'complete',
            overall_recommendation: 'no',
          },
        ],
        now,
      });
      assert.equal(wf4Eval.outcome, 'conflict_hold');

      // 3. Seed a WF3 HM signal and proposal to test decline lock release
      store.upsertEpisode({
        episode_id: 'wf3_ep_1',
        workflow: 'wf3_hm_signal',
        application_id: 600200,
        stage_id: 12579937004,
        status: 'pending_approval',
        state: {},
        now,
      });
      store.claimHmSignal({
        signal_key: 'sig:600200:12579937004',
        application_id: 600200,
        stage_id: 12579937004,
        channel_id: 'C111',
        message_ts: '1729510.1',
        reactor_or_reply_id: 'U_HM_1',
        target_stage_id: 12579939004,
        episode_id: 'wf3_ep_1',
        details: {},
        now,
      });
      const wf3Prop = store.registerProposal({
        episode_id: 'wf3_ep_1',
        action_key: 'wf3_advance:600200',
        workflow: 'wf3_hm_signal',
        params: {
          application_id: 600200,
          stage_id: 12579937004,
          secret_token: 'should-not-leak',
        },
        expected_state: { application_id: 600200 },
        now,
      });

      // Test `resolve-job` CLI subcommand
      const resolvedJob = await runCli([
        'resolve-job',
        wf1Ingested.episode.episode_id,
        '5149015004',
        '--stage-id',
        '12579937004',
        '--data-dir',
        dir,
      ]);
      assert.equal(resolvedJob.command, 'resolve-job');
      assert.equal(resolvedJob.job_id, 5149015004);
      assert.equal(resolvedJob.stage_id, 12579937004);
      assert.equal(resolvedJob.status, 'PENDING_APPROVAL');
      assert.match(resolvedJob.proposal.proposal_hash, /^[0-9a-f]{16}$/);

      // Test `resolve-conflict` CLI subcommand with 'reject'
      const resolvedConflict = await runCli([
        'resolve-conflict',
        '600100',
        '12579940004',
        'reject',
        '--data-dir',
        dir,
      ]);
      assert.equal(resolvedConflict.command, 'resolve-conflict');
      assert.equal(resolvedConflict.ruling, 'Reject');
      assert.equal(resolvedConflict.resolved, true);
      assert.ok(resolvedConflict.proposal);
      assert.equal(resolvedConflict.proposal.status, 'approved');

      // Test `list-proposals` CLI subcommand (and verify secret redaction)
      const pendingList = await runCli([
        'list-proposals',
        '--data-dir',
        dir,
        '--status',
        'pending',
      ]);
      assert.equal(pendingList.command, 'list-proposals');
      assert.equal(pendingList.count, 2); // wf3Prop + resolvedJob.proposal
      const listedWf3 = pendingList.proposals.find(
        (p: any) => p.proposal_hash === wf3Prop.proposal_hash,
      );
      assert.equal(listedWf3.params.secret_token, '[REDACTED]');

      // Test `decline` CLI subcommand on wf3Prop and resolvedConflict.proposal
      const declinedWf3 = await runCli([
        'decline',
        wf3Prop.proposal_hash,
        '--data-dir',
        dir,
      ]);
      assert.equal(declinedWf3.proposal.status, 'declined');
      assert.equal(
        store.getHmSignal('sig:600200:12579937004')?.status,
        'aborted_stale',
      );

      const declinedWf4 = await runCli([
        'decline',
        resolvedConflict.proposal.proposal_hash,
        '--data-dir',
        dir,
      ]);
      assert.equal(declinedWf4.proposal.status, 'declined');
      const holdsAfterDecline = store.listConflictHolds({
        application_id: 600100,
        stage_id: 12579940004,
      });
      assert.equal(holdsAfterDecline[0]?.status, 'RELEASED');

      // Test `approve` CLI subcommand on WF1 proposal
      const approvedWf1 = await runCli([
        'approve',
        resolvedJob.proposal.proposal_hash,
        '--data-dir',
        dir,
      ]);
      assert.equal(approvedWf1.proposal.status, 'approved');

      // Seed an unresolved intent step to verify `status` reports it
      store.upsertChainStep({
        chain_id: 'chain-intent-check',
        step_index: 1,
        step_key: 'step-intent-1',
        episode_id: 'wf3_ep_1',
        action_key: 'act-intent-1',
        idempotency_key: 'idem-intent-1',
        service: 'greenhouse',
        operation: 'application_stage_move',
        input: {},
        status: 'intent',
        now,
      });

      // Test `status` CLI subcommand
      const statusOut = await runCli(['status', '--data-dir', dir]);
      assert.equal(statusOut.unresolved_intent_steps_count, 1);
      assert.equal(statusOut.approvals_by_status.approved, 1);
      assert.equal(statusOut.approvals_by_status.declined, 2);
      assert.ok(statusOut.total_episodes >= 3);

      // Test `tick --dry-run` via subprocess CLI invocation and verify live DB approval remains 'approved'
      const cliStdout = execFileSync(
        process.execPath,
        [
          path.join(REPO_ROOT, 'worker/executor-tick.mjs'),
          'tick',
          '--data-dir',
          dir,
          '--dry-run',
        ],
        { encoding: 'utf8' },
      );
      const dryTickResult = JSON.parse(cliStdout.trim());
      assert.equal(dryTickResult.dryRun, true);
      assert.equal(dryTickResult.approvalsProcessed, 1);
      assert.ok(Array.isArray(dryTickResult.dryRunCalls));
      assert.ok(dryTickResult.dryRunCalls.length > 0);

      // Live DB approval must still be 'approved' (not mutated by --dry-run)
      assert.equal(
        store.getApproval(resolvedJob.proposal.proposal_hash)?.decision,
        'approved',
      );
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Chunk 4 Phase 2.2: Frozen Runtime Deployment & LaunchAgent Plist', () => {
  it('deploys runtime files with 0700/0600 permissions, detects drift in --check mode, and rejects symlinks', () => {
    const tempRoot = makeTempDir('deploy-runtime-test-');
    const targetDir = path.join(tempRoot, 'app');
    try {
      const deployed = deployRuntime({ targetDir, repoRoot: REPO_ROOT });
      assert.equal(deployed.ok, true);
      assert.ok(deployed.deployed_count > 10);

      // Verify directory permissions are 0700 and file permissions are 0600
      assert.equal(fs.statSync(targetDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(targetDir, 'worker')).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(targetDir, 'src')).mode & 0o777, 0o700);
      assert.equal(
        fs.statSync(path.join(targetDir, 'worker/executor-tick.mjs')).mode & 0o777,
        0o600,
      );
      assert.equal(
        fs.statSync(path.join(targetDir, 'pilot.mjs')).mode & 0o777,
        0o600,
      );
      assert.equal(
        fs.statSync(path.join(targetDir, 'src/executor/index.ts')).mode & 0o777,
        0o600,
      );

      // Verify --check passes when clean
      const cleanCheck = checkRuntimeDeployment({
        targetDir,
        repoRoot: REPO_ROOT,
      });
      assert.equal(cleanCheck.ok, true);
      assert.deepEqual(cleanCheck.drift, []);

      // Mutate a deployed file and loosen permissions to verify --check detects drift
      const tickFile = path.join(targetDir, 'worker/executor-tick.mjs');
      fs.chmodSync(tickFile, 0o644);
      fs.appendFileSync(tickFile, '\n// drift comment\n');

      const driftedCheck = checkRuntimeDeployment({
        targetDir,
        repoRoot: REPO_ROOT,
      });
      assert.equal(driftedCheck.ok, false);
      assert.ok(
        driftedCheck.drift.some((d: string) =>
          d.includes('File permission drift on worker/executor-tick.mjs'),
        ),
      );
      assert.ok(
        driftedCheck.drift.some((d: string) =>
          d.includes('Content drift on worker/executor-tick.mjs'),
        ),
      );

      // Replace a file with a symlink and verify deployRuntime / checkRuntimeDeployment rejects it
      fs.unlinkSync(tickFile);
      fs.symlinkSync(path.join(REPO_ROOT, 'worker/executor-tick.mjs'), tickFile);
      assert.throws(
        () => checkRuntimeDeployment({ targetDir, repoRoot: REPO_ROOT }),
        /Refusing symbolic link/,
      );
      assert.throws(
        () => deployRuntime({ targetDir, repoRoot: REPO_ROOT }),
        /Refusing symbolic link/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('validates launchd/com.recruiting-agents.scheduling-pilot.executor-tick.plist security and schedule conventions', () => {
    const plistPath = path.join(
      REPO_ROOT,
      'launchd/com.recruiting-agents.scheduling-pilot.executor-tick.plist',
    );
    const content = fs.readFileSync(plistPath, 'utf8');
    assert.ok(
      content.includes(
        '<string>com.recruiting-agents.scheduling-pilot.executor-tick</string>',
      ),
    );
    assert.ok(content.includes('<key>StartInterval</key>\n\t<integer>60</integer>'));
    assert.ok(content.includes('<key>Umask</key>\n\t<integer>63</integer>'));
    assert.ok(
      content.includes(
        '<string>/Users/sam.vangelos/.recruiting-agents/scheduling-pilot/executor-tick.stdout.log</string>',
      ),
    );
    assert.ok(
      content.includes(
        '<string>/Users/sam.vangelos/.recruiting-agents/scheduling-pilot/executor-tick.stderr.log</string>',
      ),
    );
  });
});

describe('Chunk 4 Phase 4: Adversarial Review Regression Suite (Astra High & Opus High)', () => {
  it('enforces grantApproval state-machine guards, transitions declined episodes to DECLINED, and refreshes APPROVALS.md with 0600 permissions', async () => {
    const dir = makeTempDir('chunk4-p4-guards-');
    const store = new SqliteCoordinatorStore(dir);
    try {
      const now = '2026-10-21T18:00:00.000Z';
      store.upsertEpisode({
        episode_id: 'ep-guard-1',
        workflow: 'wf5c_owner_hygiene',
        application_id: 901001,
        stage_id: 12579936004,
        status: 'PENDING_APPROVAL',
        state: {},
        now,
      });
      store.scheduleTimer({
        timer_key: 'timer-guard-1',
        episode_id: 'ep-guard-1',
        kind: 'wf6_day_before_reminder',
        fire_at: '2026-10-22T18:00:00.000Z',
        payload: {},
        now,
      });

      const prop = store.registerProposal({
        episode_id: 'ep-guard-1',
        action_key: 'assign_owner:901001',
        workflow: 'wf5c_owner_hygiene',
        params: { application_id: 901001 },
        expected_state: { application_id: 901001 },
        now,
      });

      // Declining via CLI transitions episode to DECLINED, cancels pending timers, and creates APPROVALS.md with 0600 mode
      await runCli(['decline', prop.proposal_hash, '--data-dir', dir]);
      assert.equal(store.getEpisode('ep-guard-1')?.status, 'DECLINED');
      assert.equal(store.getTimer('timer-guard-1')?.status, 'cancelled');
      const approvalsMdPath = path.join(dir, 'APPROVALS.md');
      assert.equal(fs.existsSync(approvalsMdPath), true);
      assert.equal(fs.statSync(approvalsMdPath).mode & 0o777, 0o600);

      // Idempotent re-decline succeeds
      const reDecline = store.grantApproval({
        proposal_hash: prop.proposal_hash,
        decision: 'declined',
      });
      assert.equal(reDecline.decision, 'declined');

      // Direct approve on a declined proposal MUST throw unless a workflow re-registers it
      assert.throws(
        () =>
          store.grantApproval({
            proposal_hash: prop.proposal_hash,
            decision: 'approved',
          }),
        /Cannot transition proposal .* from 'declined' to 'approved'/,
      );

      // Executed and stale_aborted proposals cannot be approved or declined
      const propExec = store.registerProposal({
        episode_id: 'ep-guard-1',
        action_key: 'assign_owner_exec:901001',
        workflow: 'wf5c_owner_hygiene',
        params: { application_id: 901001, step: 2 },
        expected_state: { application_id: 901001 },
        now,
      });
      store.grantApproval({
        proposal_hash: propExec.proposal_hash,
        decision: 'approved',
        now,
      });
      store.markApprovalOutcome(propExec.proposal_hash, 'executed', { now });

      assert.throws(
        () =>
          store.grantApproval({
            proposal_hash: propExec.proposal_hash,
            decision: 'approved',
          }),
        /Cannot transition proposal .* from 'executed' to 'approved'/,
      );
      assert.throws(
        () =>
          store.grantApproval({
            proposal_hash: propExec.proposal_hash,
            decision: 'declined',
          }),
        /Cannot transition proposal .* from 'executed' to 'declined'/,
      );

      const propStale = store.registerProposal({
        episode_id: 'ep-guard-1',
        action_key: 'assign_owner_stale:901001',
        workflow: 'wf5c_owner_hygiene',
        params: { application_id: 901001, step: 3 },
        expected_state: { application_id: 901001 },
        now,
      });
      store.markApprovalOutcome(propStale.proposal_hash, 'stale_aborted', {
        failureReason: 'STAGE_CHANGED',
        now,
      });
      assert.throws(
        () =>
          store.grantApproval({
            proposal_hash: propStale.proposal_hash,
            decision: 'approved',
          }),
        /Cannot transition proposal .* from 'stale_aborted' to 'approved'/,
      );
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('paginates Greenhouse v3 scorecards/interviews via Link header and fails closed on malformed adapter responses or missing snapshot fields', async () => {
    // 1. Pagination across 2 pages via Link header
    const ghPaginated = createGreenhouseV3HttpReadAdapter({
      baseUrl: 'https://harvest.example.test',
      accessToken: 'test-token',
      fetchFn: (async (url: string) => {
        if (url.includes('cursor=page2')) {
          return new Response(
            JSON.stringify([
              {
                id: 9202,
                application_id: 777,
                stage_id: 12579940004,
                status: 'complete',
                overall_recommendation: 'strong_yes',
              },
            ]),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify([
            {
              id: 9201,
              application_id: 777,
              stage_id: 12579940004,
              status: 'complete',
              overall_recommendation: 'no',
            },
          ]),
          {
            status: 200,
            headers: {
              Link: '<https://harvest.example.test/v3/scorecards?application_id=777&cursor=page2>; rel="next"',
            },
          },
        );
      }) as typeof fetch,
    });

    const allScorecards = await ghPaginated.listScorecards(777);
    assert.equal(allScorecards?.length, 2);
    assert.equal(allScorecards?.[1]?.overall_recommendation, 'strong_yes');

    // 2. Malformed adapter responses fail closed in createLiveFreshReadFetcher
    const malformedCalFetcher = createLiveFreshReadFetcher({
      calendar: {
        getBusyIntervals: async () => ({ unexpected: true } as any),
      },
    });
    await assert.rejects(
      () =>
        malformedCalFetcher('ep-mal-1', {
          calendar_Check: {
            start: '2026-10-22T17:00:00Z',
            end: '2026-10-22T17:30:00Z',
          },
        }),
      (err: any) =>
        err instanceof FreshReadError && err.code === 'CALENDAR_STATE_MALFORMED',
    );

    const malformedGmailFetcher = createLiveFreshReadFetcher({
      gmail: {
        getThreadState: async () => ({ thread_id: 't1' } as any),
      },
    });
    await assert.rejects(
      () =>
        malformedGmailFetcher('ep-mal-2', {
          gmail_last_message_id: 'msg-expected-1',
        }),
      (err: any) =>
        err instanceof FreshReadError && err.code === 'GMAIL_STATE_MALFORMED',
    );

    const malformedSlackFetcher = createLiveFreshReadFetcher({
      slack: {
        getMessageState: async () => ({} as any),
      },
    });
    await assert.rejects(
      () =>
        malformedSlackFetcher('ep-mal-3', {
          require_no_reaction_removal: true,
        }),
      (err: any) =>
        err instanceof FreshReadError && err.code === 'SLACK_STATE_MALFORMED',
    );

    // 3. verifyFreshState fails closed when expected fields are absent from snapshot
    const nowIso = '2026-10-21T18:00:00.000Z';
    const nowMs = Date.parse(nowIso) + 1000;
    assert.equal(
      verifyFreshState({ fetched_at: nowIso }, { stage_id: 12579940004 }, { nowMs }).code,
      'MISSING_APPLICATION',
    );
    assert.equal(
      verifyFreshState(
        { fetched_at: nowIso, gmail: { last_message_id: null } },
        { gmail_last_message_id: 'msg-123' },
        { nowMs },
      ).code,
      'GMAIL_THREAD_ADVANCED',
    );
    assert.equal(
      verifyFreshState({ fetched_at: nowIso }, { calendar_Check: true }, { nowMs }).code,
      'CALENDAR_CONFLICT',
    );
  });

  it('preserves approved decision on transient STALE_SNAPSHOT so next tick can retry, while aborting on real upstream drift', async () => {
    const dir = makeTempDir('chunk4-p4-stale-');
    const store = new SqliteCoordinatorStore(dir);
    try {
      const nowIso = '2026-10-21T18:00:00.000Z';
      const prop = store.registerProposal({
        episode_id: 'ep-retry-1',
        action_key: 'act-retry-1',
        workflow: 'wf6_scheduling',
        params: { application_id: 55001 },
        expected_state: { application_id: 55001, stage_id: 12579940004 },
        now: nowIso,
      });
      const approved = store.grantApproval({
        proposal_hash: prop.proposal_hash,
        decision: 'approved',
        now: nowIso,
      });

      const executor = new DeterministicExecutor({
        store,
        dataDir: dir,
        now: () => new Date(nowIso),
      });

      // Transient null snapshot -> STALE_SNAPSHOT -> must NOT mark approval as stale_aborted!
      const transientRes = await executor.executeChain({
        chain_id: 'chain-retry-1',
        episode_id: 'ep-retry-1',
        workflow: 'wf6_scheduling',
        approval: approved,
        expected_state: { application_id: 55001, stage_id: 12579940004 },
        fresh_snapshot: null,
        steps: [],
      });
      assert.equal(transientRes.ok, false);
      assert.equal(store.getApproval(prop.proposal_hash)?.decision, 'approved');

      // Real stage drift -> STAGE_CHANGED -> marks approval as stale_aborted
      const driftRes = await executor.executeChain({
        chain_id: 'chain-retry-1',
        episode_id: 'ep-retry-1',
        workflow: 'wf6_scheduling',
        approval: approved,
        expected_state: { application_id: 55001, stage_id: 12579940004 },
        fresh_snapshot: {
          fetched_at: nowIso,
          application: { id: 55001, status: 'active', current_stage_id: 999999 },
        },
        steps: [],
      });
      assert.equal(driftRes.ok, false);
      assert.equal(store.getApproval(prop.proposal_hash)?.decision, 'stale_aborted');
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-ingests checkpoint.json on CLI commands, supersedes proposals on closed episodes or removed actions, and executes wf6_scheduling approvals', async () => {
    const dir = makeTempDir('chunk4-p4-checkpoint-');
    try {
      const nowIso = '2026-10-21T18:10:00.000Z';
      const checkpoint1 = {
        scanned_at: nowIso,
        report: {
          episodes: [
            {
              episode_id: 'ep-wf6-auto-1',
              status: 'open',
              workflow: 'wf6_scheduling',
              application_id: 88001,
              stage_id: 12579940004,
              candidate_name: 'Taylor Swift | Candidate',
              state: { candidate_email: 'taylor.candidate@example.test' },
              next_actions: [
                {
                  action_key: 'send_avail_request:88001',
                  text: 'Request availability from Taylor',
                  draft: '<p>Hi Taylor, please share your availability.</p>',
                },
                {
                  action_key: 'obsolete_action:88001',
                  text: 'Temporary action that will be removed next scan',
                  draft: '<p>Temp</p>',
                },
              ],
            },
            {
              episode_id: 'ep-to-close-2',
              status: 'open',
              workflow: 'wf6_scheduling',
              application_id: 88002,
              stage_id: 12579940004,
              candidate_name: 'Morgan Closed',
              next_actions: [
                {
                  action_key: 'action_on_closing_ep:88002',
                  text: 'Will close on next scan',
                },
              ],
            },
          ],
        },
      };

      fs.writeFileSync(
        path.join(dir, 'checkpoint.json'),
        JSON.stringify(checkpoint1, null, 2),
        { mode: 0o600 },
      );

      // Running `list-proposals` automatically ingests checkpoint.json!
      const list1 = await runCli([
        'list-proposals',
        '--data-dir',
        dir,
        '--status',
        'pending',
      ]);
      assert.equal(list1.count, 3);

      // Update checkpoint.json: remove `obsolete_action:88001` and close `ep-to-close-2`
      const checkpoint2 = {
        scanned_at: '2026-10-21T18:15:00.000Z',
        report: {
          episodes: [
            {
              episode_id: 'ep-wf6-auto-1',
              status: 'open',
              workflow: 'wf6_scheduling',
              application_id: 88001,
              stage_id: 12579940004,
              candidate_name: 'Taylor Swift | Candidate',
              state: { candidate_email: 'taylor.candidate@example.test' },
              next_actions: [
                {
                  action_key: 'send_avail_request:88001',
                  text: 'Request availability from Taylor',
                  draft: '<p>Hi Taylor, please share your availability.</p>',
                },
              ],
            },
            {
              episode_id: 'ep-to-close-2',
              status: 'closed',
              workflow: 'wf6_scheduling',
              application_id: 88002,
              stage_id: 12579940004,
              candidate_name: 'Morgan Closed',
              next_actions: [],
            },
          ],
        },
      };
      fs.writeFileSync(
        path.join(dir, 'checkpoint.json'),
        JSON.stringify(checkpoint2, null, 2),
        { mode: 0o600 },
      );

      const syncRes = await runCli(['sync-checkpoint', '--data-dir', dir]);
      assert.equal(syncRes.command, 'sync-checkpoint');
      assert.equal(syncRes.proposals_superseded, 2);
      assert.equal(syncRes.pending_approvals.length, 1);

      // Verify Markdown table cell escaped the `|` in candidate_name
      const md = fs.readFileSync(path.join(dir, 'APPROVALS.md'), 'utf8');
      assert.ok(md.includes('Taylor Swift \\| Candidate'));

      // Approve the remaining WF6 proposal with `--run-now` and mock Gmail provider
      const wf6ProposalHash = syncRes.pending_approvals[0].proposal_hash;
      const sentEmails: any[] = [];
      const approvedAndRan = await runCli(
        ['approve', wf6ProposalHash, '--data-dir', dir, '--run-now'],
        {
          now: () => new Date('2026-10-21T18:16:00.000Z'),
          gmail: {
            sendMessage: async (msg: any) => {
              sentEmails.push(msg);
              return { message_id: 'gmail_wf6_sent_1', thread_id: 'thr_wf6_1' };
            },
          },
          defaultFreshSnapshot: {
            fetched_at: '2026-10-21T18:16:00.000Z',
            application: {
              id: 88001,
              status: 'active',
              current_stage_id: 12579940004,
            },
          },
        },
      );
      assert.equal(approvedAndRan.tick_summary.approvalsProcessed, 1);
      assert.deepEqual(approvedAndRan.tick_summary.errors, []);
      assert.equal(sentEmails.length, 1);
      assert.equal(sentEmails[0].to, 'taylor.candidate@example.test');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces strict CLI argument validation, blocks --dry-run on mutating subcommands, redacts content/Bearer secrets, and hardens SQLite WAL permissions', async () => {
    const dir = makeTempDir('chunk4-p4-cli-sec-');
    const store = new SqliteCoordinatorStore(dir);
    try {
      // Verify SQLite WAL file permissions are 0600
      const walPath = path.join(dir, 'state.sqlite-wal');
      if (fs.existsSync(walPath)) {
        assert.equal(fs.statSync(walPath).mode & 0o777, 0o600);
      }

      // Verify sanitizeParams redacts `content`, `api_key`, `authorization`, Bearer tokens, and long base64
      const redacted = sanitizeParams({
        content: 'JVBERi0xLjQK',
        api_key: 'gh_live_123',
        authorization: 'Bearer secret-jwt',
        nested: {
          note: 'Bearer inline-secret-token',
          big_blob: 'A'.repeat(600),
          safe_text: 'normal text',
        },
      });
      assert.equal(redacted.content, '[REDACTED]');
      assert.equal(redacted.api_key, '[REDACTED]');
      assert.equal(redacted.authorization, '[REDACTED]');
      assert.equal(redacted.nested.note, '[REDACTED]');
      assert.equal(redacted.nested.big_blob, '[REDACTED]');
      assert.equal(redacted.nested.safe_text, 'normal text');

      // Verify CLI rejects invalid flags, swallowed flag values, extra positional args, float IDs, and --dry-run on approve/decline
      await assert.rejects(
        () => runCli(['approve', '0123456789abcdef', '--dry-run', '--data-dir', dir]),
        /--dry-run is only supported with the 'tick' subcommand/,
      );
      await assert.rejects(
        () => runCli(['decline', '0123456789abcdef', '--dry-run', '--data-dir', dir]),
        /--dry-run is only supported with the 'tick' subcommand/,
      );
      await assert.rejects(
        () => runCli(['tick', '--data-dir', '--dry-run']),
        /Missing value for --data-dir/,
      );
      await assert.rejects(
        () => runCli(['list-proposals', 'pending', '--data-dir', dir]),
        /Unexpected positional arguments for 'list-proposals'/,
      );
      await assert.rejects(
        () => runCli(['resolve-job', 'ep-1', '123.45', '--data-dir', dir]),
        /Invalid job_id/,
      );
      await assert.rejects(
        () => runCli(['tick', '-x', '--data-dir', dir]),
        /Unknown flag: -x/,
      );

      // Verify SqliteCoordinatorStore refuses symlinked state.sqlite
      const symlinkDir = makeTempDir('chunk4-p4-symlink-db-');
      try {
        fs.symlinkSync(
          path.join(dir, 'state.sqlite'),
          path.join(symlinkDir, 'state.sqlite'),
        );
        assert.throws(
          () => new SqliteCoordinatorStore(symlinkDir),
          /SQLite file must not be a symbolic link/,
        );
      } finally {
        fs.rmSync(symlinkDir, { recursive: true, force: true });
      }
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supersedes replaced action_keys and registers multi-action interviewer nudge proposals on sync-checkpoint', async () => {
    const dir = makeTempDir('chunk5-sync-recovery-');
    try {
      const t1 = '2026-10-21T03:06:00.000Z';
      const initialCheckpoint = {
        scanned_at: t1,
        partial: [],
        report: {
          episodes: [
            {
              episode_id: 'gmail:fictional_thread_101',
              status: 'open',
              facts: [{ text: 'Candidate asked for windows.' }],
              next_actions: [
                {
                  action_key: 'gmail:fictional_thread_101:await-windows',
                  text: 'Await candidate availability windows.',
                  draft: '',
                  evidence: ['r1'],
                },
              ],
              unknowns: [],
            },
            {
              episode_id: '700100200:screening-round-14297391004',
              status: 'open',
              facts: [{ text: 'Interviewer hold created 5h ago.' }],
              next_actions: [
                {
                  action_key: '700100200:presentation:hold-accept-then-confirm',
                  text: 'Wait for 12h mark before nudging Reviewer A.',
                  draft: 'Hi Reviewer A, can you make Friday at 1:00 pm PT?',
                  evidence: ['r2'],
                },
              ],
              unknowns: [],
            },
          ],
          unknowns: [],
        },
        changes: { new_or_changed: [], removed: [] },
      };
      fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(initialCheckpoint, null, 2), { mode: 0o600 });
      const sync1 = await runCli(['sync-checkpoint', '--data-dir', dir]);
      assert.equal(sync1.proposals_registered, 2);
      assert.equal(sync1.pending_approvals.length, 2);

      // Update checkpoint with candidate reply replacing await-windows and 12h hold passing adding second reviewer nudge
      const t2 = '2026-10-21T18:21:43.000Z';
      const updatedCheckpoint = {
        scanned_at: t2,
        partial: [],
        report: {
          episodes: [
            {
              episode_id: 'gmail:fictional_thread_101',
              status: 'open',
              facts: [{ text: 'Candidate replied offering Thursday 1:00-4:00 PM ET.' }],
              next_actions: [
                {
                  action_key: 'gmail:fictional_thread_101:schedule-default-round',
                  text: 'Schedule round in Greenhouse for Thu 11:30 am-12:00 pm PT.',
                  draft: '',
                  evidence: ['r3'],
                },
              ],
              unknowns: [],
            },
            {
              episode_id: '700100200:screening-round-14297391004',
              status: 'open',
              facts: [{ text: 'Interviewer hold is now 20h old; both reviewers still needsAction.' }],
              next_actions: [
                {
                  action_key: '700100200:presentation:hold-accept-then-confirm',
                  text: 'Past 12h mark: send Reviewer A direct Slack nudge.',
                  draft: 'Hi Reviewer A, can you make Friday at 1:00 pm PT?',
                  evidence: ['r4'],
                },
                {
                  action_key: '700100200:presentation:nudge-reviewer-b',
                  text: 'Past 12h mark: send Reviewer B direct Slack nudge.',
                  draft: 'Hi Reviewer B, can you make Friday at 1:00 pm PT?',
                  evidence: ['r5'],
                },
              ],
              unknowns: [],
            },
          ],
          unknowns: [],
        },
        changes: {
          new_or_changed: [
            'gmail:fictional_thread_101/gmail:fictional_thread_101:schedule-default-round',
            '700100200:screening-round-14297391004/700100200:presentation:hold-accept-then-confirm',
            '700100200:screening-round-14297391004/700100200:presentation:nudge-reviewer-b',
          ],
          removed: ['gmail:fictional_thread_101/gmail:fictional_thread_101:await-windows'],
        },
      };
      fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(updatedCheckpoint, null, 2), { mode: 0o600 });
      const sync2 = await runCli(['sync-checkpoint', '--data-dir', dir]);
      assert.equal(sync2.proposals_registered, 3);
      assert.ok(sync2.proposals_superseded >= 2);
      assert.equal(sync2.pending_approvals.length, 3);

      const listed = await runCli(['list-proposals', '--status', 'pending', '--data-dir', dir]);
      assert.deepEqual(
        listed.proposals.map((p: any) => p.action_key).sort(),
        [
          '700100200:presentation:hold-accept-then-confirm',
          '700100200:presentation:nudge-reviewer-b',
          'gmail:fictional_thread_101:schedule-default-round',
        ],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reconciles ledger discharged/declined actions, supersedes re-keyed alias episodes, and sanitizes legacy patch-candidate text on sync-checkpoint', async () => {
    const dir = makeTempDir('chunk5-ledger-reconcile-');
    try {
      const t1 = '2026-10-21T20:00:00.000Z';
      const initialCheckpoint = {
        scanned_at: t1,
        partial: [],
        report: {
          episodes: [
            {
              episode_id: 'gmail:thread_alias_1',
              status: 'open',
              application_id: 8001001,
              candidate_id: 9001001,
              candidate_name: 'Fictional Candidate One',
              facts: [{ text: 'Candidate application_id: 8001001' }],
              next_actions: [
                {
                  action_key: '8001001:screening-round:greenhouse-link',
                  text: 'Link Greenhouse interview row.',
                  draft: '',
                  evidence: ['r1'],
                },
                {
                  action_key: '8001001:screening-round:confirm-after-accept',
                  text: "Once Sam approves, I'll patch Fictional onto the calendar event and send confirmation.",
                  draft: '',
                  evidence: ['r1'],
                },
              ],
              unknowns: [],
            },
          ],
          unknowns: [],
        },
        changes: { new_or_changed: [], removed: [] },
      };
      fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(initialCheckpoint, null, 2), { mode: 0o600 });
      const sync1 = await runCli(['sync-checkpoint', '--data-dir', dir]);
      assert.equal(sync1.pending_approvals.length, 2);

      // Verify legacy "patch Fictional onto the calendar event" was sanitized
      const approvalsMd1 = fs.readFileSync(path.join(dir, 'APPROVALS.md'), 'utf8');
      assert.doesNotMatch(approvalsMd1, /patch Fictional onto the calendar event/i);
      assert.match(approvalsMd1, /create a separate candidate-only 'Interview with Turing' calendar event/);

      // Append a terminal action for greenhouse-link in ledger.jsonl and re-key the episode in checkpoint.json
      const ledgerRecord = {
        kind: 'action',
        idempotency_key: 'act:8001001:greenhouse-link:1',
        at: '2026-10-21T20:05:00.000Z',
        actor: 'sam',
        episode_id: '8001001:screening-round',
        action_key: '8001001:screening-round:greenhouse-link',
        service: 'greenhouse',
        status: 'dispatched',
        provider_id: 'gh-row-1',
        summary: 'Linked Greenhouse row',
      };
      fs.writeFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify(ledgerRecord) + '\n', { mode: 0o600 });

      const rekeyedCheckpoint = {
        scanned_at: '2026-10-21T20:10:00.000Z',
        partial: [],
        report: {
          episodes: [
            {
              episode_id: '8001001:screening-round',
              status: 'open',
              application_id: 8001001,
              candidate_id: 9001001,
              candidate_name: 'Fictional Candidate One',
              facts: [{ text: 'Candidate application_id: 8001001' }],
              next_actions: [
                {
                  action_key: '8001001:screening-round:greenhouse-link',
                  text: 'Link Greenhouse interview row.',
                  draft: '',
                  evidence: ['r2'],
                },
                {
                  action_key: '8001001:screening-round:confirm-after-accept',
                  text: "Once Sam approves, I'll patch Fictional onto event evt123 and send confirmation.",
                  draft: '',
                  evidence: ['r2'],
                },
              ],
              unknowns: [],
            },
          ],
          unknowns: [],
        },
        changes: { new_or_changed: [], removed: [] },
      };
      fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(rekeyedCheckpoint, null, 2), { mode: 0o600 });
      const sync2 = await runCli(['sync-checkpoint', '--data-dir', dir]);

      // Only the non-discharged confirm-after-accept on the new canonical episode should remain pending
      assert.equal(sync2.pending_approvals.length, 1);
      assert.equal(sync2.pending_approvals[0].episode_id, '8001001:screening-round');
      assert.equal(sync2.pending_approvals[0].action_key, '8001001:screening-round:confirm-after-accept');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
