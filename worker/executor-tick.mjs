#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DeterministicExecutor,
  loadGreenhouseActionService,
} from '../src/executor/index.ts';
import {
  DEFAULT_DATA_DIR,
  SqliteCoordinatorStore,
} from '../src/store/sqlite.ts';
import {
  fireWorkflow4DeliberatedRejection,
} from '../src/workflows/wf4-rejection.ts';
import {
  fireStep7RsvpChase,
  fireStep10ScorecardChase24h,
  reconcileStep10ScorecardCompletion,
} from '../src/workflows/wf6-scheduling.ts';
import {
  executeWorkflow1IntakeChain,
  handleJobMappingUrgentReminderTimer,
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
      if (!snapshot) return;
      if (executor.gmail && p.candidate_email) {
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
        if (res.ok) {
          executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: executor.nowIso() });
        }
      } else {
        executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: executor.nowIso() });
      }
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
      if (snapshot?.scorecards) {
        const check = reconcileStep10ScorecardCompletion(executor.store, {
          interview_id: p.interview_id,
          interviewer_user_id: Number(p.interviewer_user_id),
          scorecards: snapshot.scorecards,
          now: executor.nowIso(),
        });
        if (check.completed) return;
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

/**
 * Builds default approval handlers for WF1, WF2, WF3, and WF5.
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
  };
}

/**
 * Runs a single 60-second deterministic executor tick.
 */
export async function runExecutorTick(options = {}) {
  const dataDir = options.dataDir ?? DEFAULT_DATA_DIR;
  const ownStore = !options.store;
  const store = options.store ?? new SqliteCoordinatorStore(dataDir);

  try {
    let actionService = options.actionService;
    if (!actionService && options.loadActionService) {
      actionService = await loadGreenhouseActionService(options.actionServiceOptions ?? {});
    }

    const executor = new DeterministicExecutor({
      store,
      dataDir,
      actionService,
      calendar: options.calendar,
      gmail: options.gmail,
      slack: options.slack,
      actor: options.actor,
      now: options.now,
      freshReadFetcher: options.freshReadFetcher,
      timerHandlers: {
        ...buildDefaultTimerHandlers(options),
        ...(options.timerHandlers ?? {}),
      },
      approvalHandlers: {
        ...buildDefaultApprovalHandlers(options),
        ...(options.approvalHandlers ?? {}),
      },
    });

    return await executor.runTick({
      ownerId: options.ownerId,
      ttlMs: options.ttlMs,
    });
  } finally {
    if (ownStore) {
      store.close();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let dataDir = DEFAULT_DATA_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir' && args[i + 1]) {
      dataDir = path.resolve(args[++i]);
    }
  }

  const summary = await runExecutorTick({
    dataDir,
    loadActionService: Boolean(process.env.GREENHOUSE_ACTION_SIGNING_SECRET),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch(err => {
    process.stderr.write(`executor-tick failed: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
