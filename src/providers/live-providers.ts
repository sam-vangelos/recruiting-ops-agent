import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { decide as evaluateSendGateHook } from '../../.claude/hooks/send-gate.mjs';
import {
  type ActionApplyResponse,
  type ActionPreviewResponse,
  type ActionServiceLike,
  type CalendarHoldEvent,
  type CalendarProvider,
  type ExpectedFreshState,
  type FreshReadSnapshot,
  type GmailProvider,
  type GreenhouseActorContext,
  type LiveScorecardSummary,
  type SendGateCheckInput,
  type SlackProvider,
  verifyInProcessSendGate,
} from '../executor/index.ts';
import type { SqliteCoordinatorStore } from '../store/sqlite.ts';

const execFileAsync = promisify(execFile);

export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000;

export class FreshReadError extends Error {
  readonly code: string;
  readonly source: 'greenhouse' | 'gmail' | 'calendar' | 'slack' | 'coordinator';
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code?: string;
      source: 'greenhouse' | 'gmail' | 'calendar' | 'slack' | 'coordinator';
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'FreshReadError';
    this.code = options.code ?? 'FRESH_READ_FAILED';
    this.source = options.source;
    this.cause = options.cause;
  }
}

export class ProviderTimeoutError extends Error {
  readonly code = 'PROVIDER_TIMEOUT';
  readonly service: string;
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(service: string, operation: string, timeoutMs: number) {
    super(
      `Provider call ${service}.${operation} timed out after ${timeoutMs}ms.`,
    );
    this.name = 'ProviderTimeoutError';
    this.service = service;
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

export class ProviderTransportError extends Error {
  readonly code: string;
  readonly service: string;
  readonly operation: string;
  readonly statusCode?: number;
  readonly cause?: unknown;

  constructor(
    message: string,
    options: {
      code?: string;
      service: string;
      operation: string;
      statusCode?: number;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ProviderTransportError';
    this.code = options.code ?? 'PROVIDER_TRANSPORT_ERROR';
    this.service = options.service;
    this.operation = options.operation;
    this.statusCode = options.statusCode;
    this.cause = options.cause;
  }
}

export class SendGateBlockedError extends Error {
  readonly code = 'SEND_GATE_BLOCKED';
  readonly service: string;
  readonly operation: string;

  constructor(service: string, operation: string, reason: string) {
    super(`Send gate blocked ${service}.${operation}: ${reason}`);
    this.name = 'SendGateBlockedError';
    this.service = service;
    this.operation = operation;
  }
}

export interface DryRunCallRecord {
  timestamp: string;
  service: 'greenhouse' | 'calendar' | 'gmail' | 'slack';
  operation: string;
  input: Record<string, unknown>;
  synthetic_provider_id: string;
}

export type ProviderTransportConfig =
  | {
      type: 'adapter';
      invoke: (
        operation: string,
        payload: Record<string, unknown>,
      ) => Promise<unknown> | unknown;
    }
  | {
      type: 'http';
      baseUrl: string;
      headers?: Record<string, string>;
      fetchFn?: typeof fetch;
    }
  | {
      type: 'cli';
      command: string;
      args?: string[];
      env?: NodeJS.ProcessEnv;
      cwd?: string;
    };

export async function withTimeout<T>(
  promiseFactory: () => Promise<T> | T,
  timeoutMs: number,
  service: string,
  operation: string,
): Promise<T> {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_PROVIDER_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProviderTimeoutError(service, operation, effectiveTimeout));
    }, effectiveTimeout);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(promiseFactory),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function invokeTransport<T = any>(
  transport: ProviderTransportConfig,
  service: string,
  operation: string,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  return await withTimeout(
    async () => {
      if (transport.type === 'adapter') {
        return (await transport.invoke(operation, payload)) as T;
      }

      if (transport.type === 'http') {
        const fetchImpl = transport.fetchFn ?? globalThis.fetch;
        if (typeof fetchImpl !== 'function') {
          throw new ProviderTransportError(
            `No fetch implementation available for ${service}.${operation}`,
            { service, operation, code: 'FETCH_UNAVAILABLE' },
          );
        }
        const url = `${transport.baseUrl.replace(/\/+$/, '')}/${encodeURIComponent(service)}/${encodeURIComponent(operation)}`;
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(transport.headers ?? {}),
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const errBody = await response.text().catch(() => '');
          throw new ProviderTransportError(
            `HTTP ${response.status} from ${service}.${operation}: ${errBody.slice(0, 300)}`,
            {
              service,
              operation,
              statusCode: response.status,
              code: `HTTP_${response.status}`,
            },
          );
        }
        return (await response.json()) as T;
      }

      if (transport.type === 'cli') {
        const args = [
          ...(transport.args ?? []),
          service,
          operation,
          JSON.stringify(payload),
        ];
        try {
          const { stdout } = await execFileAsync(transport.command, args, {
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            env: transport.env ?? process.env,
            cwd: transport.cwd,
          });
          const trimmed = String(stdout ?? '').trim();
          if (!trimmed) {
            throw new ProviderTransportError(
              `Empty stdout from CLI bridge for ${service}.${operation}`,
              { service, operation, code: 'CLI_EMPTY_OUTPUT' },
            );
          }
          return JSON.parse(trimmed) as T;
        } catch (err: any) {
          if (err instanceof ProviderTransportError) throw err;
          if (err?.killed || err?.signal === 'SIGTERM' || err?.code === 'ETIMEDOUT') {
            throw new ProviderTimeoutError(service, operation, timeoutMs);
          }
          throw new ProviderTransportError(
            `CLI bridge failed for ${service}.${operation}: ${err?.message ?? String(err)}`,
            { service, operation, code: 'CLI_EXEC_ERROR', cause: err },
          );
        }
      }

      throw new ProviderTransportError(
        `Unsupported transport type for ${service}.${operation}`,
        { service, operation, code: 'UNSUPPORTED_TRANSPORT' },
      );
    },
    timeoutMs,
    service,
    operation,
  );
}

/**
 * Enforces both `DeterministicExecutor.verifyInProcessSendGate` and `.claude/hooks/send-gate.mjs`
 * when a provider is configured with a `gateContext` or `enforceHookGate`.
 */
export function enforceProviderSendGate(
  service: 'calendar' | 'gmail' | 'slack',
  operation: string,
  toolInput: Record<string, unknown>,
  options: {
    gateContext?: SendGateCheckInput | (() => SendGateCheckInput | null | undefined);
    enforceHookGate?: boolean;
    hookToolName?: string;
    transcriptPath?: string;
    sessionId?: string;
  } = {},
): void {
  const ctx =
    typeof options.gateContext === 'function'
      ? options.gateContext()
      : options.gateContext;

  if (ctx) {
    const check = verifyInProcessSendGate(ctx);
    if (!check.allowed) {
      throw new SendGateBlockedError(
        service,
        operation,
        check.reason ?? 'Blocked by in-process send gate.',
      );
    }
  }

  if (options.enforceHookGate) {
    const defaultToolName =
      service === 'gmail'
        ? 'mcp__gmail__send_message'
        : service === 'slack'
          ? 'mcp__slack__slack_send_message'
          : operation === 'delete_event'
            ? 'mcp__google_calendar__delete_event'
            : operation === 'patch_event'
              ? 'mcp__google_calendar__update_event'
              : 'mcp__google_calendar__create_event';
    const hookDecision = evaluateSendGateHook({
      tool_name: options.hookToolName ?? defaultToolName,
      tool_input: toolInput,
      transcript_path: options.transcriptPath,
      session_id: options.sessionId,
    });
    const perm = hookDecision?.hookSpecificOutput?.permissionDecision;
    if (perm === 'deny') {
      throw new SendGateBlockedError(
        service,
        operation,
        hookDecision?.hookSpecificOutput?.permissionDecisionReason ??
          'Denied by send-gate hook.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Live Read-Plane Adapters & FreshReadFetcher
// ---------------------------------------------------------------------------

export interface GreenhouseReadAdapter {
  getApplication(
    applicationId: number,
  ): Promise<FreshReadSnapshot['application'] | null | undefined>;
  listScorecards?(
    applicationId: number,
  ): Promise<LiveScorecardSummary[] | null | undefined>;
  listInterviews?(
    applicationId: number,
  ): Promise<FreshReadSnapshot['interviews'] | null | undefined>;
}

export interface GmailReadAdapter {
  getThreadState(input: {
    episode_id: string;
    thread_id?: string;
    expected_last_message_id?: string;
  }): Promise<FreshReadSnapshot['gmail'] | null | undefined>;
}

export interface CalendarBusyInterval {
  start: string;
  end: string;
  event_id?: string;
  summary?: string;
}

export interface CalendarReadAdapter {
  getBusyIntervals(input: {
    episode_id: string;
    start?: string;
    end?: string;
    calendar_id?: string;
    check?: ExpectedFreshState['calendar_Check'];
  }): Promise<
    | {
        busy_intervals?: CalendarBusyInterval[];
        conflicting_event_ids?: string[];
      }
    | CalendarBusyInterval[]
    | null
    | undefined
  >;
}

export interface SlackReadAdapter {
  getMessageState(input: {
    episode_id: string;
    channel_id?: string;
    message_ts?: string;
    require_no_reaction_removal?: boolean;
    require_no_hm_override?: boolean;
  }): Promise<
    | {
        reaction_removed?: boolean;
        hm_override_detected?: boolean;
        has_hm_override?: boolean;
        override_ruling?: 'Advance' | 'Reject' | 'Hold' | null;
        interviewer_declined_reason?: string | null;
      }
    | null
    | undefined
  >;
}

/**
 * Creates a Greenhouse v3 HTTP read adapter when `baseUrl` and `accessToken` are supplied.
 */
export function createGreenhouseV3HttpReadAdapter(options: {
  baseUrl?: string;
  accessToken: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): GreenhouseReadAdapter {
  const baseUrl = (options.baseUrl ?? 'https://harvest.greenhouse.io').replace(
    /\/+$/,
    '',
  );
  const fetchImpl = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  async function ghGetResponse(urlOrPath: string, op: string): Promise<{ data: any; linkHeader: string | null }> {
    const fullUrl = /^https?:\/\//i.test(urlOrPath)
      ? urlOrPath
      : `${baseUrl}${urlOrPath}`;
    return await withTimeout(
      async () => {
        const res = await fetchImpl(fullUrl, {
          method: 'GET',
          headers: {
            authorization: `Bearer ${options.accessToken}`,
            accept: 'application/json',
          },
        });
        if (!res.ok) {
          throw new ProviderTransportError(
            `Greenhouse v3 GET ${urlOrPath} failed with HTTP ${res.status}`,
            {
              service: 'greenhouse_read',
              operation: op,
              statusCode: res.status,
              code: `GH_HTTP_${res.status}`,
            },
          );
        }
        const linkHeader = res.headers?.get?.('link') ?? null;
        const data = await res.json();
        return { data, linkHeader };
      },
      timeoutMs,
      'greenhouse_read',
      op,
    );
  }

  async function ghGet<T>(urlPath: string, op: string): Promise<T> {
    const { data } = await ghGetResponse(urlPath, op);
    return data as T;
  }

  async function ghGetPaginatedList<T>(
    initialUrlPath: string,
    op: string,
    maxPages = 20,
  ): Promise<T[] | null> {
    const accumulated: T[] = [];
    let currentUrl: string | null = initialUrlPath;
    let pageCount = 0;

    while (currentUrl) {
      if (pageCount >= maxPages) {
        throw new ProviderTransportError(
          `Greenhouse v3 pagination exceeded maxPages (${maxPages}) on ${op}; refusing truncated read.`,
          {
            service: 'greenhouse_read',
            operation: op,
            code: 'GH_PAGINATION_OVERFLOW',
          },
        );
      }
      pageCount++;
      const { data, linkHeader } = await ghGetResponse(currentUrl, op);
      const rows = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : null;
      if (!rows) {
        return pageCount === 1 ? null : accumulated;
      }
      accumulated.push(...rows);

      let nextUrl: string | null = null;
      if (linkHeader) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel=["']?next["']?/i);
        if (match?.[1]) {
          nextUrl = match[1];
        }
      }
      if (!nextUrl && data && typeof data === 'object' && !Array.isArray(data)) {
        const nextCursor =
          data.next_cursor ?? data.pagination?.next_cursor ?? null;
        if (typeof nextCursor === 'string' && nextCursor.trim()) {
          const baseQueryUrl = initialUrlPath.replace(/[?&]cursor=[^&]*/g, '');
          const sep = baseQueryUrl.includes('?') ? '&' : '?';
          nextUrl = `${baseQueryUrl}${sep}cursor=${encodeURIComponent(nextCursor)}`;
        } else if (data.has_more === true || data.pagination?.has_more === true) {
          throw new ProviderTransportError(
            `Greenhouse v3 ${op} reported has_more=true without next cursor or Link header; refusing truncated read.`,
            {
              service: 'greenhouse_read',
              operation: op,
              code: 'GH_PAGINATION_MISSING_CURSOR',
            },
          );
        }
      }
      currentUrl = nextUrl;
    }

    return accumulated;
  }

  return {
    async getApplication(applicationId: number) {
      const data = await ghGet<Record<string, any>>(
        `/v3/applications/${encodeURIComponent(String(applicationId))}`,
        'get_application',
      );
      if (!data || typeof data.id !== 'number') return null;
      return {
        id: data.id,
        candidate_id: data.candidate_id,
        job_id: Array.isArray(data.jobs) && data.jobs[0]?.id ? data.jobs[0].id : data.job_id,
        status: String(data.status ?? 'active'),
        current_stage_id:
          data.current_stage?.id ??
          (typeof data.current_stage_id === 'number' ? data.current_stage_id : null),
        prospective: Boolean(data.prospective),
      };
    },
    async listScorecards(applicationId: number) {
      return await ghGetPaginatedList<LiveScorecardSummary>(
        `/v3/scorecards?application_id=${encodeURIComponent(String(applicationId))}`,
        'list_scorecards',
      );
    },
    async listInterviews(applicationId: number) {
      return await ghGetPaginatedList<any>(
        `/v3/scheduled_interviews?application_id=${encodeURIComponent(String(applicationId))}`,
        'list_interviews',
      );
    },
  };
}

export interface LiveFreshReadFetcherConfig {
  store?: SqliteCoordinatorStore;
  greenhouse?: GreenhouseReadAdapter;
  gmail?: GmailReadAdapter;
  calendar?: CalendarReadAdapter;
  slack?: SlackReadAdapter;
  now?: () => Date;
  timeoutMs?: number;
}

/**
 * Builds a live `FreshReadFetcher` (`(episodeId, expected) => Promise<FreshReadSnapshot>`)
 * that queries Greenhouse v3 / `recruiter-mcp`, Gmail, Google Calendar, and Slack as demanded
 * by `expected`, and **fails closed** (throws `FreshReadError`) if any required read cannot be fetched.
 */
export function createLiveFreshReadFetcher(
  config: LiveFreshReadFetcherConfig,
): (episodeId: string, expected: ExpectedFreshState) => Promise<FreshReadSnapshot> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const nowFn = config.now ?? (() => new Date());

  return async (
    episodeId: string,
    expected: ExpectedFreshState = {},
  ): Promise<FreshReadSnapshot> => {
    const episode = config.store?.getEpisode(episodeId) ?? null;
    const epState = (episode?.state ?? {}) as Record<string, any>;

    const applicationId =
      expected.application_id ??
      episode?.application_id ??
      (typeof epState.application_id === 'number' ? epState.application_id : undefined);

    const needsScorecards =
      expected.negative_scorecard_id !== undefined ||
      expected.require_no_positive_scorecard === true ||
      expected.require_scorecard_incomplete_for_user_id !== undefined;

    const needsInterviews = expected.require_interviewer_rsvp_pending !== undefined;

    const needsApplication =
      expected.application_id !== undefined ||
      expected.application_status !== undefined ||
      expected.stage_id !== undefined ||
      needsScorecards ||
      needsInterviews;

    const needsGmail =
      expected.gmail_last_message_id !== undefined ||
      expected.require_no_unsent_sam_draft === true ||
      expected.require_no_candidate_withdrawal === true ||
      expected.gmail_thread_id !== undefined;

    const calendarCheckSpec = expected.calendar_Check ?? expected.calendar_check;
    const needsCalendar = Boolean(calendarCheckSpec);

    const needsSlack =
      expected.require_no_reaction_removal === true ||
      expected.require_no_hm_override === true ||
      expected.slack_channel_id !== undefined ||
      expected.slack_message_ts !== undefined;

    const snapshot: FreshReadSnapshot = {
      fetched_at: nowFn().toISOString(),
    };

    // 1. Greenhouse Read Plane (application, scorecards, interviews)
    if (needsApplication) {
      if (typeof applicationId !== 'number' || !Number.isFinite(applicationId)) {
        throw new FreshReadError(
          `Cannot fetch Greenhouse state for episode '${episodeId}': missing application_id.`,
          { code: 'MISSING_APPLICATION_ID', source: 'greenhouse' },
        );
      }
      if (!config.greenhouse || typeof config.greenhouse.getApplication !== 'function') {
        throw new FreshReadError(
          `Greenhouse read adapter is not configured for episode '${episodeId}' (application_id=${applicationId}).`,
          { code: 'GREENHOUSE_READ_UNCONFIGURED', source: 'greenhouse' },
        );
      }

      try {
        const app = await withTimeout(
          () => config.greenhouse!.getApplication(applicationId),
          timeoutMs,
          'greenhouse_read',
          'getApplication',
        );
        if (!app || typeof app.id !== 'number') {
          throw new FreshReadError(
            `Greenhouse application ${applicationId} could not be fetched (returned empty/null).`,
            { code: 'GREENHOUSE_APPLICATION_NOT_FOUND', source: 'greenhouse' },
          );
        }
        snapshot.application = app;
      } catch (err: any) {
        if (err instanceof FreshReadError) throw err;
        throw new FreshReadError(
          `Failed to fetch Greenhouse application ${applicationId}: ${err?.message ?? String(err)}`,
          { code: 'GREENHOUSE_APPLICATION_FETCH_FAILED', source: 'greenhouse', cause: err },
        );
      }
    }

    if (needsScorecards) {
      if (!config.greenhouse || typeof config.greenhouse.listScorecards !== 'function') {
        throw new FreshReadError(
          `Greenhouse listScorecards adapter is required for episode '${episodeId}' but not configured.`,
          { code: 'GREENHOUSE_SCORECARDS_UNCONFIGURED', source: 'greenhouse' },
        );
      }
      try {
        const scorecards = await withTimeout(
          () => config.greenhouse!.listScorecards!(applicationId!),
          timeoutMs,
          'greenhouse_read',
          'listScorecards',
        );
        if (!Array.isArray(scorecards)) {
          throw new FreshReadError(
            `Greenhouse listScorecards for application ${applicationId} did not return an array.`,
            { code: 'GREENHOUSE_SCORECARDS_INVALID', source: 'greenhouse' },
          );
        }
        snapshot.scorecards = scorecards;
      } catch (err: any) {
        if (err instanceof FreshReadError) throw err;
        throw new FreshReadError(
          `Failed to fetch Greenhouse scorecards for application ${applicationId}: ${err?.message ?? String(err)}`,
          { code: 'GREENHOUSE_SCORECARDS_FETCH_FAILED', source: 'greenhouse', cause: err },
        );
      }
    }

    if (needsInterviews) {
      if (!config.greenhouse || typeof config.greenhouse.listInterviews !== 'function') {
        throw new FreshReadError(
          `Greenhouse listInterviews adapter is required for episode '${episodeId}' but not configured.`,
          { code: 'GREENHOUSE_INTERVIEWS_UNCONFIGURED', source: 'greenhouse' },
        );
      }
      try {
        const interviews = await withTimeout(
          () => config.greenhouse!.listInterviews!(applicationId!),
          timeoutMs,
          'greenhouse_read',
          'listInterviews',
        );
        if (!Array.isArray(interviews)) {
          throw new FreshReadError(
            `Greenhouse listInterviews for application ${applicationId} did not return an array.`,
            { code: 'GREENHOUSE_INTERVIEWS_INVALID', source: 'greenhouse' },
          );
        }
        snapshot.interviews = interviews;
      } catch (err: any) {
        if (err instanceof FreshReadError) throw err;
        throw new FreshReadError(
          `Failed to fetch Greenhouse interviews for application ${applicationId}: ${err?.message ?? String(err)}`,
          { code: 'GREENHOUSE_INTERVIEWS_FETCH_FAILED', source: 'greenhouse', cause: err },
        );
      }
    }

    // 2. Gmail Thread State
    if (needsGmail) {
      if (!config.gmail || typeof config.gmail.getThreadState !== 'function') {
        throw new FreshReadError(
          `Gmail read adapter is required for episode '${episodeId}' but not configured.`,
          { code: 'GMAIL_READ_UNCONFIGURED', source: 'gmail' },
        );
      }
      const threadId =
        expected.gmail_thread_id ??
        (typeof epState.gmail_thread_id === 'string' ? epState.gmail_thread_id : undefined) ??
        (typeof epState.thread_id === 'string' ? epState.thread_id : undefined);

      try {
        const gmailState = await withTimeout(
          () =>
            config.gmail!.getThreadState({
              episode_id: episodeId,
              thread_id: threadId,
              expected_last_message_id: expected.gmail_last_message_id,
            }),
          timeoutMs,
          'gmail_read',
          'getThreadState',
        );
        if (!gmailState || typeof gmailState !== 'object') {
          throw new FreshReadError(
            `Gmail getThreadState for episode '${episodeId}' returned null/empty state.`,
            { code: 'GMAIL_STATE_EMPTY', source: 'gmail' },
          );
        }
        if (
          expected.gmail_last_message_id !== undefined &&
          (typeof gmailState.last_message_id !== 'string' || !gmailState.last_message_id.trim())
        ) {
          throw new FreshReadError(
            `Gmail getThreadState for episode '${episodeId}' omitted required last_message_id.`,
            { code: 'GMAIL_STATE_MALFORMED', source: 'gmail' },
          );
        }
        if (
          expected.require_no_unsent_sam_draft === true &&
          typeof gmailState.has_unsent_sam_draft !== 'boolean'
        ) {
          throw new FreshReadError(
            `Gmail getThreadState for episode '${episodeId}' omitted boolean has_unsent_sam_draft.`,
            { code: 'GMAIL_STATE_MALFORMED', source: 'gmail' },
          );
        }
        snapshot.gmail = {
          thread_id: gmailState.thread_id ?? threadId,
          last_message_id: gmailState.last_message_id ?? null,
          has_newer_candidate_reply: Boolean(gmailState.has_newer_candidate_reply),
          has_unsent_sam_draft: Boolean(gmailState.has_unsent_sam_draft),
          candidate_withdrew: Boolean(gmailState.candidate_withdrew),
        };
      } catch (err: any) {
        if (err instanceof FreshReadError) throw err;
        throw new FreshReadError(
          `Failed to fetch Gmail thread state for episode '${episodeId}': ${err?.message ?? String(err)}`,
          { code: 'GMAIL_FETCH_FAILED', source: 'gmail', cause: err },
        );
      }
    }

    // 3. Google Calendar busy_intervals
    if (needsCalendar) {
      if (!config.calendar || typeof config.calendar.getBusyIntervals !== 'function') {
        throw new FreshReadError(
          `Calendar read adapter is required for episode '${episodeId}' (calendar_Check) but not configured.`,
          { code: 'CALENDAR_READ_UNCONFIGURED', source: 'calendar' },
        );
      }
      const checkObj =
        typeof calendarCheckSpec === 'object' && calendarCheckSpec !== null
          ? calendarCheckSpec
          : undefined;
      const windowStart = checkObj?.start ?? epState.starts_at ?? epState.start;
      const windowEnd = checkObj?.end ?? epState.ends_at ?? epState.end;
      if (
        checkObj &&
        (typeof windowStart !== 'string' ||
          !windowStart.trim() ||
          typeof windowEnd !== 'string' ||
          !windowEnd.trim())
      ) {
        throw new FreshReadError(
          `Calendar check for episode '${episodeId}' is missing required start/end window.`,
          { code: 'CALENDAR_WINDOW_MISSING', source: 'calendar' },
        );
      }

      try {
        const calRes = await withTimeout(
          () =>
            config.calendar!.getBusyIntervals({
              episode_id: episodeId,
              start: windowStart,
              end: windowEnd,
              calendar_id: checkObj?.calendar_id,
              check: calendarCheckSpec,
            }),
          timeoutMs,
          'calendar_read',
          'getBusyIntervals',
        );
        if (!calRes || typeof calRes !== 'object') {
          throw new FreshReadError(
            `Calendar getBusyIntervals for episode '${episodeId}' returned null/empty state.`,
            { code: 'CALENDAR_STATE_EMPTY', source: 'calendar' },
          );
        }
        if (!Array.isArray(calRes) && !Array.isArray((calRes as any).busy_intervals)) {
          throw new FreshReadError(
            `Calendar getBusyIntervals for episode '${episodeId}' did not return busy_intervals array.`,
            { code: 'CALENDAR_STATE_MALFORMED', source: 'calendar' },
          );
        }
        const busyIntervals: CalendarBusyInterval[] = Array.isArray(calRes)
          ? calRes
          : calRes.busy_intervals;
        const conflictingIds: string[] = Array.isArray((calRes as any).conflicting_event_ids)
          ? [...(calRes as any).conflicting_event_ids]
          : busyIntervals.map((b, idx) => b.event_id ?? `busy_${idx}`);

        snapshot.calendar = {
          busy_intervals: busyIntervals,
          conflicting_event_ids: conflictingIds,
        };
      } catch (err: any) {
        if (err instanceof FreshReadError) throw err;
        throw new FreshReadError(
          `Failed to fetch Calendar busy_intervals for episode '${episodeId}': ${err?.message ?? String(err)}`,
          { code: 'CALENDAR_FETCH_FAILED', source: 'calendar', cause: err },
        );
      }
    }

    // 4. Slack message / reaction state
    if (needsSlack) {
      if (!config.slack || typeof config.slack.getMessageState !== 'function') {
        throw new FreshReadError(
          `Slack read adapter is required for episode '${episodeId}' but not configured.`,
          { code: 'SLACK_READ_UNCONFIGURED', source: 'slack' },
        );
      }
      const channelId =
        expected.slack_channel_id ??
        (typeof epState.channel_id === 'string' ? epState.channel_id : undefined);
      const messageTs =
        expected.slack_message_ts ??
        (typeof epState.message_ts === 'string' ? epState.message_ts : undefined);

      try {
        const slackState = await withTimeout(
          () =>
            config.slack!.getMessageState({
              episode_id: episodeId,
              channel_id: channelId,
              message_ts: messageTs,
              require_no_reaction_removal: expected.require_no_reaction_removal,
              require_no_hm_override: expected.require_no_hm_override,
            }),
          timeoutMs,
          'slack_read',
          'getMessageState',
        );
        if (!slackState || typeof slackState !== 'object') {
          throw new FreshReadError(
            `Slack getMessageState for episode '${episodeId}' returned null/empty state.`,
            { code: 'SLACK_STATE_EMPTY', source: 'slack' },
          );
        }
        if (
          expected.require_no_reaction_removal === true &&
          typeof slackState.reaction_removed !== 'boolean'
        ) {
          throw new FreshReadError(
            `Slack getMessageState for episode '${episodeId}' omitted boolean reaction_removed.`,
            { code: 'SLACK_STATE_MALFORMED', source: 'slack' },
          );
        }
        if (
          expected.require_no_hm_override === true &&
          typeof slackState.hm_override_detected !== 'boolean' &&
          typeof slackState.has_hm_override !== 'boolean'
        ) {
          throw new FreshReadError(
            `Slack getMessageState for episode '${episodeId}' omitted boolean hm_override_detected.`,
            { code: 'SLACK_STATE_MALFORMED', source: 'slack' },
          );
        }
        const hmOverride = Boolean(
          slackState.hm_override_detected ?? slackState.has_hm_override,
        );
        snapshot.slack = {
          reaction_removed: Boolean(slackState.reaction_removed),
          hm_override_detected: hmOverride,
          has_hm_override: hmOverride,
          override_ruling: slackState.override_ruling ?? null,
          interviewer_declined_reason: slackState.interviewer_declined_reason ?? null,
        };
      } catch (err: any) {
        if (err instanceof FreshReadError) throw err;
        throw new FreshReadError(
          `Failed to fetch Slack message/reaction state for episode '${episodeId}': ${err?.message ?? String(err)}`,
          { code: 'SLACK_FETCH_FAILED', source: 'slack', cause: err },
        );
      }
    }

    return snapshot;
  };
}

// ---------------------------------------------------------------------------
// Live Write-Plane Providers (Calendar, Gmail, Slack, & Dry-Run ActionService)
// ---------------------------------------------------------------------------

export interface BaseLiveProviderOptions {
  transport?: ProviderTransportConfig;
  timeoutMs?: number;
  dryRun?: boolean;
  dryRunLog?: DryRunCallRecord[];
  onDryRunCall?: (record: DryRunCallRecord) => void;
  now?: () => Date;
  gateContext?: SendGateCheckInput | (() => SendGateCheckInput | null | undefined);
  enforceHookGate?: boolean;
  transcriptPath?: string;
  sessionId?: string;
}

function recordDryRunCall(
  options: BaseLiveProviderOptions,
  service: 'greenhouse' | 'calendar' | 'gmail' | 'slack',
  operation: string,
  input: Record<string, unknown>,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ service, operation, input }), 'utf8')
    .digest('hex')
    .slice(0, 12);
  const syntheticId = `dryrun_${service}_${operation}_${digest}`;
  const record: DryRunCallRecord = {
    timestamp: (options.now ?? (() => new Date()))().toISOString(),
    service,
    operation,
    input,
    synthetic_provider_id: syntheticId,
  };
  if (Array.isArray(options.dryRunLog)) {
    options.dryRunLog.push(record);
  }
  if (typeof options.onDryRunCall === 'function') {
    options.onDryRunCall(record);
  }
  return syntheticId;
}

export class LiveCalendarProvider implements CalendarProvider {
  readonly options: BaseLiveProviderOptions;

  constructor(options: BaseLiveProviderOptions = {}) {
    this.options = options;
  }

  private checkGate(operation: string, input: Record<string, unknown>): void {
    enforceProviderSendGate('calendar', operation, input, {
      gateContext: this.options.gateContext,
      enforceHookGate: this.options.enforceHookGate,
      transcriptPath: this.options.transcriptPath,
      sessionId: this.options.sessionId,
    });
  }

  private requireTransport(operation: string): ProviderTransportConfig {
    if (!this.options.transport) {
      throw new ProviderTransportError(
        `CalendarProvider transport is not configured for operation '${operation}'.`,
        { service: 'calendar', operation, code: 'CALENDAR_TRANSPORT_UNCONFIGURED' },
      );
    }
    return this.options.transport;
  }

  async createSilentHold(input: {
    summary: string;
    description?: string;
    start: string;
    end: string;
    timeZone?: string;
    conferenceRequestId?: string;
  }): Promise<CalendarHoldEvent> {
    const payload = { ...input, sendUpdates: 'none' as const };
    this.checkGate('create_silent_hold', payload);

    if (this.options.dryRun) {
      const id = recordDryRunCall(
        this.options,
        'calendar',
        'create_silent_hold',
        payload,
      );
      return {
        event_id: id,
        summary: input.summary,
        description: input.description,
        start: input.start,
        end: input.end,
        status: 'confirmed',
        hangout_link: 'https://meet.google.com/dry-run-hold',
        html_link: `https://calendar.google.com/calendar/event?eid=${id}`,
        attendees: [],
      };
    }

    const transport = this.requireTransport('create_silent_hold');
    const res = await invokeTransport<CalendarHoldEvent>(
      transport,
      'calendar',
      'create_silent_hold',
      payload,
      { timeoutMs: this.options.timeoutMs },
    );
    if (!res || typeof res.event_id !== 'string' || !res.event_id) {
      throw new ProviderTransportError(
        'Calendar create_silent_hold response missing event_id.',
        { service: 'calendar', operation: 'create_silent_hold', code: 'INVALID_RESPONSE' },
      );
    }
    return res;
  }

  async createCandidateEvent(input: {
    summary: string;
    description: string;
    start: string;
    end: string;
    timeZone?: string;
    attendees: Array<{ email: string; responseStatus?: string }>;
    googleMeetUrl: string;
    visibility?: 'private' | 'default';
    sendUpdates: 'all' | 'none';
  }): Promise<CalendarHoldEvent> {
    const payload = {
      ...input,
      visibility: input.visibility ?? ('private' as const),
      sendUpdates: input.sendUpdates ?? ('all' as const),
    };
    this.checkGate('create_candidate_event', payload);

    if (this.options.dryRun) {
      const id = recordDryRunCall(
        this.options,
        'calendar',
        'create_candidate_event',
        payload,
      );
      return {
        event_id: id,
        summary: input.summary,
        description: input.description,
        start: input.start,
        end: input.end,
        status: 'confirmed',
        hangout_link: input.googleMeetUrl,
        html_link: `https://calendar.google.com/calendar/event?eid=${id}`,
        attendees: input.attendees,
      };
    }

    const transport = this.requireTransport('create_candidate_event');
    const res = await invokeTransport<CalendarHoldEvent>(
      transport,
      'calendar',
      'create_candidate_event',
      payload,
      { timeoutMs: this.options.timeoutMs },
    );
    if (!res || typeof res.event_id !== 'string' || !res.event_id) {
      throw new ProviderTransportError(
        'Calendar create_candidate_event response missing event_id.',
        { service: 'calendar', operation: 'create_candidate_event', code: 'INVALID_RESPONSE' },
      );
    }
    return res;
  }

  async patchEvent(input: {
    event_id: string;
    summary?: string;
    description?: string;
    start?: string;
    end?: string;
    attendees?: Array<{ email: string; responseStatus?: string }>;
    sendUpdates: 'all' | 'none';
  }): Promise<CalendarHoldEvent> {
    const payload = { ...input };
    this.checkGate('patch_event', payload);

    if (this.options.dryRun) {
      recordDryRunCall(this.options, 'calendar', 'patch_event', payload);
      return {
        event_id: input.event_id,
        summary: input.summary,
        description: input.description,
        start: input.start,
        end: input.end,
        status: 'confirmed',
        attendees: input.attendees ?? [],
      };
    }

    const transport = this.requireTransport('patch_event');
    const res = await invokeTransport<CalendarHoldEvent>(
      transport,
      'calendar',
      'patch_event',
      payload,
      { timeoutMs: this.options.timeoutMs },
    );
    if (!res || typeof res.event_id !== 'string' || !res.event_id) {
      throw new ProviderTransportError(
        'Calendar patch_event response missing event_id.',
        { service: 'calendar', operation: 'patch_event', code: 'INVALID_RESPONSE' },
      );
    }
    return res;
  }

  async deleteEvent(input: {
    event_id: string;
    sendUpdates?: 'all' | 'none';
  }): Promise<{ deleted: boolean }> {
    const payload = { ...input, sendUpdates: input.sendUpdates ?? 'none' };
    this.checkGate('delete_event', payload);

    if (this.options.dryRun) {
      recordDryRunCall(this.options, 'calendar', 'delete_event', payload);
      return { deleted: true };
    }

    const transport = this.requireTransport('delete_event');
    const res = await invokeTransport<{ deleted: boolean }>(
      transport,
      'calendar',
      'delete_event',
      payload,
      { timeoutMs: this.options.timeoutMs },
    );
    return { deleted: Boolean(res?.deleted ?? true) };
  }

  async getEvent(eventId: string): Promise<CalendarHoldEvent | null> {
    if (this.options.dryRun && !this.options.transport) {
      return null;
    }
    const transport = this.requireTransport('get_event');
    return await invokeTransport<CalendarHoldEvent | null>(
      transport,
      'calendar',
      'get_event',
      { event_id: eventId },
      { timeoutMs: this.options.timeoutMs },
    );
  }

  async listEvents(input: { start: string; end: string }): Promise<CalendarHoldEvent[]> {
    if (this.options.dryRun && !this.options.transport) {
      return [];
    }
    const transport = this.requireTransport('list_events');
    const res = await invokeTransport<CalendarHoldEvent[]>(
      transport,
      'calendar',
      'list_events',
      input,
      { timeoutMs: this.options.timeoutMs },
    );
    return Array.isArray(res) ? res : [];
  }
}

export class LiveGmailProvider implements GmailProvider {
  readonly options: BaseLiveProviderOptions;

  constructor(options: BaseLiveProviderOptions = {}) {
    this.options = options;
  }

  async sendMessage(input: {
    to: string;
    from?: string;
    cc?: string[];
    subject: string;
    htmlBody: string;
    threadId?: string;
  }): Promise<{ message_id: string; thread_id?: string }> {
    const payload: Record<string, unknown> = { ...input };
    enforceProviderSendGate('gmail', 'send_message', payload, {
      gateContext: this.options.gateContext,
      enforceHookGate: this.options.enforceHookGate,
      transcriptPath: this.options.transcriptPath,
      sessionId: this.options.sessionId,
    });

    if (this.options.dryRun) {
      const id = recordDryRunCall(this.options, 'gmail', 'send_message', payload);
      return {
        message_id: id,
        thread_id: input.threadId ?? `dryrun_thread_${id}`,
      };
    }

    if (!this.options.transport) {
      throw new ProviderTransportError(
        'GmailProvider transport is not configured for send_message.',
        { service: 'gmail', operation: 'send_message', code: 'GMAIL_TRANSPORT_UNCONFIGURED' },
      );
    }

    const res = await invokeTransport<{ message_id: string; thread_id?: string }>(
      this.options.transport,
      'gmail',
      'send_message',
      payload,
      { timeoutMs: this.options.timeoutMs },
    );
    if (!res || typeof res.message_id !== 'string' || !res.message_id) {
      throw new ProviderTransportError(
        'Gmail send_message response missing message_id.',
        { service: 'gmail', operation: 'send_message', code: 'INVALID_RESPONSE' },
      );
    }
    return res;
  }
}

export class LiveSlackProvider implements SlackProvider {
  readonly options: BaseLiveProviderOptions;

  constructor(options: BaseLiveProviderOptions = {}) {
    this.options = options;
  }

  async sendMessage(input: {
    channel: string;
    text: string;
    thread_ts?: string;
  }): Promise<{ ts: string; channel: string }> {
    const payload: Record<string, unknown> = {
      ...input,
      message: input.text,
    };
    enforceProviderSendGate('slack', 'send_message', payload, {
      gateContext: this.options.gateContext,
      enforceHookGate: this.options.enforceHookGate,
      transcriptPath: this.options.transcriptPath,
      sessionId: this.options.sessionId,
    });

    if (this.options.dryRun) {
      const id = recordDryRunCall(this.options, 'slack', 'send_message', payload);
      return {
        ts: id,
        channel: input.channel,
      };
    }

    if (!this.options.transport) {
      throw new ProviderTransportError(
        'SlackProvider transport is not configured for send_message.',
        { service: 'slack', operation: 'send_message', code: 'SLACK_TRANSPORT_UNCONFIGURED' },
      );
    }

    const res = await invokeTransport<{ ts: string; channel: string }>(
      this.options.transport,
      'slack',
      'send_message',
      payload,
      { timeoutMs: this.options.timeoutMs },
    );
    if (!res || typeof res.ts !== 'string' || !res.ts) {
      throw new ProviderTransportError(
        'Slack send_message response missing ts.',
        { service: 'slack', operation: 'send_message', code: 'INVALID_RESPONSE' },
      );
    }
    return {
      ts: res.ts,
      channel: res.channel ?? input.channel,
    };
  }
}

export class DryRunActionService implements ActionServiceLike {
  readonly options: BaseLiveProviderOptions;
  private syntheticCounter = 900_000_000;

  constructor(options: BaseLiveProviderOptions = {}) {
    this.options = { ...options, dryRun: true };
  }

  async preview(
    kind: string,
    input: Record<string, unknown>,
    _actor?: GreenhouseActorContext,
    _client?: 'mcp' | 'cli' | 'slack' | 'ops_executor',
  ): Promise<ActionPreviewResponse> {
    const id = recordDryRunCall(
      this.options,
      'greenhouse',
      `preview_${kind}`,
      input,
    );
    return {
      status: 'ready',
      changeRequired: true,
      intent: { kind, input, dry_run_id: id },
      approval: { dry_run: true, id },
      summary: `[DRY-RUN] Preview ${kind}`,
    };
  }

  async apply(
    kind: string,
    request: {
      intent: unknown;
      approval: unknown;
      payload?: Record<string, unknown>;
    },
    _extraPayloadOrActor?: any,
    _client?: 'mcp' | 'cli' | 'slack' | 'ops_executor',
  ): Promise<ActionApplyResponse> {
    const id = recordDryRunCall(
      this.options,
      'greenhouse',
      `apply_${kind}`,
      {
        intent: request.intent as Record<string, unknown>,
        has_payload: Boolean(request.payload),
      },
    );
    const numericId = ++this.syntheticCounter;
    return {
      status: 'applied',
      state: 'succeeded',
      observation: 'observed',
      action_id: id,
      provider_id: String(numericId),
      result_resource_id: numericId,
      result: {
        id: numericId,
        dry_run: true,
        synthetic_provider_id: id,
      },
    };
  }
}

export interface CreateLiveProvidersConfig {
  store?: SqliteCoordinatorStore;
  dryRun?: boolean;
  timeoutMs?: number;
  now?: () => Date;
  greenhouseRead?: GreenhouseReadAdapter;
  gmailRead?: GmailReadAdapter;
  calendarRead?: CalendarReadAdapter;
  slackRead?: SlackReadAdapter;
  calendarTransport?: ProviderTransportConfig;
  gmailTransport?: ProviderTransportConfig;
  slackTransport?: ProviderTransportConfig;
  actionService?: ActionServiceLike;
  onDryRunCall?: (record: DryRunCallRecord) => void;
  gateContext?: SendGateCheckInput | (() => SendGateCheckInput | null | undefined);
  enforceHookGate?: boolean;
}

export function createLiveProviders(config: CreateLiveProvidersConfig = {}): {
  freshReadFetcher: (episodeId: string, expected: ExpectedFreshState) => Promise<FreshReadSnapshot>;
  calendar: LiveCalendarProvider;
  gmail: LiveGmailProvider;
  slack: LiveSlackProvider;
  actionService?: ActionServiceLike;
  dryRunLog: DryRunCallRecord[];
} {
  const dryRunLog: DryRunCallRecord[] = [];
  const baseOpts: BaseLiveProviderOptions = {
    dryRun: config.dryRun,
    timeoutMs: config.timeoutMs,
    dryRunLog,
    onDryRunCall: config.onDryRunCall,
    now: config.now,
    gateContext: config.gateContext,
    enforceHookGate: config.enforceHookGate,
  };

  const freshReadFetcher = createLiveFreshReadFetcher({
    store: config.store,
    greenhouse: config.greenhouseRead,
    gmail: config.gmailRead,
    calendar: config.calendarRead,
    slack: config.slackRead,
    now: config.now,
    timeoutMs: config.timeoutMs,
  });

  const calendar = new LiveCalendarProvider({
    ...baseOpts,
    transport: config.calendarTransport,
  });

  const gmail = new LiveGmailProvider({
    ...baseOpts,
    transport: config.gmailTransport,
  });

  const slack = new LiveSlackProvider({
    ...baseOpts,
    transport: config.slackTransport,
  });

  const actionService = config.dryRun
    ? new DryRunActionService(baseOpts)
    : config.actionService;

  return {
    freshReadFetcher,
    calendar,
    gmail,
    slack,
    actionService,
    dryRunLog,
  };
}
