import {
  type ChainStepDefinition,
  type DeterministicExecutor,
  type ExecuteChainResult,
  type ExpectedFreshState,
  type FreshReadSnapshot,
  SAM_EMAIL,
  SAM_GREENHOUSE_USER_ID,
} from '../executor/index.ts';
import { type ApprovalRow, type SqliteCoordinatorStore } from '../store/sqlite.ts';
import {
  addLocalCalendarDays,
  addWorkingHours,
  getLocalParts,
  isBusinessDay,
  localWallClockToUtcMs,
  resolveTimezone,
} from '../utils/timezone.ts';

export const INTERVIEWER_ROLE_ID = 4018588004;
export const CANDIDATE_CONFIRMATION_TEMPLATE_ID = 4151798004;
export const FIELD_ENG_HIRING_SLACK_CHANNEL = 'C0C9VEPBAJC';
export const FDE_JOB_ID = 5149015004;
export const KHIEM_DOAN_USER_ID = 5372540004;
export const KHIEM_DOAN_EMAIL = 'khiem.doan@turing.com';

const AMBIGUOUS_POST_MUTATION_ERROR_CODES = new Set([
  'UPSTREAM_RESULT_NOT_OBSERVED',
  'UPSTREAM_READBACK_FAILED',
  'UPSTREAM_RESULT_CONFLICT',
  'INTERVIEW_ALREADY_RECORDED',
  'PARTIAL_APPLIED',
]);

export function buildGreenhouseInterviewKitUrl(
  interviewKitId: number | string,
  candidateId: number | string,
  applicationId: number | string,
): string {
  return `https://app4.greenhouse.io/guides/${interviewKitId}/people/${candidateId}?application_id=${applicationId}`;
}

export function renderConfirmationTemplate4151798004(input: {
  candidate_first_name: string;
  job_title: string;
  interview_name: string;
  interviewer_name: string;
  starts_at_formatted: string;
  duration_minutes: number;
  meet_link: string;
  raw_template?: string;
}): { subject: string; htmlBody: string } {
  const subject = `Interview Confirmation: ${input.job_title} — ${input.interview_name}`;
  const defaultTemplate =
    input.raw_template ??
    `<p>Hi {{candidate_first_name}},</p>
<p>Your {{interview_name}} for the {{job_title}} role with {{interviewer_name}} ({{duration_minutes}} minutes) is confirmed for {{starts_at_formatted}}.</p>
<p><strong>Video Call Link:</strong> [Enter Zoom Link]</p>
<p>Best,<br/>Sam Vangelos</p>`;

  const htmlBody = defaultTemplate
    .replace(/\{\{\s*candidate_first_name\s*\}\}/g, input.candidate_first_name)
    .replace(/\{\{\s*job_title\s*\}\}/g, input.job_title)
    .replace(/\{\{\s*interview_name\s*\}\}/g, input.interview_name)
    .replace(/\{\{\s*interviewer_name\s*\}\}/g, input.interviewer_name)
    .replace(/\{\{\s*duration_minutes\s*\}\}/g, String(input.duration_minutes))
    .replace(/\{\{\s*starts_at_formatted\s*\}\}/g, input.starts_at_formatted)
    .replace(/\[Enter Zoom Link\]/gi, input.meet_link)
    .replace(/\{\{\s*video_conferencing_url\s*\}\}/g, input.meet_link);

  if (/\{\{[^}]+\}\}|\[Enter [^\]]+\]/i.test(htmlBody)) {
    throw new Error('Rendered confirmation template contains unresolved placeholder tokens.');
  }

  return { subject, htmlBody };
}

// ============================================================================
// Step 1: Spot HM's Yes -> Move to Target Interview Stage
// ============================================================================

export async function executeStep1HmYesStageMove(
  executor: DeterministicExecutor,
  params: {
    episode_id: string;
    application_id: number;
    from_stage_id: number;
    to_stage_id: number;
    approval?: ApprovalRow | null;
    fresh_snapshot: FreshReadSnapshot;
  },
): Promise<ExecuteChainResult> {
  const chainId = `wf6_step1_move:${params.application_id}:${params.to_stage_id}`;
  const actionKey = `advance_stage:${params.application_id}:${params.to_stage_id}`;

  return executor.executeChain({
    chain_id: chainId,
    episode_id: params.episode_id,
    workflow: 'wf6_scheduling',
    approval: params.approval ?? null,
    exception: params.approval ? null : 'step1_stage_move',
    expected_state: {
      application_id: params.application_id,
      application_status: 'active',
      stage_id: params.from_stage_id,
      require_no_reaction_removal: true,
    },
    fresh_snapshot: params.fresh_snapshot,
    steps: [
      {
        step_index: 1,
        step_key: 'move_application_stage',
        action_key: actionKey,
        service: 'greenhouse',
        operation: 'application_stage_move',
        exception: params.approval ? null : 'step1_stage_move',
        buildInput: () => ({
          application_id: params.application_id,
          to_stage_id: params.to_stage_id,
          email_from_user_id: SAM_GREENHOUSE_USER_ID,
        }),
      },
    ],
  });
}

// ============================================================================
// Step 2: Candidate Availability Request & 24h/48h Working-Hour Timers
// ============================================================================

export function scheduleStep2AvailabilityChases(
  store: SqliteCoordinatorStore,
  params: {
    episode_id: string;
    application_id: number;
    stage_id: number;
    candidate_email: string;
    candidate_tz?: string | null;
    requested_at: string;
  },
): { nudge24hKey: string; escalate48hKey: string } {
  const tz = resolveTimezone(params.candidate_tz);
  const fire24h = addWorkingHours(params.requested_at, 24, tz);
  const fire48h = addWorkingHours(params.requested_at, 48, tz);

  const nudge24hKey = `avail_nudge_24h:${params.application_id}:${params.stage_id}`;
  const escalate48hKey = `avail_escalate_48h:${params.application_id}:${params.stage_id}`;

  store.scheduleTimer({
    timer_key: nudge24hKey,
    episode_id: params.episode_id,
    kind: 'wf6_avail_nudge_24h',
    fire_at: fire24h,
    payload: {
      application_id: params.application_id,
      stage_id: params.stage_id,
      candidate_email: params.candidate_email,
      candidate_tz: tz,
    },
    now: params.requested_at,
  });

  store.scheduleTimer({
    timer_key: escalate48hKey,
    episode_id: params.episode_id,
    kind: 'wf6_avail_escalate_48h',
    fire_at: fire48h,
    payload: {
      application_id: params.application_id,
      stage_id: params.stage_id,
      candidate_email: params.candidate_email,
      candidate_tz: tz,
    },
    now: params.requested_at,
  });

  return { nudge24hKey, escalate48hKey };
}

// ============================================================================
// Step 3, 4, 5: Candidate Availability Parsing, Overlap Finder & 3 Earliest Slots
// ============================================================================

export interface LocalAvailabilityWindowInput {
  date: string; // YYYY-MM-DD in candidate's local timezone
  start_time: string; // HH:MM (24h)
  end_time: string; // HH:MM (24h)
}

export interface UtcInterval {
  start_utc: string;
  end_utc: string;
  start_ms: number;
  end_ms: number;
}

export function parseCandidateAvailabilityWindows(
  windows: LocalAvailabilityWindowInput[],
  candidateTzInput?: string | null,
): { candidate_tz: string; intervals: UtcInterval[] } {
  const candidateTz = resolveTimezone(candidateTzInput);
  const intervals: UtcInterval[] = [];

  for (const w of windows) {
    const [year, month, day] = w.date.split('-').map(Number);
    const [startHour, startMin] = w.start_time.split(':').map(Number);
    const [endHour, endMin] = w.end_time.split(':').map(Number);
    const startMs = localWallClockToUtcMs(year, month, day, startHour, startMin, 0, candidateTz);
    const endMs = localWallClockToUtcMs(year, month, day, endHour, endMin, 0, candidateTz);
    if (endMs > startMs) {
      intervals.push({
        start_utc: new Date(startMs).toISOString(),
        end_utc: new Date(endMs).toISOString(),
        start_ms: startMs,
        end_ms: endMs,
      });
    }
  }

  intervals.sort((a, b) => a.start_ms - b.start_ms);
  return { candidate_tz: candidateTz, intervals };
}

export function findOverlappingInterviewerSlot(params: {
  candidate_intervals: UtcInterval[];
  interviewer_open_intervals: UtcInterval[];
  duration_minutes: number;
  interviewer_tz?: string | null;
}): UtcInterval | null {
  const durationMs = params.duration_minutes * 60_000;
  const interviewerTz = resolveTimezone(params.interviewer_tz);

  const sortedCand = [...params.candidate_intervals].sort((a, b) => a.start_ms - b.start_ms);
  const sortedInt = [...params.interviewer_open_intervals].sort((a, b) => a.start_ms - b.start_ms);

  for (const cand of sortedCand) {
    for (const open of sortedInt) {
      const overlapStart = Math.max(cand.start_ms, open.start_ms);
      const overlapEnd = Math.min(cand.end_ms, open.end_ms);
      if (overlapEnd - overlapStart < durationMs) continue;

      // Scan across days inside [overlapStart, overlapEnd - durationMs], clamping to 09:00-17:00
      // on business days (Mon-Fri, non-holiday) in interviewer's local timezone.
      let cursor = overlapStart;
      let guard = 0;
      while (cursor + durationMs <= overlapEnd && guard++ < 60) {
        const startParts = getLocalParts(cursor, interviewerTz);
        const dayNineAm = localWallClockToUtcMs(
          startParts.year,
          startParts.month,
          startParts.day,
          9,
          0,
          0,
          interviewerTz,
        );
        const dayFivePm = localWallClockToUtcMs(
          startParts.year,
          startParts.month,
          startParts.day,
          17,
          0,
          0,
          interviewerTz,
        );

        const slotStart = Math.max(cursor, dayNineAm);
        const slotEnd = slotStart + durationMs;

        if (
          isBusinessDay(slotStart, interviewerTz) &&
          slotEnd <= dayFivePm &&
          slotEnd <= overlapEnd
        ) {
          const endParts = getLocalParts(slotEnd, interviewerTz);
          if (startParts.dateStr === endParts.dateStr) {
            return {
              start_utc: new Date(slotStart).toISOString(),
              end_utc: new Date(slotEnd).toISOString(),
              start_ms: slotStart,
              end_ms: slotEnd,
            };
          }
        }

        // Advance cursor to 09:00 on the next calendar day in interviewerTz
        const nextDay = addLocalCalendarDays(startParts.year, startParts.month, startParts.day, 1);
        cursor = localWallClockToUtcMs(
          nextDay.year,
          nextDay.month,
          nextDay.day,
          9,
          0,
          0,
          interviewerTz,
        );
      }
    }
  }

  return null;
}

export function selectThreeEarliestOpenSlots(params: {
  interviewer_open_intervals: UtcInterval[];
  duration_minutes: number;
  interviewer_tz?: string | null;
}): UtcInterval[] {
  const durationMs = params.duration_minutes * 60_000;
  const interviewerTz = resolveTimezone(params.interviewer_tz);
  const sorted = [...params.interviewer_open_intervals].sort((a, b) => a.start_ms - b.start_ms);
  const results: UtcInterval[] = [];

  for (const open of sorted) {
    let cursor = open.start_ms;
    let guard = 0;
    while (cursor + durationMs <= open.end_ms && results.length < 3 && guard++ < 200) {
      const startParts = getLocalParts(cursor, interviewerTz);
      const dayNineAm = localWallClockToUtcMs(
        startParts.year,
        startParts.month,
        startParts.day,
        9,
        0,
        0,
        interviewerTz,
      );
      const dayFivePm = localWallClockToUtcMs(
        startParts.year,
        startParts.month,
        startParts.day,
        17,
        0,
        0,
        interviewerTz,
      );

      if (cursor < dayNineAm) {
        cursor = dayNineAm;
        continue;
      }

      if (
        !isBusinessDay(cursor, interviewerTz) ||
        cursor + durationMs > dayFivePm
      ) {
        const nextDay = addLocalCalendarDays(startParts.year, startParts.month, startParts.day, 1);
        cursor = localWallClockToUtcMs(
          nextDay.year,
          nextDay.month,
          nextDay.day,
          9,
          0,
          0,
          interviewerTz,
        );
        continue;
      }

      const endParts = getLocalParts(cursor + durationMs, interviewerTz);
      if (startParts.dateStr === endParts.dateStr) {
        results.push({
          start_utc: new Date(cursor).toISOString(),
          end_utc: new Date(cursor + durationMs).toISOString(),
          start_ms: cursor,
          end_ms: cursor + durationMs,
        });
      }
      cursor += durationMs;
    }
    if (results.length >= 3) break;
  }

  return results;
}

// ============================================================================
// Step 6: Chain A — Booking & Kit Link
// (user_job_permission_create -> silent Google Calendar hold -> interview_create -> patch calendar hold)
// ============================================================================

export interface Step6BookingChainParams {
  episode_id: string;
  application_id: number;
  candidate_id: number;
  candidate_name: string;
  candidate_email: string;
  job_id: number;
  job_title: string;
  stage_id: number;
  job_interview_id: number;
  interview_kit_id: number;
  interview_name: string;
  interviewer_user_id: number;
  interviewer_name: string;
  interviewer_email: string;
  interviewer_slack_id: string;
  interviewer_tz?: string | null;
  starts_at: string;
  ends_at: string;
  approval?: ApprovalRow | null;
  exception?: string | null;
  fresh_snapshot?: FreshReadSnapshot;
  expected_state?: ExpectedFreshState;
}

export async function executeStep6BookingChain(
  executor: DeterministicExecutor,
  params: Step6BookingChainParams,
): Promise<ExecuteChainResult> {
  if (!executor.calendar) {
    throw new Error('CalendarProvider is required for Step 6 booking chain.');
  }
  const calendar = executor.calendar;
  const chainId = `wf6_step6_book:${params.application_id}:${params.job_interview_id}:${params.starts_at}`;
  const kitUrl = buildGreenhouseInterviewKitUrl(
    params.interview_kit_id,
    params.candidate_id,
    params.application_id,
  );
  const holdSummary = `HOLD: ${params.interview_name} — ${params.candidate_name}`;

  executor.store.upsertEpisode({
    episode_id: params.episode_id,
    workflow: 'wf6_scheduling',
    application_id: params.application_id,
    candidate_id: params.candidate_id,
    job_id: params.job_id,
    stage_id: params.stage_id,
    status: 'booking_in_progress',
    state: {
      candidate_name: params.candidate_name,
      candidate_email: params.candidate_email,
      job_interview_id: params.job_interview_id,
      interview_kit_id: params.interview_kit_id,
      interviewer_user_id: params.interviewer_user_id,
      interviewer_email: params.interviewer_email,
      interviewer_slack_id: params.interviewer_slack_id,
      starts_at: params.starts_at,
      ends_at: params.ends_at,
    },
    now: executor.nowIso(),
  });

  const steps: ChainStepDefinition[] = [
    // Step 6.1: Ensure interviewer holds Interviewer role (4018588004) on the job
    {
      step_index: 1,
      step_key: 'grant_interviewer_permission',
      action_key: `user_job_permission_create:${params.job_id}:${params.interviewer_user_id}:${INTERVIEWER_ROLE_ID}`,
      service: 'greenhouse',
      operation: 'user_job_permission_create',
      exception: params.approval ? null : 'step6_interviewer_role',
      buildInput: () => ({
        user_id: params.interviewer_user_id,
        job_id: params.job_id,
        role_id: INTERVIEWER_ROLE_ID,
      }),
    },

    // Step 6.2: Create silent Google Calendar hold (sendUpdates: "none", attendees: [])
    // Stored in chain_steps BEFORE interview_create so crash recovery reuses hold_event_id!
    {
      step_index: 2,
      step_key: 'create_silent_calendar_hold',
      action_key: `create_hold:${params.application_id}:${params.job_interview_id}:${params.starts_at}`,
      service: 'calendar',
      operation: 'create_silent_hold',
      exception: params.approval ? null : 'calendar_hold',
      buildInput: () => ({
        summary: holdSummary,
        description: `Silent hold for ${params.candidate_name} (${params.job_title})`,
        start: params.starts_at,
        end: params.ends_at,
        timeZone: resolveTimezone(params.interviewer_tz),
        conferenceRequestId: `hold-${params.application_id}-${params.job_interview_id}`,
      }),
      reconcile: async (_ctx, stepRow) => {
        if (stepRow.provider_id && calendar.getEvent) {
          const ev = await calendar.getEvent(stepRow.provider_id);
          if (ev && ev.status !== 'cancelled') {
            return {
              reconciled: true,
              provider_id: ev.event_id,
              output: {
                event_id: ev.event_id,
                hangout_link: ev.hangout_link ?? null,
              },
            };
          }
        }
        if (!stepRow.provider_id && calendar.listEvents) {
          const eventsInWindow = await calendar.listEvents({
            start: params.starts_at,
            end: params.ends_at,
          });
          const matched = eventsInWindow.find(
            ev => ev.status !== 'cancelled' && ev.summary === holdSummary,
          );
          if (matched) {
            return {
              reconciled: true,
              provider_id: matched.event_id,
              output: {
                event_id: matched.event_id,
                hangout_link: matched.hangout_link ?? null,
              },
            };
          }
          return { reconciled: false, allowSafeRetry: true };
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        const hold = await calendar.createSilentHold({
          summary: String(input.summary),
          description: String(input.description ?? ''),
          start: String(input.start),
          end: String(input.end),
          timeZone: String(input.timeZone),
          conferenceRequestId: String(input.conferenceRequestId),
        });
        return {
          provider_id: hold.event_id,
          output: {
            event_id: hold.event_id,
            hangout_link: hold.hangout_link ?? 'https://meet.google.com/generated-meet-link',
            html_link: hold.html_link ?? null,
          },
        };
      },
    },

    // Step 6.3: Create Greenhouse interview via interview_create (POST /v3/interviews)
    // referencing external_event_id = hold_event_id.
    // If POST /v3/interviews fails BEFORE creating the interview in Greenhouse, delete the silent hold!
    {
      step_index: 3,
      step_key: 'create_greenhouse_interview',
      action_key: `interview_create:${params.application_id}:${params.job_interview_id}:${params.starts_at}`,
      service: 'greenhouse',
      operation: 'interview_create',
      exception: params.approval ? null : 'step8_standard_confirmation',
      buildInput: ctx => {
        const holdEventId =
          ctx.priorProviderIds['create_silent_calendar_hold'] ??
          String(ctx.priorOutputs['create_silent_calendar_hold']?.event_id ?? '');
        const hangoutLink = String(
          ctx.priorOutputs['create_silent_calendar_hold']?.hangout_link ??
            'https://meet.google.com/generated-meet-link',
        );
        if (!holdEventId) {
          throw new Error('Missing hold_event_id from create_silent_calendar_hold step.');
        }
        return {
          application_id: params.application_id,
          job_interview_id: params.job_interview_id,
          interviewers: [
            {
              user_id: params.interviewer_user_id,
              response_status: 'needs_action',
            },
          ],
          starts_at: params.starts_at,
          ends_at: params.ends_at,
          external_event_id: holdEventId,
          location: 'Google Meet',
          video_conferencing_url: hangoutLink,
        };
      },
      onErrorCompensate: async (ctx, error: any) => {
        // Never delete the calendar hold if the error occurred post-mutation / ambiguously
        const errCode = String(error?.code ?? '');
        if (AMBIGUOUS_POST_MUTATION_ERROR_CODES.has(errCode)) {
          return;
        }
        const holdEventId =
          ctx.priorProviderIds['create_silent_calendar_hold'] ??
          String(ctx.priorOutputs['create_silent_calendar_hold']?.event_id ?? '');
        if (!holdEventId) return;

        // Also check via preview whether the interview was actually recorded in Greenhouse
        if (executor.actionService) {
          try {
            const check = await executor.actionService.preview(
              'interview_create',
              {
                application_id: params.application_id,
                job_interview_id: params.job_interview_id,
                interviewers: [{ user_id: params.interviewer_user_id, response_status: 'needs_action' }],
                starts_at: params.starts_at,
                ends_at: params.ends_at,
                external_event_id: holdEventId,
              },
              executor.actor,
              'ops_executor',
            );
            if (
              check.already_recorded?.interview_id != null ||
              check.before?.already_recorded_interview_id != null
            ) {
              return;
            }
          } catch {
            // Proceed to cleanup silent hold if preview itself does not report an existing interview
          }
        }

        await calendar.deleteEvent({
          event_id: holdEventId,
          sendUpdates: 'none',
        });
      },
    },

    // Step 6.4: Patch Google Calendar hold with interviewer attendee, candidate details & kit link (sendUpdates: "all")
    {
      step_index: 4,
      step_key: 'patch_calendar_hold_with_interviewer_and_kit',
      action_key: `patch_hold_interviewer:${params.application_id}:${params.job_interview_id}:${params.starts_at}`,
      service: 'calendar',
      operation: 'patch_event',
      exception: params.approval ? null : 'calendar_hold',
      buildInput: ctx => {
        const holdEventId =
          ctx.priorProviderIds['create_silent_calendar_hold'] ??
          String(ctx.priorOutputs['create_silent_calendar_hold']?.event_id ?? '');
        const interviewId =
          ctx.priorProviderIds['create_greenhouse_interview'] ??
          String(ctx.priorOutputs['create_greenhouse_interview']?.id ?? '');
        return {
          event_id: holdEventId,
          interview_id: interviewId,
          summary: `${params.interview_name}: ${params.candidate_name} (${params.job_title})`,
          description: [
            `Candidate: ${params.candidate_name} (${params.candidate_email})`,
            `Role: ${params.job_title}`,
            `Stage: ${params.interview_name}`,
            `Greenhouse Interview Kit: ${kitUrl}`,
          ].join('\n'),
          attendees: [{ email: params.interviewer_email, responseStatus: 'needsAction' }],
          sendUpdates: 'all',
        };
      },
      reconcile: async (_ctx, stepRow) => {
        const evId = String((stepRow.input as Record<string, unknown>)?.event_id ?? '');
        if (evId && calendar.getEvent) {
          const ev = await calendar.getEvent(evId);
          const hasInterviewer = ev?.attendees?.some(
            a => a.email.toLowerCase() === params.interviewer_email.toLowerCase(),
          );
          if (hasInterviewer) {
            return {
              reconciled: true,
              provider_id: evId,
              output: { event_id: evId, kit_url: kitUrl },
            };
          }
          if (ev) {
            return { reconciled: false, allowSafeRetry: true };
          }
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        const patched = await calendar.patchEvent({
          event_id: String(input.event_id),
          summary: String(input.summary),
          description: String(input.description),
          attendees: input.attendees as Array<{ email: string; responseStatus?: string }>,
          sendUpdates: 'all',
        });
        return {
          provider_id: patched.event_id,
          output: {
            event_id: patched.event_id,
            kit_url: kitUrl,
            hangout_link: patched.hangout_link ?? null,
          },
        };
      },
    },
  ];

  const result = await executor.executeChain({
    chain_id: chainId,
    episode_id: params.episode_id,
    workflow: 'wf6_scheduling',
    approval: params.approval ?? null,
    exception: params.approval ? null : (params.exception ?? null),
    expected_state: params.expected_state ?? {
      application_id: params.application_id,
      application_status: 'active',
      stage_id: params.stage_id,
    },
    fresh_snapshot: params.fresh_snapshot,
    steps,
  });

  if (result.ok) {
    const interviewId =
      result.step_results['create_greenhouse_interview']?.provider_id ?? '';
    const holdEventId =
      result.step_results['create_silent_calendar_hold']?.provider_id ?? '';
    const hangoutLink = String(
      result.step_results['create_silent_calendar_hold']?.output?.hangout_link ??
        'https://meet.google.com/generated-meet-link',
    );

    executor.store.upsertEpisode({
      episode_id: params.episode_id,
      workflow: 'wf6_scheduling',
      application_id: params.application_id,
      candidate_id: params.candidate_id,
      job_id: params.job_id,
      stage_id: params.stage_id,
      status: 'awaiting_interviewer_rsvp',
      state: {
        interview_id: Number(interviewId) || interviewId,
        hold_event_id: holdEventId,
        hangout_link: hangoutLink,
        kit_url: kitUrl,
        interviewer_user_id: params.interviewer_user_id,
        interviewer_email: params.interviewer_email,
        interviewer_slack_id: params.interviewer_slack_id,
        interviewer_tz: resolveTimezone(params.interviewer_tz),
        candidate_name: params.candidate_name,
        candidate_email: params.candidate_email,
        starts_at: params.starts_at,
        ends_at: params.ends_at,
        rsvp_attempt: 1,
      },
      now: executor.nowIso(),
    });

    scheduleStep7RsvpChases(executor.store, {
      episode_id: params.episode_id,
      interview_id: interviewId,
      application_id: params.application_id,
      interviewer_user_id: params.interviewer_user_id,
      interviewer_slack_id: params.interviewer_slack_id,
      interviewer_tz: params.interviewer_tz,
      candidate_name: params.candidate_name,
      interview_name: params.interview_name,
      starts_at: params.starts_at,
      booked_at: executor.nowIso(),
      attempt: 1,
    });
  }

  return result;
}

// ============================================================================
// Step 7: Interviewer RSVP Monitoring, Autonomous +12h / +24h Slack Chases & Decline Handling
// ============================================================================

export function scheduleStep7RsvpChases(
  store: SqliteCoordinatorStore,
  params: {
    episode_id: string;
    interview_id: number | string;
    application_id: number;
    interviewer_user_id: number;
    interviewer_slack_id: string;
    interviewer_tz?: string | null;
    candidate_name: string;
    interview_name: string;
    starts_at: string;
    booked_at: string;
    attempt?: number;
  },
): {
  chase12hKey: string;
  chase24hKey: string;
  escalate48hKey: string;
} {
  const attempt = params.attempt ?? 1;
  const tz = resolveTimezone(params.interviewer_tz);
  const fire12h = addWorkingHours(params.booked_at, 12, tz);
  const fire24h = addWorkingHours(params.booked_at, 24, tz);
  const fire48h = addWorkingHours(params.booked_at, 48, tz);

  const chase12hKey = `chase12h:${params.interview_id}:${params.interviewer_user_id}:${attempt}`;
  const chase24hKey = `chase24h:${params.interview_id}:${params.interviewer_user_id}:${attempt}`;
  const escalate48hKey = `rsvp_escalate48h:${params.interview_id}:${params.interviewer_user_id}:${attempt}`;

  const commonPayload = {
    interview_id: params.interview_id,
    application_id: params.application_id,
    interviewer_user_id: params.interviewer_user_id,
    interviewer_slack_id: params.interviewer_slack_id,
    interviewer_tz: tz,
    candidate_name: params.candidate_name,
    interview_name: params.interview_name,
    starts_at: params.starts_at,
    attempt,
  };

  store.scheduleTimer({
    timer_key: chase12hKey,
    episode_id: params.episode_id,
    kind: 'wf6_rsvp_chase_12h',
    fire_at: fire12h,
    attempt,
    payload: commonPayload,
    now: params.booked_at,
  });

  store.scheduleTimer({
    timer_key: chase24hKey,
    episode_id: params.episode_id,
    kind: 'wf6_rsvp_chase_24h',
    fire_at: fire24h,
    attempt,
    payload: commonPayload,
    now: params.booked_at,
  });

  store.scheduleTimer({
    timer_key: escalate48hKey,
    episode_id: params.episode_id,
    kind: 'wf6_rsvp_escalate_48h',
    fire_at: fire48h,
    attempt,
    payload: commonPayload,
    now: params.booked_at,
  });

  return { chase12hKey, chase24hKey, escalate48hKey };
}

export function cancelStep7RsvpTimersForInterview(
  store: SqliteCoordinatorStore,
  interviewId: number | string,
  reason: string,
  now?: string,
): number {
  let count = 0;
  count += store.cancelTimersByPrefix(`chase12h:${interviewId}:`, reason, now);
  count += store.cancelTimersByPrefix(`chase24h:${interviewId}:`, reason, now);
  count += store.cancelTimersByPrefix(`rsvp_escalate48h:${interviewId}:`, reason, now);
  return count;
}

export function cancelPostConfirmationTimersForInterview(
  store: SqliteCoordinatorStore,
  interviewId: number | string,
  reason: string,
  now?: string,
): number {
  let count = 0;
  count += store.cancelTimersByPrefix(`reminder_day_before:${interviewId}`, reason, now);
  count += store.cancelTimersByPrefix(`pre_interview_check:${interviewId}`, reason, now);
  count += store.cancelTimersByPrefix(`scorecard_reminder_2h:${interviewId}:`, reason, now);
  count += store.cancelTimersByPrefix(`scorecard_chase_24h:${interviewId}:`, reason, now);
  return count;
}

/**
 * Fires an autonomous Ruling 4 Slack DM RSVP chase (+12h or +24h working hours).
 * Verifies the interviewer has not already accepted/declined, and threads the +24h follow-up
 * onto the +12h Slack DM thread (`thread_ts`) when present.
 */
export async function fireStep7RsvpChase(
  executor: DeterministicExecutor,
  params: {
    timer_key: string;
    episode_id: string;
    tier: '12h' | '24h';
    interview_id: number | string;
    application_id: number;
    interviewer_user_id: number;
    interviewer_slack_id: string;
    candidate_name: string;
    interview_name: string;
    starts_at: string;
    attempt: number;
    fresh_snapshot: FreshReadSnapshot;
  },
): Promise<ExecuteChainResult> {
  if (!executor.slack) {
    throw new Error('SlackProvider is required to fire Step 7 RSVP chases.');
  }
  const slack = executor.slack;
  const exception = params.tier === '12h' ? '12h_rsvp_chase' : '24h_rsvp_chase';
  const actionKey =
    params.tier === '12h'
      ? `chase12h:${params.interview_id}:${params.interviewer_user_id}:${params.attempt}`
      : `chase24h:${params.interview_id}:${params.interviewer_user_id}:${params.attempt}`;

  // Look up +12h Slack DM thread_ts when firing the +24h single-sentence follow-up
  let threadTs: string | undefined;
  if (params.tier === '24h') {
    const prior12hChainId = `wf6_chase12h:${params.interview_id}:${params.interviewer_user_id}:${params.attempt}`;
    const prior12hStep = executor.store.getChainStep(prior12hChainId, 'send_rsvp_chase_slack_dm');
    const priorTs = (prior12hStep?.output as Record<string, unknown> | null)?.ts ?? prior12hStep?.provider_id;
    if (typeof priorTs === 'string' && priorTs.trim()) {
      threadTs = priorTs;
    }
  }

  const text =
    params.tier === '12h'
      ? `Hi! Friendly reminder to please accept the calendar invite for ${params.candidate_name}'s ${params.interview_name} (${params.starts_at}) so we can send the candidate confirmation.`
      : `Following up on the calendar invite for ${params.candidate_name}'s ${params.interview_name} (${params.starts_at}) — please accept or let us know if we need to adjust the time.`;

  const res = await executor.executeChain({
    chain_id: `wf6_${actionKey}`,
    episode_id: params.episode_id,
    workflow: 'wf6_scheduling',
    exception,
    expected_state: {
      application_id: params.application_id,
      application_status: 'active',
      require_interviewer_rsvp_pending: {
        interview_id: params.interview_id,
        interviewer_user_id: params.interviewer_user_id,
      },
    },
    fresh_snapshot: params.fresh_snapshot,
    steps: [
      {
        step_index: 1,
        step_key: 'send_rsvp_chase_slack_dm',
        action_key: actionKey,
        service: 'slack',
        operation: 'send_message',
        exception,
        buildInput: () => ({
          channel: params.interviewer_slack_id,
          text,
          ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
        outboundBody: () => text,
        reconcile: async (_ctx, stepRow) => {
          if (stepRow.provider_id) {
            return {
              reconciled: true,
              provider_id: stepRow.provider_id,
              output: stepRow.output ?? { ts: stepRow.provider_id },
            };
          }
          return { reconciled: false };
        },
        execute: async (_ctx, input) => {
          const sent = await slack.sendMessage({
            channel: String(input.channel),
            text: String(input.text),
            ...(input.thread_ts ? { thread_ts: String(input.thread_ts) } : {}),
          });
          return {
            provider_id: sent.ts,
            output: { ts: sent.ts, channel: sent.channel },
          };
        },
      },
    ],
  });

  if (res.ok) {
    executor.store.updateTimerStatus(params.timer_key, 'fired', { now: executor.nowIso() });
  } else if (
    res.status === 'aborted_stale' &&
    res.reason?.includes('INTERVIEWER_RSVP_ALREADY_RESOLVED')
  ) {
    cancelStep7RsvpTimersForInterview(
      executor.store,
      params.interview_id,
      'interviewer_rsvp_already_resolved',
      executor.nowIso(),
    );
  }
  return res;
}

/**
 * Handles an interviewer calendar decline in Step 7:
 * Cancels pending RSVP timers and reads the interviewer's Slack DM + email (unfiltered by subject)
 * before proposing a rebook.
 */
export async function handleStep7InterviewerDecline(params: {
  store: SqliteCoordinatorStore;
  episode_id: string;
  interview_id: number | string;
  interviewer_user_id: number;
  interviewer_email: string;
  interviewer_slack_id: string;
  readInterviewerSlackDm: (slackId: string) => Promise<string[]>;
  readInterviewerEmailsUnfiltered: (fromEmail: string) => Promise<Array<{ subject: string; snippet: string }>>;
  now?: string;
}): Promise<{
  cancelledTimers: number;
  slackMessages: string[];
  unfilteredEmails: Array<{ subject: string; snippet: string }>;
}> {
  const now = params.now ?? new Date().toISOString();
  const cancelledTimers = cancelStep7RsvpTimersForInterview(
    params.store,
    params.interview_id,
    'interviewer_declined',
    now,
  );

  // Mandatory Step 7 decline rule: read interviewer's Slack DM + email (unfiltered by subject)
  const slackMessages = await params.readInterviewerSlackDm(params.interviewer_slack_id);
  const unfilteredEmails = await params.readInterviewerEmailsUnfiltered(params.interviewer_email);

  const existingEp = params.store.getEpisode(params.episode_id);
  if (existingEp) {
    params.store.upsertEpisode({
      episode_id: params.episode_id,
      workflow: existingEp.workflow,
      application_id: existingEp.application_id,
      candidate_id: existingEp.candidate_id,
      job_id: existingEp.job_id,
      stage_id: existingEp.stage_id,
      status: 'interviewer_declined_pending_rebook',
      state: {
        ...existingEp.state,
        decline_context: {
          checked_at: now,
          slack_messages: slackMessages,
          unfiltered_emails: unfilteredEmails,
        },
      },
      now,
    });
  }

  return {
    cancelledTimers,
    slackMessages,
    unfilteredEmails,
  };
}

// ============================================================================
// Step 8: Candidate Confirmation Email (4151798004) + EMAIL Note + Day-Before Reminder
// ============================================================================

export interface Step8ConfirmationChainParams {
  episode_id: string;
  application_id: number;
  candidate_id: number;
  candidate_first_name: string;
  candidate_name: string;
  candidate_email: string;
  candidate_tz?: string | null;
  job_id: number;
  job_title: string;
  stage_id: number;
  interview_id: number | string;
  interview_name: string;
  interviewer_user_id: number;
  interviewer_name: string;
  interviewer_email: string;
  interviewer_slack_id: string;
  interviewer_tz?: string | null;
  hold_event_id: string;
  meet_link: string;
  starts_at: string;
  ends_at: string;
  starts_at_formatted: string;
  duration_minutes: number;
  thread_id?: string;
  approval?: ApprovalRow | null;
  fresh_snapshot: FreshReadSnapshot;
}

export async function executeStep8ConfirmationChain(
  executor: DeterministicExecutor,
  params: Step8ConfirmationChainParams,
): Promise<ExecuteChainResult> {
  if (!executor.calendar || !executor.gmail) {
    throw new Error('CalendarProvider and GmailProvider are required for Step 8 confirmation chain.');
  }
  const calendar = executor.calendar;
  const gmail = executor.gmail;

  // Cancel any remaining Step 7 RSVP chases now that the interviewer accepted
  cancelStep7RsvpTimersForInterview(
    executor.store,
    params.interview_id,
    'interviewer_accepted',
    executor.nowIso(),
  );

  const rendered = renderConfirmationTemplate4151798004({
    candidate_first_name: params.candidate_first_name,
    job_title: params.job_title,
    interview_name: params.interview_name,
    interviewer_name: params.interviewer_name,
    starts_at_formatted: params.starts_at_formatted,
    duration_minutes: params.duration_minutes,
    meet_link: params.meet_link,
  });

  const chainId = `wf6_step8_confirm:${params.application_id}:${params.interview_id}`;

  const steps: ChainStepDefinition[] = [
    // Step 8.1: Create a SEPARATE candidate-only Google Calendar event sharing the Meet link (NEVER add the candidate to the interviewer hold event!)
    {
      step_index: 1,
      step_key: 'create_candidate_calendar_invite',
      action_key: `create_candidate_event:${params.interview_id}`,
      service: 'calendar',
      operation: 'create_candidate_event',
      exception: params.approval ? null : 'step8_standard_confirmation',
      buildInput: () => ({
        summary: 'Interview with Turing',
        description: `Join the Google Meet meeting: ${params.meet_link}`,
        start: params.starts_at,
        end: params.ends_at,
        attendees: [{ email: params.candidate_email, responseStatus: 'needsAction' }],
        googleMeetUrl: params.meet_link,
        visibility: 'private',
        sendUpdates: 'all',
      }),
      reconcile: async (_ctx, stepRow) => {
        if (stepRow.provider_id && calendar.getEvent) {
          const ev = await calendar.getEvent(stepRow.provider_id);
          if (ev && ev.status !== 'cancelled' && ev.event_id !== params.hold_event_id) {
            return {
              reconciled: true,
              provider_id: ev.event_id,
              output: { candidate_event_id: ev.event_id },
            };
          }
        }
        if (calendar.listEvents) {
          const listed = await calendar.listEvents({
            start: params.starts_at,
            end: params.ends_at,
          });
          const found = listed.find(
            ev =>
              ev.status !== 'cancelled' &&
              ev.event_id !== params.hold_event_id &&
              ev.summary === 'Interview with Turing' &&
              ev.attendees?.some(
                a => a.email.toLowerCase() === params.candidate_email.toLowerCase(),
              ),
          );
          if (found) {
            return {
              reconciled: true,
              provider_id: found.event_id,
              output: { candidate_event_id: found.event_id },
            };
          }
          return { reconciled: false, allowSafeRetry: true };
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        const attendees = input.attendees as Array<{ email: string; responseStatus?: string }>;
        if (
          attendees.some(
            a => a.email.toLowerCase() === params.interviewer_email.toLowerCase(),
          )
        ) {
          throw new Error(
            'Invariant violation: candidate calendar event must never include the interviewer.',
          );
        }
        if (calendar.createCandidateEvent) {
          const created = await calendar.createCandidateEvent({
            summary: String(input.summary),
            description: String(input.description),
            start: String(input.start),
            end: String(input.end),
            attendees,
            googleMeetUrl: String(input.googleMeetUrl),
            visibility: 'private',
            sendUpdates: 'all',
          });
          return {
            provider_id: created.event_id,
            output: { candidate_event_id: created.event_id },
          };
        }
        const hold = await calendar.createSilentHold({
          summary: String(input.summary),
          description: String(input.description),
          start: String(input.start),
          end: String(input.end),
        });
        const patched = await calendar.patchEvent({
          event_id: hold.event_id,
          attendees,
          sendUpdates: 'all',
        });
        return {
          provider_id: patched.event_id,
          output: { candidate_event_id: patched.event_id },
        };
      },
    },

    // Step 8.2: Send candidate confirmation email (template 4151798004 with Meet link) via Gmail
    {
      step_index: 2,
      step_key: 'send_candidate_confirmation_email',
      action_key: `send_confirmation:${params.application_id}:${params.interview_id}`,
      service: 'gmail',
      operation: 'send_message',
      exception: params.approval ? null : 'step8_confirmation_email',
      buildInput: () => ({
        to: params.candidate_email,
        from: SAM_EMAIL,
        subject: rendered.subject,
        htmlBody: rendered.htmlBody,
        threadId: params.thread_id,
      }),
      outboundBody: () => rendered.htmlBody,
      reconcile: async (_ctx, stepRow) => {
        if (stepRow.provider_id) {
          return {
            reconciled: true,
            provider_id: stepRow.provider_id,
            output: stepRow.output ?? { message_id: stepRow.provider_id },
          };
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        const sent = await gmail.sendMessage({
          to: String(input.to),
          from: String(input.from),
          subject: String(input.subject),
          htmlBody: String(input.htmlBody),
          threadId: input.threadId ? String(input.threadId) : undefined,
        });
        return {
          provider_id: sent.message_id,
          output: {
            message_id: sent.message_id,
            thread_id: sent.thread_id ?? null,
          },
        };
      },
    },

    // Step 8.3: Log EMAIL note in Greenhouse via candidate_note_create (POST /v3/notes)
    {
      step_index: 3,
      step_key: 'create_greenhouse_email_note',
      action_key: `candidate_note_create_email:${params.application_id}:${params.interview_id}`,
      service: 'greenhouse',
      operation: 'candidate_note_create',
      exception: params.approval ? null : 'step8_standard_confirmation',
      buildInput: () => ({
        application_id: params.application_id,
        body: rendered.htmlBody,
        visibility: 'admin_only',
        note_type: 'EMAIL',
        subject: rendered.subject,
        email_from: [SAM_EMAIL],
        email_to: [params.candidate_email],
        email_cc: [],
      }),
    },
  ];

  const result = await executor.executeChain({
    chain_id: chainId,
    episode_id: params.episode_id,
    workflow: 'wf6_scheduling',
    approval: params.approval ?? null,
    expected_state: {
      application_id: params.application_id,
      application_status: 'active',
      stage_id: params.stage_id,
      ignore_calendar_event_ids: [params.hold_event_id],
    },
    fresh_snapshot: params.fresh_snapshot,
    steps,
  });

  if (result.ok) {
    const existingEp = executor.store.getEpisode(params.episode_id);
    const candidateEventId =
      (result.step_results.create_candidate_calendar_invite?.output as Record<string, unknown> | null)
        ?.candidate_event_id ??
      result.step_results.create_candidate_calendar_invite?.provider_id ??
      null;
    executor.store.upsertEpisode({
      episode_id: params.episode_id,
      workflow: 'wf6_scheduling',
      application_id: params.application_id,
      candidate_id: params.candidate_id,
      job_id: params.job_id,
      stage_id: params.stage_id,
      status: 'confirmed',
      state: {
        ...(existingEp?.state ?? {}),
        interview_id: params.interview_id,
        hold_event_id: params.hold_event_id,
        candidate_event_id: candidateEventId,
        meet_link: params.meet_link,
        starts_at: params.starts_at,
        ends_at: params.ends_at,
        confirmed_at: executor.nowIso(),
      },
      now: executor.nowIso(),
    });

    // Schedule day-before reminder timer (24 hours before starts_at)
    const startsMs = Date.parse(params.starts_at);
    const dayBeforeFireAt = new Date(startsMs - 24 * 3600_000).toISOString();
    executor.store.scheduleTimer({
      timer_key: `reminder_day_before:${params.interview_id}`,
      episode_id: params.episode_id,
      kind: 'wf6_day_before_reminder',
      fire_at: dayBeforeFireAt,
      payload: {
        interview_id: params.interview_id,
        application_id: params.application_id,
        candidate_email: params.candidate_email,
        interviewer_slack_id: params.interviewer_slack_id,
        starts_at: params.starts_at,
        meet_link: params.meet_link,
      },
      now: executor.nowIso(),
    });

    // Also schedule Step 10 timers (1h pre-check and post-interview scorecard chases)
    scheduleStep10LiveAndScorecardTimers(executor.store, {
      episode_id: params.episode_id,
      interview_id: params.interview_id,
      application_id: params.application_id,
      interviewer_user_id: params.interviewer_user_id,
      interviewer_slack_id: params.interviewer_slack_id,
      interviewer_tz: params.interviewer_tz,
      candidate_name: params.candidate_name,
      interview_name: params.interview_name,
      starts_at: params.starts_at,
      ends_at: params.ends_at,
      now: executor.nowIso(),
    });
  }

  return result;
}

// ============================================================================
// Step 9: Reschedules (interview_update + GCal patch + attempt increment)
//         & True Cancellations (interview_delete + GCal delete + urgent notify)
// ============================================================================

export async function executeStep9RescheduleChain(
  executor: DeterministicExecutor,
  params: {
    episode_id: string;
    application_id: number;
    stage_id: number;
    interview_id: number;
    hold_event_id: string;
    candidate_event_id?: string | null;
    interviewer_user_id: number;
    interviewer_email: string;
    interviewer_slack_id: string;
    interviewer_tz?: string | null;
    candidate_name: string;
    interview_name: string;
    new_starts_at: string;
    new_ends_at: string;
    previous_attempt?: number;
    approval: ApprovalRow;
    fresh_snapshot: FreshReadSnapshot;
  },
): Promise<{ result: ExecuteChainResult; nextAttempt: number }> {
  if (!executor.calendar) {
    throw new Error('CalendarProvider is required for Step 9 reschedule chain.');
  }
  const calendar = executor.calendar;
  const nextAttempt = (params.previous_attempt ?? 1) + 1;
  const chainId = `wf6_step9_reschedule:${params.interview_id}:attempt_${nextAttempt}`;
  const existingEpisode = executor.store.getEpisode(params.episode_id);
  const candidateEventId =
    params.candidate_event_id ??
    (typeof existingEpisode?.state?.candidate_event_id === 'string'
      ? existingEpisode.state.candidate_event_id
      : null);

  const steps: ChainStepDefinition[] = [
    // Step 9.1: Update Greenhouse interview via interview_update (PATCH /v3/interviews/{id})
    {
      step_index: 1,
      step_key: 'update_greenhouse_interview',
      action_key: `interview_update:${params.interview_id}:${params.new_starts_at}`,
      service: 'greenhouse',
      operation: 'interview_update',
      buildInput: () => ({
        interview_id: params.interview_id,
        starts_at: params.new_starts_at,
        ends_at: params.new_ends_at,
        external_event_id: params.hold_event_id,
        interviewers: [
          {
            user_id: params.interviewer_user_id,
            response_status: 'needs_action',
          },
        ],
      }),
    },

    // Step 9.2: Patch interviewer Google Calendar event to new time (sendUpdates: "all")
    {
      step_index: 2,
      step_key: 'patch_calendar_reschedule',
      action_key: `patch_event_reschedule:${params.interview_id}:${params.new_starts_at}`,
      service: 'calendar',
      operation: 'patch_event',
      buildInput: () => ({
        event_id: params.hold_event_id,
        start: params.new_starts_at,
        end: params.new_ends_at,
        sendUpdates: 'all',
      }),
      reconcile: async (_ctx, stepRow) => {
        const evId = String((stepRow.input as Record<string, unknown>)?.event_id ?? '');
        if (evId && calendar.getEvent) {
          const ev = await calendar.getEvent(evId);
          if (ev && ev.start === params.new_starts_at && ev.end === params.new_ends_at) {
            return {
              reconciled: true,
              provider_id: evId,
              output: {
                event_id: evId,
                start: params.new_starts_at,
                end: params.new_ends_at,
              },
            };
          }
          if (ev) {
            return { reconciled: false, allowSafeRetry: true };
          }
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        const patched = await calendar.patchEvent({
          event_id: String(input.event_id),
          start: String(input.start),
          end: String(input.end),
          sendUpdates: 'all',
        });
        return {
          provider_id: patched.event_id,
          output: {
            event_id: patched.event_id,
            start: params.new_starts_at,
            end: params.new_ends_at,
          },
        };
      },
    },
  ];

  if (candidateEventId && candidateEventId !== params.hold_event_id) {
    steps.push({
      step_index: 3,
      step_key: 'patch_candidate_calendar_reschedule',
      action_key: `patch_candidate_event_reschedule:${params.interview_id}:${params.new_starts_at}`,
      service: 'calendar',
      operation: 'patch_event',
      buildInput: () => ({
        event_id: candidateEventId,
        start: params.new_starts_at,
        end: params.new_ends_at,
        sendUpdates: 'all',
      }),
      reconcile: async (_ctx, stepRow) => {
        const evId = String((stepRow.input as Record<string, unknown>)?.event_id ?? '');
        if (evId && calendar.getEvent) {
          const ev = await calendar.getEvent(evId);
          if (ev && ev.start === params.new_starts_at && ev.end === params.new_ends_at) {
            return {
              reconciled: true,
              provider_id: evId,
              output: {
                event_id: evId,
                start: params.new_starts_at,
                end: params.new_ends_at,
              },
            };
          }
          if (ev) {
            return { reconciled: false, allowSafeRetry: true };
          }
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        const patched = await calendar.patchEvent({
          event_id: String(input.event_id),
          start: String(input.start),
          end: String(input.end),
          sendUpdates: 'all',
        });
        return {
          provider_id: patched.event_id,
          output: {
            event_id: patched.event_id,
            start: params.new_starts_at,
            end: params.new_ends_at,
          },
        };
      },
    });
  }

  const result = await executor.executeChain({
    chain_id: chainId,
    episode_id: params.episode_id,
    workflow: 'wf6_scheduling',
    approval: params.approval,
    expected_state: {
      application_id: params.application_id,
      application_status: 'active',
      stage_id: params.stage_id,
      ignore_calendar_event_ids: candidateEventId
        ? [params.hold_event_id, candidateEventId]
        : [params.hold_event_id],
    },
    fresh_snapshot: params.fresh_snapshot,
    steps,
  });

  if (result.ok) {
    // Cancel previous RSVP chases AND any post-confirmation Step 8/10 timers from the prior slot
    cancelStep7RsvpTimersForInterview(
      executor.store,
      params.interview_id,
      'interview_rescheduled',
      executor.nowIso(),
    );
    cancelPostConfirmationTimersForInterview(
      executor.store,
      params.interview_id,
      'interview_rescheduled',
      executor.nowIso(),
    );

    const existingEp = executor.store.getEpisode(params.episode_id);
    executor.store.upsertEpisode({
      episode_id: params.episode_id,
      workflow: 'wf6_scheduling',
      application_id: params.application_id,
      stage_id: params.stage_id,
      status: 'awaiting_interviewer_rsvp',
      state: {
        ...(existingEp?.state ?? {}),
        interview_id: params.interview_id,
        hold_event_id: params.hold_event_id,
        starts_at: params.new_starts_at,
        ends_at: params.new_ends_at,
        rsvp_attempt: nextAttempt,
      },
      now: executor.nowIso(),
    });

    scheduleStep7RsvpChases(executor.store, {
      episode_id: params.episode_id,
      interview_id: params.interview_id,
      application_id: params.application_id,
      interviewer_user_id: params.interviewer_user_id,
      interviewer_slack_id: params.interviewer_slack_id,
      interviewer_tz: params.interviewer_tz,
      candidate_name: params.candidate_name,
      interview_name: params.interview_name,
      starts_at: params.new_starts_at,
      booked_at: executor.nowIso(),
      attempt: nextAttempt,
    });
  }

  return { result, nextAttempt };
}

export async function executeStep9CancellationChain(
  executor: DeterministicExecutor,
  params: {
    episode_id: string;
    application_id: number;
    stage_id: number;
    interview_id: number;
    hold_event_id: string;
    candidate_event_id?: string | null;
    candidate_name: string;
    candidate_email: string;
    interview_name: string;
    urgent_interviewer_cancel?: boolean;
    approval?: ApprovalRow | null;
    fresh_snapshot: FreshReadSnapshot;
  },
): Promise<ExecuteChainResult> {
  if (!executor.calendar) {
    throw new Error('CalendarProvider is required for Step 9 cancellation chain.');
  }
  const calendar = executor.calendar;
  const gmail = executor.gmail;
  const chainId = `wf6_step9_cancel:${params.interview_id}`;
  const exception = params.urgent_interviewer_cancel ? 'urgent_cancel_rebook' : null;
  const urgentHtmlBody = `<p>Hi ${params.candidate_name},</p><p>Our interviewer had an urgent conflict come up for your ${params.interview_name}. Could you share a few updated times that work for you to reschedule?</p><p>Best,<br/>Sam Vangelos</p>`;
  const existingEpisode = executor.store.getEpisode(params.episode_id);
  const candidateEventId =
    params.candidate_event_id ??
    (typeof existingEpisode?.state?.candidate_event_id === 'string'
      ? existingEpisode.state.candidate_event_id
      : null);

  const steps: ChainStepDefinition[] = [
    // Step 9.1: Delete Greenhouse interview via interview_delete (DELETE /v3/interviews/{id})
    {
      step_index: 1,
      step_key: 'delete_greenhouse_interview',
      action_key: `interview_delete:${params.interview_id}`,
      service: 'greenhouse',
      operation: 'interview_delete',
      exception,
      buildInput: () => ({
        interview_id: params.interview_id,
      }),
    },

    // Step 9.2: Cancel/Delete interviewer Google Calendar event
    {
      step_index: 2,
      step_key: 'delete_calendar_event',
      action_key: `delete_event:${params.hold_event_id}`,
      service: 'calendar',
      operation: 'delete_event',
      exception,
      buildInput: () => ({
        event_id: params.hold_event_id,
        sendUpdates: 'all',
      }),
      reconcile: async (_ctx, stepRow) => {
        const evId = String((stepRow.input as Record<string, unknown>)?.event_id ?? '');
        if (evId && calendar.getEvent) {
          const ev = await calendar.getEvent(evId);
          if (!ev || ev.status === 'cancelled') {
            return {
              reconciled: true,
              provider_id: evId,
              output: { deleted: true },
            };
          }
          return { reconciled: false, allowSafeRetry: true };
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        await calendar.deleteEvent({
          event_id: String(input.event_id),
          sendUpdates: 'all',
        });
        return {
          provider_id: String(input.event_id),
          output: { deleted: true },
        };
      },
    },
  ];

  if (candidateEventId && candidateEventId !== params.hold_event_id) {
    steps.push({
      step_index: steps.length + 1,
      step_key: 'delete_candidate_calendar_event',
      action_key: `delete_candidate_event:${candidateEventId}`,
      service: 'calendar',
      operation: 'delete_event',
      exception,
      buildInput: () => ({
        event_id: candidateEventId,
        sendUpdates: 'all',
      }),
      reconcile: async (_ctx, stepRow) => {
        const evId = String((stepRow.input as Record<string, unknown>)?.event_id ?? '');
        if (evId && calendar.getEvent) {
          const ev = await calendar.getEvent(evId);
          if (!ev || ev.status === 'cancelled') {
            return {
              reconciled: true,
              provider_id: evId,
              output: { deleted: true },
            };
          }
          return { reconciled: false, allowSafeRetry: true };
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        await calendar.deleteEvent({
          event_id: String(input.event_id),
          sendUpdates: 'all',
        });
        return {
          provider_id: String(input.event_id),
          output: { deleted: true },
        };
      },
    });
  }

  if (params.urgent_interviewer_cancel && gmail) {
    steps.push({
      step_index: steps.length + 1,
      step_key: 'send_urgent_cancel_candidate_email',
      action_key: `urgent_cancel_notify:${params.interview_id}`,
      service: 'gmail',
      operation: 'send_message',
      exception: 'urgent_cancel_rebook',
      buildInput: () => ({
        to: params.candidate_email,
        from: SAM_EMAIL,
        subject: `Urgent Update: Rescheduling your ${params.interview_name}`,
        htmlBody: urgentHtmlBody,
      }),
      outboundBody: () => urgentHtmlBody,
      reconcile: async (_ctx, stepRow) => {
        if (stepRow.provider_id) {
          return {
            reconciled: true,
            provider_id: stepRow.provider_id,
            output: stepRow.output ?? { message_id: stepRow.provider_id },
          };
        }
        return { reconciled: false };
      },
      execute: async (_ctx, input) => {
        const sent = await gmail.sendMessage({
          to: String(input.to),
          from: String(input.from),
          subject: String(input.subject),
          htmlBody: String(input.htmlBody),
        });
        return {
          provider_id: sent.message_id,
          output: { message_id: sent.message_id },
        };
      },
    });
  }

  const result = await executor.executeChain({
    chain_id: chainId,
    episode_id: params.episode_id,
    workflow: 'wf6_scheduling',
    approval: params.approval ?? null,
    exception,
    expected_state: {
      application_id: params.application_id,
      application_status: 'active',
      stage_id: params.stage_id,
      ignore_calendar_event_ids: [params.hold_event_id],
    },
    fresh_snapshot: params.fresh_snapshot,
    steps,
  });

  if (result.ok) {
    cancelStep7RsvpTimersForInterview(
      executor.store,
      params.interview_id,
      'interview_cancelled',
      executor.nowIso(),
    );
    cancelPostConfirmationTimersForInterview(
      executor.store,
      params.interview_id,
      'interview_cancelled',
      executor.nowIso(),
    );

    const existingEp = executor.store.getEpisode(params.episode_id);
    executor.store.upsertEpisode({
      episode_id: params.episode_id,
      workflow: 'wf6_scheduling',
      application_id: params.application_id,
      stage_id: params.stage_id,
      status: 'cancelled',
      state: {
        ...(existingEp?.state ?? {}),
        interview_id: params.interview_id,
        cancelled_at: executor.nowIso(),
      },
      now: executor.nowIso(),
    });
  }

  return result;
}

// ============================================================================
// Step 10: Live Day-Of Pre-Check & Post-Interview Scorecard Chasing (+2h & +24h Ruling 4)
// ============================================================================

export function scheduleStep10LiveAndScorecardTimers(
  store: SqliteCoordinatorStore,
  params: {
    episode_id: string;
    interview_id: number | string;
    application_id: number;
    interviewer_user_id: number;
    interviewer_slack_id: string;
    interviewer_tz?: string | null;
    candidate_name: string;
    interview_name: string;
    starts_at: string;
    ends_at: string;
    attempt?: number;
    now?: string;
  },
): {
  preCheckKey: string;
  scorecard2hKey: string;
  scorecard24hKey: string;
} {
  const attempt = params.attempt ?? 1;
  const now = params.now ?? new Date().toISOString();
  const tz = resolveTimezone(params.interviewer_tz);
  const startsMs = Date.parse(params.starts_at);
  const preCheckFireAt = new Date(startsMs - 3600_000).toISOString();
  const fire2h = addWorkingHours(params.ends_at, 2, tz);
  const fire24h = addWorkingHours(params.ends_at, 24, tz);

  const preCheckKey = `pre_interview_check:${params.interview_id}`;
  const scorecard2hKey = `scorecard_reminder_2h:${params.interview_id}:${params.interviewer_user_id}`;
  const scorecard24hKey = `scorecard_chase_24h:${params.interview_id}:${params.interviewer_user_id}:${attempt}`;

  const payload = {
    interview_id: params.interview_id,
    application_id: params.application_id,
    interviewer_user_id: params.interviewer_user_id,
    interviewer_slack_id: params.interviewer_slack_id,
    interviewer_tz: tz,
    candidate_name: params.candidate_name,
    interview_name: params.interview_name,
    starts_at: params.starts_at,
    ends_at: params.ends_at,
    attempt,
  };

  store.scheduleTimer({
    timer_key: preCheckKey,
    episode_id: params.episode_id,
    kind: 'wf6_pre_interview_check_1h',
    fire_at: preCheckFireAt,
    payload,
    now,
  });

  store.scheduleTimer({
    timer_key: scorecard2hKey,
    episode_id: params.episode_id,
    kind: 'wf6_scorecard_reminder_2h',
    fire_at: fire2h,
    payload,
    now,
  });

  store.scheduleTimer({
    timer_key: scorecard24hKey,
    episode_id: params.episode_id,
    kind: 'wf6_scorecard_chase_24h',
    fire_at: fire24h,
    attempt,
    payload,
    now,
  });

  return { preCheckKey, scorecard2hKey, scorecard24hKey };
}

/**
 * Auto-cancels pending Step 10 scorecard reminder/chase timers as soon as the interviewer's
 * scorecard reaches `status === "complete"`.
 */
export function reconcileStep10ScorecardCompletion(
  store: SqliteCoordinatorStore,
  params: {
    interview_id: number | string;
    interviewer_user_id: number;
    scorecards: Array<{
      id: number;
      status: string;
      interviewer?: { id?: number } | null;
      submitted_by?: { id?: number } | null;
    }>;
    now?: string;
  },
): { completed: boolean; cancelledTimers: number } {
  const isCompleted = params.scorecards.some(sc => {
    const uid = sc.interviewer?.id ?? sc.submitted_by?.id;
    return uid === params.interviewer_user_id && sc.status === 'complete';
  });

  if (!isCompleted) {
    return { completed: false, cancelledTimers: 0 };
  }

  const now = params.now ?? new Date().toISOString();
  let cancelledTimers = 0;
  cancelledTimers += store.cancelTimersByPrefix(
    `scorecard_reminder_2h:${params.interview_id}:${params.interviewer_user_id}`,
    'scorecard_completed',
    now,
  );
  cancelledTimers += store.cancelTimersByPrefix(
    `scorecard_chase_24h:${params.interview_id}:${params.interviewer_user_id}:`,
    'scorecard_completed',
    now,
  );

  return { completed: true, cancelledTimers };
}

/**
 * Fires the Ruling 4 autonomous +24 working-hour Slack DM scorecard chase if and only if
 * a fresh pre-dispatch read confirms the scorecard is still incomplete.
 */
export async function fireStep10ScorecardChase24h(
  executor: DeterministicExecutor,
  params: {
    timer_key: string;
    episode_id: string;
    interview_id: number | string;
    application_id: number;
    interviewer_user_id: number;
    interviewer_slack_id: string;
    candidate_name: string;
    interview_name: string;
    attempt?: number;
    fresh_snapshot: FreshReadSnapshot;
  },
): Promise<ExecuteChainResult> {
  if (!executor.slack) {
    throw new Error('SlackProvider is required for Step 10 scorecard chase.');
  }
  const slack = executor.slack;
  const attempt = params.attempt ?? 1;

  // Check if scorecard was already completed in the fresh snapshot
  const completionCheck = reconcileStep10ScorecardCompletion(executor.store, {
    interview_id: params.interview_id,
    interviewer_user_id: params.interviewer_user_id,
    scorecards: params.fresh_snapshot.scorecards ?? [],
    now: executor.nowIso(),
  });

  if (completionCheck.completed) {
    return {
      ok: false,
      chain_id: `wf6_scorecard_chase_24h:${params.interview_id}:${params.interviewer_user_id}:${attempt}`,
      status: 'aborted_stale',
      reason: 'SCORECARD_ALREADY_COMPLETED: Scorecard is already complete; timer auto-cancelled.',
      step_results: {},
    };
  }

  const actionKey = `scorecard_chase_24h:${params.interview_id}:${params.interviewer_user_id}:${attempt}`;
  const text = `Hi! Friendly +24h reminder to please submit your Greenhouse scorecard for ${params.candidate_name} (${params.interview_name}) so we can keep the candidate moving.`;

  const res = await executor.executeChain({
    chain_id: `wf6_${actionKey}`,
    episode_id: params.episode_id,
    workflow: 'wf6_scheduling',
    exception: '24h_scorecard_chase',
    expected_state: {
      application_id: params.application_id,
      application_status: 'active',
      require_scorecard_incomplete_for_user_id: params.interviewer_user_id,
    },
    fresh_snapshot: params.fresh_snapshot,
    steps: [
      {
        step_index: 1,
        step_key: 'send_24h_scorecard_chase_slack_dm',
        action_key: actionKey,
        service: 'slack',
        operation: 'send_message',
        exception: '24h_scorecard_chase',
        buildInput: () => ({
          channel: params.interviewer_slack_id,
          text,
        }),
        outboundBody: () => text,
        reconcile: async (_ctx, stepRow) => {
          if (stepRow.provider_id) {
            return {
              reconciled: true,
              provider_id: stepRow.provider_id,
              output: stepRow.output ?? { ts: stepRow.provider_id },
            };
          }
          return { reconciled: false };
        },
        execute: async (_ctx, input) => {
          const sent = await slack.sendMessage({
            channel: String(input.channel),
            text: String(input.text),
          });
          return {
            provider_id: sent.ts,
            output: { ts: sent.ts, channel: sent.channel },
          };
        },
      },
    ],
  });

  if (res.ok) {
    executor.store.updateTimerStatus(params.timer_key, 'fired', { now: executor.nowIso() });
  }
  return res;
}
