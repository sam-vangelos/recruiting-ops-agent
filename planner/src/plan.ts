/**
 * The planner: one PlanInput in, one JSON-serialisable Plan out, no I/O beyond reading the templates.
 * It finds the slot, renders every outgoing text, builds the exact Calendar and Gmail payloads, keys
 * each outward step for the ledger, runs the guard over all of it, and names the next state. It never
 * dispatches; under the pilot gate a person executes the plan (WORKFLOW.md, "The pilot gate").
 */
import { runChecks, type GuardCheck, type GuardChannel, type OutgoingMessage } from './guard.js';
import { buildCandidateAddPatch, buildHoldEvent, holdEventId, type HoldEventRequest } from './hold.js';
import { ledgerKey, type LedgerStep } from './ledger-keys.js';
import { buildReply, type Reply } from './mail.js';
import { findSlots } from './slots.js';
import { transition, type State, type StateEvent } from './states.js';
import { loadTemplate, renderTemplate, type Fields, type Template } from './templates.js';
import { DAY_MS, formatTime, formatWindow, normalizeZone, parseInstant, toZonedIso } from './time.js';
import type { Attendee, PlanInput, Slot } from './types.js';

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

export interface FreeBusyRequest {
  timeMin: string;
  timeMax: string;
  items: Array<{ id: string }>;
}

export interface CalendarStep {
  step: LedgerStep;
  ledgerKey: string;
  kind: 'calendar';
  request: HoldEventRequest | { method: 'PATCH'; path: string; query: { sendUpdates: 'all' }; body: { attendees: Attendee[] } };
}

export interface GmailStep {
  step: LedgerStep;
  ledgerKey: string;
  kind: 'gmail';
  template: string;
  message: Reply;
}

export interface SlackStep {
  step: LedgerStep;
  ledgerKey: string;
  kind: 'slack';
  message: { to: string[]; text: string };
}

export type PlannedStep = CalendarStep | GmailStep | SlackStep;

export interface GuardEntry {
  step: LedgerStep;
  ok: boolean;
  checks: GuardCheck[];
}

export interface Plan {
  /** True when every guard check passed. A plan with no steps is trivially dispatchable. */
  dispatchable: boolean;
  /** Every failing guard reason, prefixed with its step. */
  reasons: string[];
  fromState: State;
  stateTrail: Array<{ from: State; event: StateEvent; to: State }>;
  nextState: State;
  /** The state once every step (and every deferred step) has been dispatched and recorded; null when a person must act. */
  stateAfterDispatch: State | null;
  freeBusyRequest: FreeBusyRequest | null;
  /** Days of free/busy the slot search used: 7, or 14 when nothing fitted in 7. */
  searchedDays: number | null;
  slots: Slot[];
  chosenSlot: Slot | null;
  times: { candidate: string; interviewer: string; interviewerWindow: string } | null;
  eventId: string | null;
  /** In dispatch order. */
  steps: PlannedStep[];
  /** Outward steps this slice does not build yet, keyed so the ledger can still guard them. */
  deferred: Array<{ step: LedgerStep; ledgerKey: string; reason: string }>;
  guard: GuardEntry[];
  notes: string[];
}

const ALT_MIN = 3;
const ALT_MAX = 5;
const ESCALATION_MAX_WORDS = 80;

// ---------------------------------------------------------------------------------------------- input

const PLAIN_ID = /^[A-Za-z0-9_-]+$/;

function req(obj: unknown, path: string): Record<string, unknown> {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new InvalidInputError(`${path} must be an object`);
  return obj as Record<string, unknown>;
}

function str(o: Record<string, unknown>, key: string, path: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') throw new InvalidInputError(`${path}.${key} must be a non-empty string`);
  return v;
}

function email(o: Record<string, unknown>, key: string, path: string): string {
  const v = str(o, key, path);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)) throw new InvalidInputError(`${path}.${key} is not an email address: ${JSON.stringify(v)}`);
  return v;
}

function zone(o: Record<string, unknown>, path: string): string {
  try {
    return normalizeZone(str(o, 'zone', path));
  } catch (e) {
    throw new InvalidInputError(`${path}.zone: ${(e as Error).message}`);
  }
}

function instant(v: unknown, path: string): number {
  if (typeof v !== 'string') throw new InvalidInputError(`${path} must be an ISO 8601 string with an offset`);
  try {
    return parseInstant(v, path);
  } catch (e) {
    throw new InvalidInputError((e as Error).message);
  }
}

function windowOf(v: unknown, path: string): void {
  const w = req(v, path);
  const s = instant(w.start, `${path}.start`);
  const e = instant(w.end, `${path}.end`);
  if (e <= s) throw new InvalidInputError(`${path} ends before it starts`);
}

/** Validates the whole input and returns a copy with every zone normalised to IANA. */
export function validateInput(raw: unknown): PlanInput {
  const top = req(raw, 'input');
  const c = req(top.candidate, 'candidate');
  const i = req(top.interviewer, 'interviewer');
  const s = req(top.spec, 'spec');
  const r = req(top.recruiter, 'recruiter');
  for (const k of ['firstName', 'fullName', 'location', 'threadId', 'threadSubject']) str(c, k, 'candidate');
  email(c, 'email', 'candidate');
  if (!/^<[^<>\s]+>$/.test(str(c, 'lastMessageId', 'candidate'))) {
    throw new InvalidInputError('candidate.lastMessageId must be the RFC 2822 Message-ID header, e.g. <abc@mail.gmail.com>');
  }
  for (const k of ['firstName', 'fullName', 'title']) str(i, k, 'interviewer');
  email(i, 'email', 'interviewer');
  for (const k of ['applicationId', 'jobInterviewId', 'candidateId', 'kitId']) {
    if (!PLAIN_ID.test(str(s, k, 'spec'))) throw new InvalidInputError(`spec.${k} must be a plain id`);
  }
  str(s, 'jobName', 'spec');
  if (!Number.isInteger(s.durationMin) || (s.durationMin as number) <= 0) throw new InvalidInputError('spec.durationMin must be a positive whole number');
  if (!Number.isInteger(s.attempt) || (s.attempt as number) < 1) throw new InvalidInputError('spec.attempt must be a whole number from 1');
  for (const k of ['firstName', 'fullName', 'title']) str(r, k, 'recruiter');
  email(r, 'email', 'recruiter');
  str(top, 'disclosureLine', 'input');
  str(top, 'candidateSummary', 'input');
  instant(top.now, 'now');
  if (!Array.isArray(top.candidateWindows)) throw new InvalidInputError('candidateWindows must be an array (empty when none received)');
  top.candidateWindows.forEach((w, n) => windowOf(w, `candidateWindows[${n}]`));
  const fb = req(top.freeBusy, 'freeBusy');
  for (const [id, entry] of Object.entries(fb)) {
    const e = req(entry, `freeBusy.${id}`);
    if ('error' in e) continue;
    if (!Array.isArray(e.busy)) throw new InvalidInputError(`freeBusy.${id} needs a busy array or an error`);
    e.busy.forEach((b, n) => windowOf(b, `freeBusy.${id}.busy[${n}]`));
  }
  if (top.freeBusyRange !== undefined) windowOf(top.freeBusyRange, 'freeBusyRange');
  if (top.existingBookings !== undefined) {
    for (const [who, list] of Object.entries(req(top.existingBookings, 'existingBookings'))) {
      if (!Array.isArray(list)) throw new InvalidInputError(`existingBookings.${who} must be an array`);
      list.forEach((b, n) => windowOf(b, `existingBookings.${who}[${n}]`));
    }
  }
  const resp = top.interviewerResponse;
  if (resp !== undefined) {
    if (resp !== 'needsAction' && resp !== 'accepted' && resp !== 'declined') {
      throw new InvalidInputError('interviewerResponse must be needsAction, accepted or declined');
    }
    if (top.heldSlot === undefined) {
      throw new InvalidInputError('heldSlot is required with interviewerResponse: free/busy now shows the hold itself as busy, so the slot cannot be recomputed');
    }
    windowOf(top.heldSlot, 'heldSlot');
    if (resp === 'accepted' && (typeof top.meetLink !== 'string' || top.meetLink.trim() === '')) {
      throw new InvalidInputError("meetLink is required once the interviewer has accepted (the event's hangoutLink)");
    }
  }
  if (top.heldAttendees !== undefined) {
    if (!Array.isArray(top.heldAttendees)) throw new InvalidInputError('heldAttendees must be an array');
    top.heldAttendees.forEach((a, n) => email(req(a, `heldAttendees[${n}]`), 'email', `heldAttendees[${n}]`));
  }
  if (top.otherCandidateNames !== undefined && (!Array.isArray(top.otherCandidateNames) || top.otherCandidateNames.some((x) => typeof x !== 'string'))) {
    throw new InvalidInputError('otherCandidateNames must be an array of strings');
  }
  const input = structuredClone(top) as unknown as PlanInput;
  input.candidate.zone = zone(c, 'candidate');
  input.interviewer.zone = zone(i, 'interviewer');
  return input;
}

// ---------------------------------------------------------------------------------------------- plan

function kitLink(input: PlanInput): string {
  const { kitId, candidateId, applicationId } = input.spec;
  return `https://app4.greenhouse.io/guides/${kitId}/people/${candidateId}?application_id=${applicationId}`;
}

function baseFields(input: PlanInput): Fields {
  const { candidate: c, interviewer: i, recruiter: r, spec } = input;
  return {
    CANDIDATE_FIRST_NAME: c.firstName,
    CANDIDATE_NAME: c.fullName,
    CANDIDATE_LOCATION: c.location,
    JOB_NAME: spec.jobName,
    INTERVIEWER_NAME: i.fullName,
    INTERVIEWER_FIRST_NAME: i.firstName,
    INTERVIEWER_TITLE: i.title,
    INTERVIEW_DURATION_MIN: String(spec.durationMin),
    INTERVIEW_KIT_LINK: kitLink(input),
    CANDIDATE_SUMMARY: input.candidateSummary,
    RULING_LINE: input.rulingLine ?? '',
    RECRUITER_ADDITIONS: input.recruiterAdditions ?? '',
    RECRUITER_FIRST_NAME: r.firstName,
    RECRUITER_FULL_NAME: r.fullName,
    RECRUITER_TITLE: r.title,
    DISCLOSURE_LINE: input.disclosureLine,
    ...(input.meetLink === undefined ? {} : { MEET_LINK: input.meetLink }),
  };
}

function slotTimes(input: PlanInput, slot: Slot) {
  return {
    candidate: formatTime(slot.start, input.candidate.zone),
    interviewer: formatTime(slot.start, input.interviewer.zone),
    interviewerWindow: formatWindow(slot.start, slot.end, input.interviewer.zone),
  };
}

class Builder {
  readonly steps: PlannedStep[] = [];
  readonly deferred: Plan['deferred'] = [];
  readonly guard: GuardEntry[] = [];
  readonly notes: string[] = [];
  readonly trail: Plan['stateTrail'] = [];
  state: State;

  constructor(
    readonly input: PlanInput,
    readonly fromState: State,
  ) {
    this.state = fromState;
  }

  move(event: StateEvent): State {
    const to = transition(this.state, event);
    this.trail.push({ from: this.state, event, to });
    this.state = to;
    return to;
  }

  key(step: LedgerStep): string {
    const { applicationId, jobInterviewId, attempt } = this.input.spec;
    return ledgerKey(step, applicationId, jobInterviewId, attempt);
  }

  check(step: LedgerStep, msg: OutgoingMessage, allowedRecipients: string[], confirmedTimeStrings: string[], maxWords: number): void {
    const checks = runChecks(msg, {
      allowedRecipients,
      confirmedTimeStrings,
      otherCandidateNames: this.input.otherCandidateNames ?? [],
      maxWords,
    });
    this.guard.push({ step, ok: checks.every((c) => c.ok), checks });
  }

  /** Renders a gmail-reply template into a reply in the candidate's thread, guarded, as a step. */
  candidateEmail(step: LedgerStep, tpl: Template, fields: Fields, confirmed: string[]): void {
    if (tpl.channel !== 'gmail-reply') throw new Error(`template ${tpl.id} is not a gmail-reply`);
    const rendered = renderTemplate(tpl, fields);
    const message = buildReply(this.input.candidate, 'gmail-reply', rendered.body);
    this.check(step, { to: message.to, subject: message.subject, body: message.body, channel: 'gmail-reply' }, [this.input.candidate.email], confirmed, tpl.maxWords);
    this.steps.push({ step, ledgerKey: this.key(step), kind: 'gmail', template: tpl.id, message });
  }

  slack(text: string): void {
    const to = [this.input.recruiter.email];
    const channel: GuardChannel = 'slack';
    this.check('escalation', { to, subject: '', body: text, channel }, to, [], ESCALATION_MAX_WORDS);
    this.steps.push({ step: 'escalation', ledgerKey: this.key('escalation'), kind: 'slack', message: { to, text } });
  }
}

function freeBusyRequest(input: PlanInput, days: number): FreeBusyRequest {
  const now = parseInstant(input.now);
  return {
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + days * DAY_MS).toISOString(),
    items: [{ id: 'primary' }, { id: input.interviewer.email }],
  };
}

/** Free/busy coverage shorter than the search wanted: say so, because "nothing fits" may only mean "not read". */
function coverageNote(input: PlanInput, days: number): string | null {
  const now = parseInstant(input.now);
  const end = input.freeBusyRange ? parseInstant(input.freeBusyRange.end) : now + 7 * DAY_MS;
  if (end >= now + days * DAY_MS) return null;
  return `free/busy covers only to ${new Date(end).toISOString()}; the ${days}-day search stopped there. Read freeBusyRequest's full window and plan again before relying on this result.`;
}

/**
 * 3 to 5 calendar-confirmed alternatives across the next 14 days, ignoring the candidate's windows: the
 * first open slot of each day in the candidate's zone, then the earliest remaining if that gives fewer
 * than three days.
 */
function alternativeSlots(input: PlanInput, exclude: Slot | undefined): Slot[] {
  const now = parseInstant(input.now);
  const open = findSlots(
    { ...input, candidateWindows: [{ start: new Date(now).toISOString(), end: new Date(now + 14 * DAY_MS).toISOString() }] },
    { horizonDays: 14, limit: Number.POSITIVE_INFINITY },
  ).filter((s) => exclude === undefined || parseInstant(s.start) !== parseInstant(exclude.start));
  const picked: Slot[] = [];
  const days = new Set<string>();
  for (const s of open) {
    const day = toZonedIso(s.start, input.candidate.zone).slice(0, 10);
    if (days.has(day)) continue;
    days.add(day);
    picked.push(s);
    if (picked.length === ALT_MAX) break;
  }
  for (const s of open) {
    if (picked.length >= ALT_MIN) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.sort((a, b) => parseInstant(a.start) - parseInstant(b.start));
}

/** Sends `candidate-alternative-times` when at least three alternatives exist; otherwise asks a person in Slack. */
function offerAlternativesOrEscalate(b: Builder, why: string, exclude: Slot | undefined): void {
  const input = b.input;
  const alts = alternativeSlots(input, exclude);
  if (alts.length >= ALT_MIN) {
    const lines = alts.map((s) => formatTime(s.start, input.candidate.zone));
    const tpl = loadTemplate('candidate-alternative-times');
    b.candidateEmail('candidate-alternative-times', tpl, { ...baseFields(input), ALTERNATIVE_SLOTS: lines.map((l) => `- ${l}`).join('\n') }, lines);
    return;
  }
  const { candidate: c, interviewer: i, spec } = input;
  b.slack(
    `Scheduling needs a person: ${why} for ${c.fullName} (${spec.jobName}, application ${spec.applicationId}), and ${i.fullName} has ${alts.length} open slot(s) in the next 14 days, fewer than the ${ALT_MIN} needed to offer alternatives. The agent has sent nothing to the candidate.`,
  );
}

function finish(b: Builder, extra: Partial<Plan>): Plan {
  const reasons = b.guard.flatMap((g) => g.checks.flatMap((c) => c.reasons.map((r) => `${g.step}: ${r}`)));
  return {
    dispatchable: reasons.length === 0,
    reasons,
    fromState: b.fromState,
    stateTrail: b.trail,
    nextState: b.state,
    stateAfterDispatch: null,
    freeBusyRequest: null,
    searchedDays: null,
    slots: [],
    chosenSlot: null,
    times: null,
    eventId: null,
    steps: b.steps,
    deferred: b.deferred,
    guard: b.guard,
    notes: b.notes,
    ...extra,
  };
}

/** From `detected`: find the slot and build step 2 (hold + candidate reply), or the no-fit branch. */
function planFromDetected(input: PlanInput): Plan {
  const b = new Builder(input, 'detected');
  if (input.candidateWindows.length === 0) {
    b.move('no_availability');
    b.notes.push("No candidate availability yet. Greenhouse's own availability request (the stage rule) is the outward step; the agent sends nothing.");
    return finish(b, {});
  }
  b.move('availability_received');

  let searchedDays = 7;
  let slots = findSlots(input, { horizonDays: 7 });
  if (slots.length === 0) {
    searchedDays = 14;
    slots = findSlots(input, { horizonDays: 14 });
  }
  const note = coverageNote(input, searchedDays);
  if (note !== null) b.notes.push(note);
  const fbr = freeBusyRequest(input, searchedDays);

  const chosen = slots[0];
  if (chosen === undefined) {
    b.move('no_slot');
    offerAlternativesOrEscalate(b, "none of the candidate's windows fits the interviewer's free time", undefined);
    const sent = b.steps.some((s) => s.step === 'candidate-alternative-times');
    return finish(b, { freeBusyRequest: fbr, searchedDays, stateAfterDispatch: sent ? transition('no_fit', 'alternatives_sent') : null });
  }
  b.move('slot_found');

  const times = slotTimes(input, chosen);
  const confirmed = [times.candidate, times.interviewer, times.interviewerWindow];
  const fields: Fields = {
    ...baseFields(input),
    INTERVIEW_TIME_CANDIDATE: times.candidate,
    INTERVIEW_TIME_INTERVIEWER: times.interviewer,
    INTERVIEW_WINDOW_INTERVIEWER: times.interviewerWindow,
  };

  const inviteTpl = loadTemplate('interviewer-invite');
  const invite = renderTemplate(inviteTpl, fields);
  const hold = buildHoldEvent(input, chosen, invite);
  b.check(
    'hold-create',
    { to: hold.body.attendees.map((a) => a.email), subject: hold.body.summary, body: hold.body.description, channel: 'calendar-description' },
    [input.interviewer.email],
    confirmed,
    inviteTpl.maxWords,
  );
  b.steps.push({ step: 'hold-create', ledgerKey: b.key('hold-create'), kind: 'calendar', request: hold });
  b.candidateEmail('candidate-hold-reply', loadTemplate('candidate-hold-placed'), fields, confirmed);
  b.notes.push('Free/busy cannot see private holds: read the interviewer calendar again immediately before writing the event.');

  return finish(b, {
    freeBusyRequest: fbr,
    searchedDays,
    slots,
    chosenSlot: chosen,
    times,
    eventId: hold.body.id,
    stateAfterDispatch: transition(b.state, 'hold_dispatched'),
  });
}

/** From `held`: wait, confirm the candidate (step 4), or take the reschedule branch. */
function planFromHeld(input: PlanInput): Plan {
  const b = new Builder(input, 'held');
  const slot = input.heldSlot!;
  const times = slotTimes(input, slot);
  const eventId = holdEventId(input.spec.applicationId, input.spec.jobInterviewId, input.spec.attempt);
  const common = { chosenSlot: slot, times, eventId };

  if (input.interviewerResponse === 'needsAction') {
    b.notes.push('Waiting on the interviewer. The candidate is not contacted during the wait; the Slack nudge and escalation run on the dispatcher clock.');
    return finish(b, common);
  }

  if (input.interviewerResponse === 'declined') {
    b.move('interviewer_declined');
    const note = coverageNote(input, 14);
    if (note !== null) b.notes.push(note);
    b.notes.push('Rescheduling updates the existing event in place; it never creates a second one.');
    offerAlternativesOrEscalate(b, `${input.interviewer.fullName} declined the hold`, slot);
    const sent = b.steps.some((s) => s.step === 'candidate-alternative-times');
    return finish(b, { ...common, freeBusyRequest: freeBusyRequest(input, 14), searchedDays: 14, stateAfterDispatch: sent ? transition('rescheduling', 'alternatives_sent') : null });
  }

  // accepted
  b.move('interviewer_accepted');
  const attendees: Attendee[] = input.heldAttendees ?? [
    { email: input.interviewer.email, displayName: input.interviewer.fullName, responseStatus: 'accepted' },
  ];
  const patch = buildCandidateAddPatch(attendees, input.candidate);
  b.check(
    'candidate-add',
    { to: patch.body.attendees.map((a) => a.email), subject: '', body: '', channel: 'calendar-description' },
    [input.interviewer.email, input.candidate.email],
    [],
    1,
  );
  b.steps.push({
    step: 'candidate-add',
    ledgerKey: b.key('candidate-add'),
    kind: 'calendar',
    request: { method: 'PATCH', path: `calendars/primary/events/${eventId}`, ...patch },
  });
  const confirmed = [times.candidate, times.interviewer, times.interviewerWindow];
  b.candidateEmail(
    'candidate-confirmation',
    loadTemplate('candidate-confirmation'),
    {
      ...baseFields(input),
      INTERVIEW_TIME_CANDIDATE: times.candidate,
      INTERVIEW_TIME_INTERVIEWER: times.interviewer,
      INTERVIEW_WINDOW_INTERVIEWER: times.interviewerWindow,
    },
    confirmed,
  );
  b.deferred.push(
    { step: 'gh-interview-create', ledgerKey: b.key('gh-interview-create'), reason: 'greenhouse-mcp preview_interview_create / apply_interview_create (CLO-401), against this event id' },
    { step: 'gh-note', ledgerKey: b.key('gh-note'), reason: 'greenhouse-mcp apply_candidate_note_create: the private "assistant acted" note (CLO-401)' },
    { step: 'reminder', ledgerKey: b.key('reminder'), reason: 'candidate-reminder, the day before, once confirmed' },
  );
  return finish(b, { ...common, stateAfterDispatch: transition(b.state, 'candidate_confirmed') });
}

export function plan(raw: PlanInput): Plan {
  const input = validateInput(raw);
  return input.interviewerResponse === undefined ? planFromDetected(input) : planFromHeld(input);
}
