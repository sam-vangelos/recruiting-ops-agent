#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { appendLedger } from './ledger.mjs';
import {
  DeterministicExecutor,
  loadGreenhouseActionService,
  SAM_EMAIL,
  SAM_GREENHOUSE_USER_ID,
  verifyFreshState,
} from '../src/executor/index.ts';
import {
  DEFAULT_DATA_DIR,
  SqliteCoordinatorStore,
} from '../src/store/sqlite.ts';
import {
  createGreenhouseV3HttpReadAdapter,
  createLiveProviders,
} from '../src/providers/live-providers.ts';
import {
  assertPathNotSymlink,
  syncCheckpointToCoordinatorStore,
  writeOperatorApprovalSummaries,
} from '../src/bridge/checkpoint-ingest.ts';
import {
  fireWorkflow4DeliberatedRejection,
  resolveWorkflow4ConflictHold,
} from '../src/workflows/wf4-rejection.ts';
import {
  executeStep1HmYesStageMove,
  executeStep6BookingChain,
  executeStep8ConfirmationChain,
  executeStep9CancellationChain,
  executeStep9RescheduleChain,
  fireStep7RsvpChase,
  fireStep10ScorecardChase24h,
  reconcileStep10ScorecardCompletion,
} from '../src/workflows/wf6-scheduling.ts';
import {
  executeWorkflow1IntakeChain,
  handleJobMappingUrgentReminderTimer,
  resolveJobMapping,
} from '../src/workflows/wf1-intake.ts';
import {
  executeWorkflow2ChainD,
  handleManualNotesExpiryOrCompletion,
  handleMissingNotesPromptTimer,
} from '../src/workflows/wf2-scorecard.ts';
import {
  executeWorkflow3HmSignalChain,
} from '../src/workflows/wf3-hm-signal.ts';
import {
  executeMissingOwnerHygiene,
  executeStageDriftRepair,
  executeWorkflow5AChainE,
} from '../src/workflows/wf5-grooming.ts';

async function resolveTimerSnapshot(executor, timer, expected, options = {}) {
  if (executor.freshReadFetcher) {
    return await executor.freshReadFetcher(timer.episode_id, expected);
  }
  if (options.defaultFreshSnapshot !== undefined) {
    return options.defaultFreshSnapshot;
  }
  return null;
}

/**
 * Builds default timer handlers for Workflow 6 (all 8 scheduling timer kinds)
 * and Workflow 4 (locally held deliberated rejections).
 * Fails closed when no `freshReadFetcher` (or explicit test `defaultFreshSnapshot`) is provided.
 */
export function buildDefaultTimerHandlers(options = {}) {
  return {
    wf6_rsvp_chase_12h: async (timer, executor) => {
      const p = timer.payload ?? {};
      const snapshot = await resolveTimerSnapshot(
        executor,
        timer,
        {
          application_id: Number(p.application_id),
          application_status: 'active',
          require_interviewer_rsvp_pending: {
            interview_id: p.interview_id,
            interviewer_user_id: Number(p.interviewer_user_id),
          },
        },
        options,
      );

      await fireStep7RsvpChase(executor, {
        timer_key: timer.timer_key,
        episode_id: timer.episode_id,
        tier: '12h',
        interview_id: p.interview_id,
        application_id: Number(p.application_id),
        interviewer_user_id: Number(p.interviewer_user_id),
        interviewer_slack_id: String(p.interviewer_slack_id),
        candidate_name: String(p.candidate_name ?? 'Candidate'),
        interview_name: String(p.interview_name ?? 'Interview'),
        starts_at: String(p.starts_at ?? ''),
        attempt: Number(p.attempt ?? timer.attempt ?? 1),
        fresh_snapshot: snapshot,
      });
    },

    wf6_rsvp_chase_24h: async (timer, executor) => {
      const p = timer.payload ?? {};
      const snapshot = await resolveTimerSnapshot(
        executor,
        timer,
        {
          application_id: Number(p.application_id),
          application_status: 'active',
          require_interviewer_rsvp_pending: {
            interview_id: p.interview_id,
            interviewer_user_id: Number(p.interviewer_user_id),
          },
        },
        options,
      );

      await fireStep7RsvpChase(executor, {
        timer_key: timer.timer_key,
        episode_id: timer.episode_id,
        tier: '24h',
        interview_id: p.interview_id,
        application_id: Number(p.application_id),
        interviewer_user_id: Number(p.interviewer_user_id),
        interviewer_slack_id: String(p.interviewer_slack_id),
        candidate_name: String(p.candidate_name ?? 'Candidate'),
        interview_name: String(p.interview_name ?? 'Interview'),
        starts_at: String(p.starts_at ?? ''),
        attempt: Number(p.attempt ?? timer.attempt ?? 1),
        fresh_snapshot: snapshot,
      });
    },

    wf6_rsvp_escalate_48h: async (timer, executor) => {
      const p = timer.payload ?? {};
      executor.store.registerProposal({
        episode_id: timer.episode_id,
        action_key: `rsvp_escalate_hm:${p.interview_id}:${p.interviewer_user_id}:${p.attempt ?? 1}`,
        workflow: 'wf6_scheduling',
        params: p,
        expected_state: { application_id: Number(p.application_id) },
        now: executor.nowIso(),
      });
      executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: executor.nowIso() });
    },

    wf6_avail_nudge_24h: async (timer, executor) => {
      const p = timer.payload ?? {};
      const snapshot = await resolveTimerSnapshot(
        executor,
        timer,
        {
          application_id: Number(p.application_id),
          application_status: 'active',
        },
        options,
      );
      if (!snapshot) {
        throw new Error(
          `wf6_avail_nudge_24h: missing fresh read snapshot for episode ${timer.episode_id}`,
        );
      }
      if (!executor.gmail || !p.candidate_email) {
        throw new Error(
          `wf6_avail_nudge_24h: missing GmailProvider or candidate_email for episode ${timer.episode_id}`,
        );
      }
      const actionKey = `avail_nudge_24h:${p.application_id}:${p.stage_id}`;
      const htmlBody = `<p>Hi,</p><p>Friendly follow-up — could you share a few times that work for your upcoming interview?</p><p>Best,<br/>Sam Vangelos</p>`;
      const res = await executor.executeChain({
        chain_id: `wf6_${actionKey}`,
        episode_id: timer.episode_id,
        workflow: 'wf6_scheduling',
        exception: '24h_avail_nudge',
        expected_state: {
          application_id: Number(p.application_id),
          application_status: 'active',
        },
        fresh_snapshot: snapshot,
        steps: [
          {
            step_index: 1,
            step_key: 'send_24h_avail_nudge_email',
            action_key: actionKey,
            service: 'gmail',
            operation: 'send_message',
            exception: '24h_avail_nudge',
            buildInput: () => ({
              to: String(p.candidate_email),
              subject: 'Following up: Interview Availability',
              htmlBody,
            }),
            outboundBody: () => htmlBody,
            execute: async (_ctx, input) => {
              const sent = await executor.gmail.sendMessage({
                to: String(input.to),
                subject: String(input.subject),
                htmlBody: String(input.htmlBody),
              });
              return { provider_id: sent.message_id, output: sent };
            },
          },
        ],
      });
      if (!res.ok) {
        throw new Error(
          `wf6_avail_nudge_24h failed (${res.status}): ${res.reason ?? 'unknown error'}`,
        );
      }
      executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: executor.nowIso() });
    },

    wf6_avail_escalate_48h: async (timer, executor) => {
      const p = timer.payload ?? {};
      executor.store.registerProposal({
        episode_id: timer.episode_id,
        action_key: `avail_escalate_48h:${p.application_id}:${p.stage_id}`,
        workflow: 'wf6_scheduling',
        params: p,
        expected_state: { application_id: Number(p.application_id) },
        now: executor.nowIso(),
      });
      executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: executor.nowIso() });
    },

    wf6_day_before_reminder: async (timer, executor) => {
      executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: executor.nowIso() });
    },

    wf6_pre_interview_check_1h: async (timer, executor) => {
      executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: executor.nowIso() });
    },

    wf6_scorecard_reminder_2h: async (timer, executor) => {
      const p = timer.payload ?? {};
      const expected = {
        application_id: Number(p.application_id),
        application_status: 'active',
        require_scorecard_incomplete_for_user_id: Number(p.interviewer_user_id),
      };
      const snapshot = await resolveTimerSnapshot(
        executor,
        timer,
        expected,
        options,
      );
      if (snapshot?.scorecards) {
        const check = reconcileStep10ScorecardCompletion(executor.store, {
          interview_id: p.interview_id,
          interviewer_user_id: Number(p.interviewer_user_id),
          scorecards: snapshot.scorecards,
          now: executor.nowIso(),
        });
        if (check.completed) return;
      }
      const gate = verifyFreshState(snapshot, expected, {
        nowMs: executor.nowMs(),
      });
      if (!gate.ok) {
        if (gate.code === 'SCORECARD_ALREADY_COMPLETED') {
          return;
        }
        throw new Error(
          `wf6_scorecard_reminder_2h fresh-read check failed (${gate.code}): ${gate.reason}`,
        );
      }
      executor.store.registerProposal({
        episode_id: timer.episode_id,
        action_key: `scorecard_reminder_2h:${p.interview_id}:${p.interviewer_user_id}`,
        workflow: 'wf6_scheduling',
        params: p,
        expected_state: {
          application_id: Number(p.application_id),
          require_scorecard_incomplete_for_user_id: Number(p.interviewer_user_id),
        },
        now: executor.nowIso(),
      });
      executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: executor.nowIso() });
    },

    wf6_scorecard_chase_24h: async (timer, executor) => {
      const p = timer.payload ?? {};
      const snapshot = await resolveTimerSnapshot(
        executor,
        timer,
        {
          application_id: Number(p.application_id),
          application_status: 'active',
          require_scorecard_incomplete_for_user_id: Number(p.interviewer_user_id),
        },
        options,
      );

      await fireStep10ScorecardChase24h(executor, {
        timer_key: timer.timer_key,
        episode_id: timer.episode_id,
        interview_id: p.interview_id,
        application_id: Number(p.application_id),
        interviewer_user_id: Number(p.interviewer_user_id),
        interviewer_slack_id: String(p.interviewer_slack_id),
        candidate_name: String(p.candidate_name ?? 'Candidate'),
        interview_name: String(p.interview_name ?? 'Interview'),
        attempt: Number(p.attempt ?? timer.attempt ?? 1),
        fresh_snapshot: snapshot,
      });
    },

    wf4_deliberated_rejection: async (timer, executor) => {
      const p = timer.payload ?? {};
      const snapshot = await resolveTimerSnapshot(
        executor,
        timer,
        {
          application_id: Number(p.application_id),
          application_status: 'in_process',
          stage_id: Number(p.stage_id),
          negative_scorecard_id: Number(p.scorecard_id),
          require_no_positive_scorecard: true,
        },
        options,
      );

      await fireWorkflow4DeliberatedRejection(executor, {
        timer,
        fresh_snapshot: snapshot,
      });
    },

    wf1_job_mapping_urgent: async (timer, executor) => {
      await handleJobMappingUrgentReminderTimer(timer, executor);
    },

    wf2_missing_notes_prompt: async (timer, executor) => {
      const p = timer.payload ?? {};
      const snapshot = await resolveTimerSnapshot(
        executor,
        timer,
        {
          application_id: Number(p.application_id),
        },
        options,
      );
      await handleMissingNotesPromptTimer(timer, executor, {
        fresh_snapshot: snapshot,
      });
    },

    wf2_manual_notes_expiry: async (timer, executor) => {
      await handleManualNotesExpiryOrCompletion(executor.store, {
        episode_id: timer.episode_id,
        timer_key: timer.timer_key,
        now: executor.nowIso(),
      });
    },
  };
}

async function resolveApprovalSnapshot(executor, approval, expectedOverride, options = {}) {
  if (options.defaultFreshSnapshot !== undefined) {
    return options.defaultFreshSnapshot;
  }
  const expected = expectedOverride ?? approval.expected_state ?? {};
  if (executor.freshReadFetcher) {
    return await executor.freshReadFetcher(approval.episode_id, expected);
  }
  return null;
}

/**
 * Builds default approval handlers for WF1, WF2, WF3, WF5, and WF6.
 */
export function buildDefaultApprovalHandlers(options = {}) {
  return {
    wf1_intake: async (approval, executor) => {
      const res = await executeWorkflow1IntakeChain(executor, {
        episode_id: approval.episode_id,
        approval,
        fresh_snapshot: options.defaultFreshSnapshot,
      });
      return res.chain_c_result;
    },

    wf2_scorecard: async (approval, executor) => {
      return await executeWorkflow2ChainD(executor, {
        episode_id: approval.episode_id,
        approval,
        fresh_snapshot: options.defaultFreshSnapshot,
      });
    },

    wf3_hm_signal: async (approval, executor) => {
      return await executeWorkflow3HmSignalChain(executor, {
        episode_id: approval.episode_id,
        approval,
        fresh_snapshot: options.defaultFreshSnapshot,
      });
    },

    wf5a_cross_req: async (approval, executor) => {
      const res = await executeWorkflow5AChainE(executor, {
        episode_id: approval.episode_id,
        approval,
        fresh_snapshot: options.defaultFreshSnapshot,
      });
      return res.result;
    },

    wf5b_stage_drift: async (approval, executor) => {
      return await executeStageDriftRepair(executor, {
        episode_id: approval.episode_id,
        approval,
        fresh_snapshot: options.defaultFreshSnapshot,
      });
    },

    wf5c_owner_hygiene: async (approval, executor) => {
      return await executeMissingOwnerHygiene(executor, {
        episode_id: approval.episode_id,
        approval,
        fresh_snapshot: options.defaultFreshSnapshot,
      });
    },

    wf6_scheduling: async (approval, executor) => {
      const ep = executor.store.getEpisode(approval.episode_id);
      const epState = ep?.state && typeof ep.state === 'object' ? ep.state : {};
      const p = approval.params && typeof approval.params === 'object' ? approval.params : {};
      const expected =
        approval.expected_state && typeof approval.expected_state === 'object'
          ? approval.expected_state
          : {};
      const snapshot = await resolveApprovalSnapshot(executor, approval, expected, options);

      const appId = Number(
        p.application_id ?? expected.application_id ?? ep?.application_id ?? 0,
      );
      const stageId = Number(
        p.stage_id ?? expected.stage_id ?? ep?.stage_id ?? 0,
      );

      // 1. Step 1 Stage Move
      if (
        approval.action_key.startsWith('advance_stage:') ||
        approval.chain_id?.startsWith('wf6_step1_move:')
      ) {
        return await executeStep1HmYesStageMove(executor, {
          episode_id: approval.episode_id,
          application_id: appId,
          from_stage_id: Number(p.from_stage_id ?? expected.stage_id ?? stageId),
          to_stage_id: Number(p.to_stage_id ?? p.target_stage_id),
          approval,
          fresh_snapshot: snapshot,
        });
      }

      // 2. Step 6 Booking Chain
      if (
        approval.action_key.startsWith('interview_create:') ||
        approval.chain_id?.startsWith('wf6_step6_book:')
      ) {
        return await executeStep6BookingChain(executor, {
          episode_id: approval.episode_id,
          application_id: appId,
          candidate_id: Number(p.candidate_id ?? ep?.candidate_id ?? 0),
          candidate_name: String(p.candidate_name ?? epState.candidate_name ?? 'Candidate'),
          candidate_email: String(p.candidate_email ?? epState.candidate_email ?? ''),
          job_id: Number(p.job_id ?? ep?.job_id ?? 5149015004),
          job_title: String(p.job_title ?? epState.job_title ?? 'Forward Deployed Engineer'),
          stage_id: stageId,
          job_interview_id: Number(p.job_interview_id ?? epState.job_interview_id),
          interview_kit_id: Number(p.interview_kit_id ?? epState.interview_kit_id),
          interview_name: String(p.interview_name ?? epState.interview_name ?? 'Interview'),
          interviewer_user_id: Number(p.interviewer_user_id ?? epState.interviewer_user_id),
          interviewer_name: String(p.interviewer_name ?? epState.interviewer_name ?? 'Interviewer'),
          interviewer_email: String(p.interviewer_email ?? epState.interviewer_email ?? ''),
          interviewer_slack_id: String(p.interviewer_slack_id ?? epState.interviewer_slack_id ?? ''),
          interviewer_tz: p.interviewer_tz ?? epState.interviewer_tz ?? null,
          starts_at: String(p.starts_at ?? epState.starts_at),
          ends_at: String(p.ends_at ?? epState.ends_at),
          approval,
          expected_state: expected,
          fresh_snapshot: snapshot,
        });
      }

      // 3. Step 8 Confirmation Chain
      if (
        approval.action_key.startsWith('send_confirmation:') ||
        approval.chain_id?.startsWith('wf6_step8_confirm:')
      ) {
        const candName = String(p.candidate_name ?? epState.candidate_name ?? 'Candidate');
        return await executeStep8ConfirmationChain(executor, {
          episode_id: approval.episode_id,
          application_id: appId,
          candidate_id: Number(p.candidate_id ?? ep?.candidate_id ?? 0),
          candidate_first_name: String(
            p.candidate_first_name ?? candName.split(/\s+/)[0] ?? 'Candidate',
          ),
          candidate_name: candName,
          candidate_email: String(p.candidate_email ?? epState.candidate_email ?? ''),
          candidate_tz: p.candidate_tz ?? epState.candidate_tz ?? null,
          job_id: Number(p.job_id ?? ep?.job_id ?? 5149015004),
          job_title: String(p.job_title ?? epState.job_title ?? 'Forward Deployed Engineer'),
          stage_id: stageId,
          interview_id: p.interview_id ?? epState.interview_id,
          interview_name: String(p.interview_name ?? epState.interview_name ?? 'Interview'),
          interviewer_user_id: Number(p.interviewer_user_id ?? epState.interviewer_user_id),
          interviewer_name: String(p.interviewer_name ?? epState.interviewer_name ?? 'Interviewer'),
          interviewer_email: String(p.interviewer_email ?? epState.interviewer_email ?? ''),
          interviewer_slack_id: String(p.interviewer_slack_id ?? epState.interviewer_slack_id ?? ''),
          interviewer_tz: p.interviewer_tz ?? epState.interviewer_tz ?? null,
          hold_event_id: String(p.hold_event_id ?? epState.hold_event_id ?? ''),
          meet_link: String(
            p.meet_link ?? epState.hangout_link ?? epState.meet_link ?? 'https://meet.google.com/interview-link',
          ),
          starts_at: String(p.starts_at ?? epState.starts_at ?? ''),
          ends_at: String(p.ends_at ?? epState.ends_at ?? ''),
          starts_at_formatted: String(
            p.starts_at_formatted ?? p.starts_at ?? epState.starts_at ?? '',
          ),
          duration_minutes: Number(p.duration_minutes ?? epState.duration_minutes ?? 45),
          thread_id: p.thread_id ?? epState.gmail_thread_id,
          approval,
          fresh_snapshot: snapshot,
        });
      }

      // 4. Step 9 Reschedule Chain
      if (
        approval.action_key.startsWith('interview_update:') ||
        approval.chain_id?.startsWith('wf6_step9_reschedule:')
      ) {
        const resched = await executeStep9RescheduleChain(executor, {
          episode_id: approval.episode_id,
          application_id: appId,
          stage_id: stageId,
          interview_id: Number(p.interview_id ?? epState.interview_id),
          hold_event_id: String(p.hold_event_id ?? epState.hold_event_id ?? ''),
          interviewer_user_id: Number(p.interviewer_user_id ?? epState.interviewer_user_id),
          interviewer_email: String(p.interviewer_email ?? epState.interviewer_email ?? ''),
          interviewer_slack_id: String(p.interviewer_slack_id ?? epState.interviewer_slack_id ?? ''),
          interviewer_tz: p.interviewer_tz ?? epState.interviewer_tz ?? null,
          candidate_name: String(p.candidate_name ?? epState.candidate_name ?? 'Candidate'),
          interview_name: String(p.interview_name ?? epState.interview_name ?? 'Interview'),
          new_starts_at: String(p.new_starts_at ?? p.starts_at),
          new_ends_at: String(p.new_ends_at ?? p.ends_at),
          previous_attempt: Number(p.previous_attempt ?? epState.rsvp_attempt ?? 1),
          approval,
          fresh_snapshot: snapshot,
        });
        return resched.result;
      }

      // 5. Step 9 Cancellation Chain
      if (
        approval.action_key.startsWith('interview_delete:') ||
        approval.chain_id?.startsWith('wf6_step9_cancel:')
      ) {
        return await executeStep9CancellationChain(executor, {
          episode_id: approval.episode_id,
          application_id: appId,
          stage_id: stageId,
          interview_id: Number(p.interview_id ?? epState.interview_id),
          hold_event_id: String(p.hold_event_id ?? epState.hold_event_id ?? ''),
          candidate_name: String(p.candidate_name ?? epState.candidate_name ?? 'Candidate'),
          candidate_email: String(p.candidate_email ?? epState.candidate_email ?? ''),
          interview_name: String(p.interview_name ?? epState.interview_name ?? 'Interview'),
          urgent_interviewer_cancel: Boolean(p.urgent_interviewer_cancel),
          approval,
          fresh_snapshot: snapshot,
        });
      }

      // 6. Generic WF6 checkpoint-ingested or timer-escalation proposal
      const chainId = approval.chain_id ?? `wf6_proposal:${approval.proposal_hash}`;
      const bodyText = String(p.draft ?? p.htmlBody ?? p.text ?? '');
      const isSlackAction =
        Boolean(p.channel || p.interviewer_slack_id) &&
        !p.candidate_email &&
        !p.to;

      const step = isSlackAction
        ? {
            step_index: 1,
            step_key: 'dispatch_wf6_slack_proposal',
            action_key: approval.action_key,
            service: 'slack',
            operation: 'send_message',
            buildInput: () => ({
              channel: String(p.channel ?? p.interviewer_slack_id),
              text:
                bodyText ||
                `Reminder regarding interview ${p.interview_id ?? ''} for application ${appId}.`,
            }),
            outboundBody: () => ( approval.draft_sha256 ? bodyText : null ),
            execute: async (_ctx, input) => {
              if (!executor.slack) {
                throw new Error('SlackProvider is required to execute WF6 Slack proposal.');
              }
              const sent = await executor.slack.sendMessage({
                channel: String(input.channel),
                text: String(input.text),
              });
              return { provider_id: sent.ts, output: sent };
            },
          }
        : {
            step_index: 1,
            step_key: 'dispatch_wf6_gmail_proposal',
            action_key: approval.action_key,
            service: 'gmail',
            operation: 'send_message',
            buildInput: () => ({
              to: String(
                p.to ??
                  p.candidate_email ??
                  epState.candidate_email ??
                  'candidate@example.test',
              ),
              from: SAM_EMAIL,
              subject: String(p.subject ?? p.text ?? 'Interview Scheduling Update'),
              htmlBody: bodyText || '<p>Following up on your interview scheduling.</p>',
            }),
            outboundBody: () => ( approval.draft_sha256 ? bodyText : null ),
            execute: async (_ctx, input) => {
              if (!executor.gmail) {
                throw new Error('GmailProvider is required to execute WF6 Gmail proposal.');
              }
              const sent = await executor.gmail.sendMessage({
                to: String(input.to),
                from: String(input.from),
                subject: String(input.subject),
                htmlBody: String(input.htmlBody),
              });
              return { provider_id: sent.message_id, output: sent };
            },
          };

      const res = await executor.executeChain({
        chain_id: chainId,
        episode_id: approval.episode_id,
        workflow: 'wf6_scheduling',
        approval,
        expected_state: expected,
        fresh_snapshot: snapshot,
        steps: [step],
      });
      if (res.ok) {
        executor.store.markApprovalOutcome(approval.proposal_hash, 'executed', {
          now: executor.nowIso(),
        });
      }
      return res;
    },
  };
}

export function ingestCheckpointIfPresent(store, dataDir, nowIso, options = {}) {
  const checkpointPath = path.join(dataDir, 'checkpoint.json');
  assertPathNotSymlink(checkpointPath);
  if (!fs.existsSync(checkpointPath)) {
    return null;
  }
  const lease = store.getWriterLease('executor');
  const leaseHeldByOther =
    lease &&
    Date.parse(lease.expires_at) > Date.parse(nowIso) &&
    lease.pid !== process.pid;
  if (leaseHeldByOther && !options.ignoreActiveLease) {
    return null;
  }
  const raw = fs.readFileSync(checkpointPath, 'utf8');
  const parsed = JSON.parse(raw);
  return syncCheckpointToCoordinatorStore(store, parsed, {
    dataDir,
    now: nowIso,
    writeApprovalsMd: options.writeApprovalsMd ?? true,
    writeDraftsMd: options.writeDraftsMd ?? fs.existsSync(path.join(dataDir, 'DRAFTS.md')),
  });
}

function buildDryRunSyntheticFreshSnapshot(expected = {}, nowIso = new Date().toISOString()) {
  const status = Array.isArray(expected.application_status)
    ? expected.application_status[0] ?? 'active'
    : expected.application_status ?? 'active';
  const hasAppConstraint =
    expected.application_id !== undefined ||
    expected.application_status !== undefined ||
    expected.stage_id !== undefined;
  return {
    fetched_at: nowIso,
    application: hasAppConstraint
      ? {
          id: expected.application_id !== undefined ? Number(expected.application_id) : 1,
          status,
          current_stage_id:
            expected.stage_id !== undefined ? Number(expected.stage_id) : null,
        }
      : undefined,
    scorecards: [],
    interviews: expected.require_interviewer_rsvp_pending
      ? [
          {
            id: expected.require_interviewer_rsvp_pending.interview_id,
            status: 'scheduled',
            interviewers: [
              {
                user_id: expected.require_interviewer_rsvp_pending.interviewer_user_id,
                response_status: 'needs_action',
              },
            ],
          },
        ]
      : [],
    gmail: {
      last_message_id: expected.gmail_last_message_id ?? 'dryrun_msg_id',
      has_unsent_sam_draft: false,
      candidate_withdrew: false,
    },
    slack: {
      has_hm_override: false,
      hm_override_detected: false,
      reaction_removed: false,
    },
    calendar: {
      busy_intervals: [],
      conflicting_event_ids: [],
    },
  };
}

function cloneSqliteToTempDirReadOnly(liveDataDir, tempDir, existingStore = null) {
  const liveDbPath = path.join(liveDataDir, 'state.sqlite');
  const tempDbPath = path.join(tempDir, 'state.sqlite');
  assertPathNotSymlink(liveDbPath);
  if (!fs.existsSync(liveDbPath)) {
    return;
  }
  const escapedTempPath = tempDbPath.replace(/'/g, "''");
  if (existingStore) {
    try {
      existingStore.db.exec(`VACUUM INTO '${escapedTempPath}';`);
      return;
    } catch {
      // Fall back below
    }
  }
  let roDb = null;
  try {
    roDb = new DatabaseSync(liveDbPath, { readOnly: true });
    roDb.exec(`VACUUM INTO '${escapedTempPath}';`);
    return;
  } catch {
    for (const fname of ['state.sqlite', 'state.sqlite-wal']) {
      const src = path.join(liveDataDir, fname);
      assertPathNotSymlink(src);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(tempDir, fname));
      }
    }
  } finally {
    if (roDb) {
      try {
        roDb.close();
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * Runs a single 60-second deterministic executor tick.
 * When `options.dryRun === true`, executes against an isolated snapshot of `state.sqlite`
 * and `ledger.jsonl` using dry-run provider adapters so external services and live coordinator
 * state are never mutated.
 */
export async function runExecutorTick(options = {}) {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const dryRun = Boolean(options.dryRun);
  const nowFn = options.now ?? (() => new Date());
  const nowIso = nowFn().toISOString();

  if (dryRun) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-dryrun-'));
    try {
      cloneSqliteToTempDirReadOnly(dataDir, tempDir, options.store ?? null);
      for (const fname of ['ledger.jsonl', 'checkpoint.json']) {
        const src = path.join(dataDir, fname);
        assertPathNotSymlink(src);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(tempDir, fname));
        }
      }
      const dryStore = new SqliteCoordinatorStore(tempDir);
      try {
        ingestCheckpointIfPresent(dryStore, tempDir, nowIso, {
          writeApprovalsMd: false,
          writeDraftsMd: false,
        });
        const liveProviders = createLiveProviders({
          store: dryStore,
          dryRun: true,
          now: nowFn,
        });
        const dryFreshFetcher =
          options.freshReadFetcher ??
          (async (_episodeId, expected) =>
            buildDryRunSyntheticFreshSnapshot(expected, nowFn().toISOString()));

        const executor = new DeterministicExecutor({
          store: dryStore,
          dataDir: tempDir,
          actionService: liveProviders.actionService,
          calendar: liveProviders.calendar,
          gmail: liveProviders.gmail,
          slack: liveProviders.slack,
          actor: options.actor,
          now: nowFn,
          freshReadFetcher: dryFreshFetcher,
          timerHandlers: {
            ...buildDefaultTimerHandlers(options),
            ...(options.timerHandlers ?? {}),
          },
          approvalHandlers: {
            ...buildDefaultApprovalHandlers(options),
            ...(options.approvalHandlers ?? {}),
          },
        });

        const tickSummary = await executor.runTick({
          ownerId: options.ownerId,
          ttlMs: options.ttlMs,
        });
        return {
          ...tickSummary,
          dryRun: true,
          dryRunCalls: liveProviders.dryRunLog,
        };
      } finally {
        dryStore.close();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const ownStore = !options.store;
  const store = options.store ?? new SqliteCoordinatorStore(dataDir);

  try {
    if (ownStore || options.ingestCheckpoint) {
      ingestCheckpointIfPresent(store, dataDir, nowIso);
    }

    let actionService = options.actionService;
    if (!actionService && options.loadActionService) {
      actionService = await loadGreenhouseActionService(options.actionServiceOptions ?? {});
    }

    let configuredProviders = null;
    if (
      !options.calendar ||
      !options.gmail ||
      !options.slack ||
      (!options.freshReadFetcher &&
        (options.greenhouseRead ||
          options.gmailRead ||
          options.calendarRead ||
          options.slackRead ||
          process.env.GREENHOUSE_ACCESS_TOKEN))
    ) {
      const ghRead =
        options.greenhouseRead ??
        (process.env.GREENHOUSE_ACCESS_TOKEN
          ? createGreenhouseV3HttpReadAdapter({
              baseUrl: process.env.GREENHOUSE_BASE_URL,
              accessToken: process.env.GREENHOUSE_ACCESS_TOKEN,
            })
          : undefined);
      configuredProviders = createLiveProviders({
        store,
        dryRun: false,
        now: nowFn,
        greenhouseRead: ghRead,
        gmailRead: options.gmailRead,
        calendarRead: options.calendarRead,
        slackRead: options.slackRead,
        calendarTransport: options.calendarTransport,
        gmailTransport: options.gmailTransport,
        slackTransport: options.slackTransport,
        actionService,
      });
    }

    const freshReadFetcher =
      options.freshReadFetcher ??
      (options.greenhouseRead ||
      options.gmailRead ||
      options.calendarRead ||
      options.slackRead ||
      process.env.GREENHOUSE_ACCESS_TOKEN
        ? configuredProviders?.freshReadFetcher
        : undefined);

    const executor = new DeterministicExecutor({
      store,
      dataDir,
      actionService,
      calendar: options.calendar ?? configuredProviders?.calendar,
      gmail: options.gmail ?? configuredProviders?.gmail,
      slack: options.slack ?? configuredProviders?.slack,
      actor: options.actor,
      now: options.now,
      freshReadFetcher,
      timerHandlers: {
        ...buildDefaultTimerHandlers(options),
        ...(options.timerHandlers ?? {}),
      },
      approvalHandlers: {
        ...buildDefaultApprovalHandlers(options),
        ...(options.approvalHandlers ?? {}),
      },
    });

    const summary = await executor.runTick({
      ownerId: options.ownerId,
      ttlMs: options.ttlMs,
    });

    if (
      fs.existsSync(path.join(dataDir, 'APPROVALS.md')) ||
      fs.existsSync(path.join(dataDir, 'checkpoint.json'))
    ) {
      refreshApprovalsSummaryIfPresent(store, dataDir, nowIso);
    }

    return summary;
  } finally {
    if (ownStore) {
      store.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Operator CLI Helpers & Subcommands
// ---------------------------------------------------------------------------

const VALID_PROPOSAL_STATUSES = new Set([
  'pending',
  'approved',
  'executed',
  'declined',
  'stale_aborted',
  'all',
]);

const SENSITIVE_KEY_PATTERN =
  /base64|secret|token|password|content_bytes|^content$|api_?key|authorization|cookie|credential|private_?key|signing_?key/i;

export function sanitizeParams(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (
      /^Bearer\s+\S+/i.test(value) ||
      (value.length > 512 && /^[A-Za-z0-9+/=\r\n]+$/.test(value))
    ) {
      return '[REDACTED]';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(v => sanitizeParams(v));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeParams(v);
      }
    }
    return out;
  }
  return value;
}

export function sanitizeApprovalRow(row) {
  return {
    proposal_hash: row.proposal_hash,
    episode_id: row.episode_id,
    workflow: row.workflow,
    action_key: row.action_key,
    chain_id: row.chain_id ?? null,
    status: row.decision,
    decision: row.decision,
    actor: row.actor,
    params: sanitizeParams(row.params),
    expected_state: sanitizeParams(row.expected_state),
    draft_sha256: row.draft_sha256 ?? null,
    approved_at: row.approved_at ?? null,
    executed_at: row.executed_at ?? null,
    failure_reason: row.failure_reason ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function refreshApprovalsSummaryIfPresent(store, dataDir, nowIso, forceCreate = false) {
  const approvalsPath = path.join(dataDir, 'APPROVALS.md');
  const draftsPath = path.join(dataDir, 'DRAFTS.md');
  assertPathNotSymlink(approvalsPath);
  assertPathNotSymlink(draftsPath);
  if (forceCreate || fs.existsSync(approvalsPath)) {
    writeOperatorApprovalSummaries(store, {
      dataDir,
      now: nowIso,
      writeApprovalsMd: true,
      writeDraftsMd: fs.existsSync(draftsPath),
    });
  }
}

export function getCoordinatorStatus(options = {}) {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const nowIso = options.now ? options.now().toISOString() : new Date().toISOString();
  const ownStore = !options.store;
  const store = options.store ?? new SqliteCoordinatorStore(dataDir);

  try {
    if (ownStore) {
      ingestCheckpointIfPresent(store, dataDir, nowIso);
    }
    const lease = store.getWriterLease('executor');
    const leaseActive = Boolean(lease && Date.parse(lease.expires_at) > Date.parse(nowIso));

    const allEpisodes = store.listEpisodes();
    const episodesByStatus = {};
    for (const ep of allEpisodes) {
      episodesByStatus[ep.status] = (episodesByStatus[ep.status] ?? 0) + 1;
    }

    const allApprovals = store.listApprovals({ decision: 'all' });
    const approvalsByStatus = {};
    for (const app of allApprovals) {
      approvalsByStatus[app.decision] = (approvalsByStatus[app.decision] ?? 0) + 1;
    }

    const pendingApprovals = allApprovals
      .filter(a => a.decision === 'pending')
      .map(sanitizeApprovalRow);

    const dueTimers = store.listDueTimers(nowIso).map(t => ({
      timer_key: t.timer_key,
      episode_id: t.episode_id,
      kind: t.kind,
      fire_at: t.fire_at,
      attempt: t.attempt,
      status: t.status,
    }));

    const pendingTimers = store.listTimers({ status: 'pending' });
    const unresolvedIntentSteps = store.listUnresolvedIntentSteps().map(s => ({
      chain_id: s.chain_id,
      step_index: s.step_index,
      step_key: s.step_key,
      episode_id: s.episode_id,
      action_key: s.action_key,
      service: s.service,
      operation: s.operation,
      attempt: s.attempt,
      created_at: s.created_at,
      updated_at: s.updated_at,
    }));

    const conflictHolds = store.listConflictHolds({ status: 'CONFLICT_HOLD' });

    return {
      checked_at: nowIso,
      data_dir: dataDir,
      writer_lease: lease
        ? {
            ...lease,
            active: leaseActive,
          }
        : null,
      total_episodes: allEpisodes.length,
      episodes_by_status: episodesByStatus,
      approvals_by_status: approvalsByStatus,
      pending_approvals_count: pendingApprovals.length,
      pending_approvals: pendingApprovals,
      due_timers_count: dueTimers.length,
      due_timers: dueTimers,
      pending_timers_count: pendingTimers.length,
      unresolved_intent_steps_count: unresolvedIntentSteps.length,
      unresolved_intent_steps: unresolvedIntentSteps,
      conflict_holds_count: conflictHolds.length,
    };
  } finally {
    if (ownStore) {
      store.close();
    }
  }
}

function parsePositiveSafeInt(raw, fieldName) {
  const str = String(raw ?? '').trim();
  if (!/^[1-9]\d*$/.test(str)) {
    throw new Error(`Invalid ${fieldName}: ${raw}`);
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num <= 0) {
    throw new Error(`Invalid ${fieldName}: ${raw}`);
  }
  return num;
}

/**
 * Parses and executes operator CLI commands for `worker/executor-tick.mjs`.
 */
export async function runCli(argv = process.argv.slice(2), runtimeOptions = {}) {
  const args = [...argv];
  let subcommand = 'tick';
  if (args.length > 0 && !args[0].startsWith('-')) {
    subcommand = args.shift();
  }

  let dataDir = runtimeOptions.dataDir ?? DEFAULT_DATA_DIR;
  let dryRun = false;
  let statusFilter = 'all';
  let statusFlagProvided = false;
  let tableFormat = false;
  let runNow = false;
  let stageIdFlag = undefined;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--data-dir') {
      const nextVal = args[i + 1];
      if (!nextVal || nextVal.startsWith('-')) {
        throw new Error('Missing value for --data-dir');
      }
      dataDir = path.resolve(args[++i]);
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--run-now') {
      runNow = true;
    } else if (arg === '--table') {
      tableFormat = true;
    } else if (arg === '--status') {
      const nextVal = args[i + 1];
      if (!nextVal || nextVal.startsWith('-')) {
        throw new Error('Missing value for --status');
      }
      statusFilter = args[++i];
      statusFlagProvided = true;
    } else if (arg === '--stage-id') {
      const nextVal = args[i + 1];
      if (!nextVal || nextVal.startsWith('-')) {
        throw new Error('Missing value for --stage-id');
      }
      stageIdFlag = parsePositiveSafeInt(args[++i], '--stage-id');
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (dryRun && subcommand !== 'tick') {
    throw new Error("--dry-run is only supported with the 'tick' subcommand.");
  }
  if (runNow && subcommand !== 'approve') {
    throw new Error("--run-now is only supported with the 'approve' subcommand.");
  }
  if ((statusFlagProvided || tableFormat) && subcommand !== 'list-proposals') {
    throw new Error("--status and --table are only supported with the 'list-proposals' subcommand.");
  }
  if (stageIdFlag !== undefined && subcommand !== 'resolve-job') {
    throw new Error("--stage-id is only supported with the 'resolve-job' subcommand.");
  }

  const nowIso = runtimeOptions.now
    ? runtimeOptions.now().toISOString()
    : new Date().toISOString();

  if (subcommand === 'tick') {
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'tick': ${positional.join(' ')}`);
    }
    return await runExecutorTick({
      ...runtimeOptions,
      dataDir,
      dryRun,
      loadActionService:
        runtimeOptions.loadActionService ??
        Boolean(process.env.GREENHOUSE_ACTION_SIGNING_SECRET && !dryRun),
    });
  }

  if (subcommand === 'sync-checkpoint') {
    if (positional.length > 0) {
      throw new Error(
        `Unexpected positional arguments for 'sync-checkpoint': ${positional.join(' ')}`,
      );
    }
    const store = new SqliteCoordinatorStore(dataDir);
    try {
      const synced = ingestCheckpointIfPresent(store, dataDir, nowIso, {
        writeApprovalsMd: true,
        writeDraftsMd: true,
      });
      if (!synced) {
        throw new Error(`No checkpoint.json found in ${dataDir} (or writer_lease is busy).`);
      }
      return {
        command: 'sync-checkpoint',
        ...synced,
        pending_approvals: synced.pending_approvals.map(sanitizeApprovalRow),
      };
    } finally {
      store.close();
    }
  }

  if (subcommand === 'list-proposals') {
    if (positional.length > 0) {
      throw new Error(
        `Unexpected positional arguments for 'list-proposals': ${positional.join(' ')}. Use --status <status>.`,
      );
    }
    if (!VALID_PROPOSAL_STATUSES.has(statusFilter)) {
      throw new Error(
        `Invalid --status '${statusFilter}'. Expected one of: pending, approved, executed, declined, stale_aborted, all.`,
      );
    }
    const store = new SqliteCoordinatorStore(dataDir);
    try {
      ingestCheckpointIfPresent(store, dataDir, nowIso);
      const rows = store
        .listApprovals({ decision: statusFilter })
        .map(sanitizeApprovalRow);
      const table = tableFormat
        ? [
            'PROPOSAL_HASH     STATUS          WORKFLOW            EPISODE_ID                                  ACTION_KEY',
            '----------------  --------------  ------------------  ------------------------------------------  ----------------------------------------',
            ...rows.map(r =>
              [
                String(r.proposal_hash).padEnd(16),
                String(r.status).padEnd(14),
                String(r.workflow).padEnd(18),
                String(r.episode_id).slice(0, 42).padEnd(42),
                String(r.action_key),
              ].join('  '),
            ),
          ].join('\n')
        : undefined;
      return {
        command: 'list-proposals',
        status_filter: statusFilter,
        count: rows.length,
        proposals: rows,
        ...(table !== undefined ? { table } : {}),
      };
    } finally {
      store.close();
    }
  }

  if (subcommand === 'approve') {
    if (positional.length !== 1) {
      throw new Error('Usage: executor-tick.mjs approve <proposal_hash> [--data-dir <dir>] [--run-now]');
    }
    const proposalHash = positional[0];
    const store = new SqliteCoordinatorStore(dataDir);
    let updated;
    try {
      ingestCheckpointIfPresent(store, dataDir, nowIso);
      updated = store.grantApproval({
        proposal_hash: proposalHash,
        decision: 'approved',
        actor: 'sam',
        now: nowIso,
      });
      appendLedger(dataDir, {
        kind: 'approval',
        idempotency_key: `approval:${updated.proposal_hash}:approved`,
        decision: 'approved',
        actor: 'sam',
        proposal_hash: updated.proposal_hash,
        action_key: updated.action_key,
        episode_id: updated.episode_id,
        draft_sha256: updated.draft_sha256 ?? undefined,
        at: nowIso,
      });
      refreshApprovalsSummaryIfPresent(store, dataDir, nowIso, true);
    } finally {
      store.close();
    }

    let tickSummary = null;
    if (runNow) {
      tickSummary = await runExecutorTick({
        ...runtimeOptions,
        dataDir,
        dryRun: false,
        loadActionService:
          runtimeOptions.loadActionService ??
          Boolean(process.env.GREENHOUSE_ACTION_SIGNING_SECRET),
      });
    }

    return {
      command: 'approve',
      proposal: sanitizeApprovalRow(updated),
      ...(tickSummary ? { tick_summary: tickSummary } : {}),
    };
  }

  if (subcommand === 'decline') {
    if (positional.length !== 1) {
      throw new Error('Usage: executor-tick.mjs decline <proposal_hash> [--data-dir <dir>]');
    }
    const proposalHash = positional[0];
    const store = new SqliteCoordinatorStore(dataDir);
    try {
      ingestCheckpointIfPresent(store, dataDir, nowIso);
      const updated = store.grantApproval({
        proposal_hash: proposalHash,
        decision: 'declined',
        actor: 'sam',
        now: nowIso,
      });
      appendLedger(dataDir, {
        kind: 'approval',
        idempotency_key: `approval:${updated.proposal_hash}:declined`,
        decision: 'declined',
        actor: 'sam',
        proposal_hash: updated.proposal_hash,
        action_key: updated.action_key,
        episode_id: updated.episode_id,
        draft_sha256: updated.draft_sha256 ?? undefined,
        at: nowIso,
      });
      refreshApprovalsSummaryIfPresent(store, dataDir, nowIso, true);
      return {
        command: 'decline',
        proposal: sanitizeApprovalRow(updated),
      };
    } finally {
      store.close();
    }
  }

  if (subcommand === 'resolve-job') {
    if (positional.length !== 2) {
      throw new Error(
        'Usage: executor-tick.mjs resolve-job <episode_id> <job_id> [--stage-id <id>] [--data-dir <dir>]',
      );
    }
    const [episodeId, jobIdRaw] = positional;
    const jobId = parsePositiveSafeInt(jobIdRaw, 'job_id');
    const store = new SqliteCoordinatorStore(dataDir);
    try {
      ingestCheckpointIfPresent(store, dataDir, nowIso);
      const result = resolveJobMapping(store, {
        episode_id: episodeId,
        job_id: jobId,
        ...(stageIdFlag !== undefined ? { initial_stage_id: stageIdFlag } : {}),
        now: nowIso,
      });
      refreshApprovalsSummaryIfPresent(store, dataDir, nowIso, true);
      return {
        command: 'resolve-job',
        episode_id: result.episode.episode_id,
        job_id: result.episode.job_id,
        stage_id: result.episode.stage_id,
        status: result.episode.status,
        proposal: sanitizeApprovalRow(result.approval),
        has_pending_wf2_draft: result.has_pending_wf2_draft,
      };
    } finally {
      store.close();
    }
  }

  if (subcommand === 'resolve-conflict') {
    if (positional.length !== 3) {
      throw new Error(
        'Usage: executor-tick.mjs resolve-conflict <application_id> <stage_id> <advance|reject|hold> [--data-dir <dir>]',
      );
    }
    const [appIdRaw, stageIdRaw, rulingRaw] = positional;
    const applicationId = parsePositiveSafeInt(appIdRaw, 'application_id');
    const stageId = parsePositiveSafeInt(stageIdRaw, 'stage_id');
    const store = new SqliteCoordinatorStore(dataDir);
    try {
      ingestCheckpointIfPresent(store, dataDir, nowIso);
      const result = resolveWorkflow4ConflictHold(store, {
        application_id: applicationId,
        stage_id: stageId,
        ruling: rulingRaw,
        now: nowIso,
      });
      refreshApprovalsSummaryIfPresent(store, dataDir, nowIso, true);
      return {
        command: 'resolve-conflict',
        application_id: applicationId,
        stage_id: stageId,
        ruling: result.ruling,
        resolved: result.resolved,
        holds: result.holds.map(h => ({
          ...h,
          details: sanitizeParams(h.details),
        })),
        episodes_updated: result.episodes_updated,
        proposal: result.proposal ? sanitizeApprovalRow(result.proposal) : null,
        timer_key: result.timer?.timer_key ?? null,
      };
    } finally {
      store.close();
    }
  }

  if (subcommand === 'status') {
    if (positional.length > 0) {
      throw new Error(`Unexpected positional arguments for 'status': ${positional.join(' ')}`);
    }
    return getCoordinatorStatus({
      dataDir,
      now: runtimeOptions.now,
    });
  }

  throw new Error(
    `Unknown subcommand '${subcommand}'. Expected one of: tick, sync-checkpoint, list-proposals, approve, decline, resolve-job, resolve-conflict, status.`,
  );
}

async function main() {
  const result = await runCli(process.argv.slice(2));
  if (typeof result?.table === 'string') {
    process.stdout.write(`${result.table}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
  if (Array.isArray(result?.errors) && result.errors.length > 0) {
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch(err => {
    process.stderr.write(`executor-tick failed: ${err?.stack ?? err}\n`);
    process.exitCode = 1;
  });
}
