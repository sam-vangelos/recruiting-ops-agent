/**
 * Typed records for the scheduling planner (WORKFLOW.md). Every instant is an ISO 8601 string with an
 * explicit offset; every zone is a named IANA zone. Nothing here holds a wall-clock string without a zone.
 */

/** An instant plus the IANA zone it should be read in. */
export interface ZonedInstant {
  iso: string;
  zone: string;
}

/** A half-open span [start, end), both ISO 8601 with an offset. */
export interface TimeWindow {
  start: string;
  end: string;
}

/** A bookable interview slot, ISO 8601 with an offset (rendered in the interviewer's zone). */
export interface Slot {
  start: string;
  end: string;
}

export interface Candidate {
  /** Exactly as Greenhouse stores it. */
  firstName: string;
  fullName: string;
  email: string;
  /** City, or city and state, as the candidate gave it. */
  location: string;
  /** IANA zone, or a Greenhouse zone name that `normalizeZone` accepts. */
  zone: string;
  /** Gmail thread id of the candidate's existing thread. */
  threadId: string;
  /** The thread's original subject; replies go out as `Re: <this>`. */
  threadSubject: string;
  /** RFC 2822 Message-ID header of the last message in the thread, e.g. `<CA...@mail.gmail.com>`. */
  lastMessageId: string;
}

export interface Interviewer {
  firstName: string;
  fullName: string;
  email: string;
  title: string;
  zone: string;
  /** Interview hours in the interviewer's zone. Default 09:00 to 17:00. */
  hours?: { start: string; end: string };
  /** Interviews per calendar day in the interviewer's zone. Default 4. */
  dailyCap?: number;
}

export interface InterviewSpec {
  applicationId: string;
  jobInterviewId: string;
  candidateId: string;
  jobName: string;
  kitId: string;
  durationMin: number;
  /** 1 for the first booking; bumped by each reschedule. Part of every ledger key and the event id. */
  attempt: number;
}

export interface Recruiter {
  firstName: string;
  fullName: string;
  title: string;
  email: string;
}

/** Calendar free/busy keyed by calendar id (`primary` is Sam's own). An entry with `error` is busy throughout. */
export type FreeBusyResult = Record<string, { busy: TimeWindow[] } | { error: string }>;

export type InterviewerResponse = 'needsAction' | 'accepted' | 'declined';

/** A Calendar attendee as the API returns it; extra keys (responseStatus, organizer...) pass through. */
export interface Attendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  [key: string]: unknown;
}

export interface PlanInput {
  candidate: Candidate;
  interviewer: Interviewer;
  spec: InterviewSpec;
  recruiter: Recruiter;
  /** The candidate's stated availability. Empty means none received yet. */
  candidateWindows: TimeWindow[];
  freeBusy: FreeBusyResult;
  /**
   * The span the free/busy read covered. Slots outside it are never proposed, because busy time there is
   * unknown. Default: `now` to `now` + 7 days, the spec's first read.
   */
  freeBusyRange?: TimeWindow;
  /** ISO 8601 with offset. */
  now: string;
  /** Set once a hold exists: the interviewer attendee's `responseStatus`. */
  interviewerResponse?: InterviewerResponse;
  /** The held event's slot. Required with `interviewerResponse`, because free/busy then shows the hold as busy. */
  heldSlot?: Slot;
  /** The held event's attendees as last read. Default: the interviewer alone. */
  heldAttendees?: Attendee[];
  /** The event's `hangoutLink`. Required to confirm the candidate. */
  meetLink?: string;
  disclosureLine: string;
  candidateSummary: string;
  rulingLine?: string;
  recruiterAdditions?: string;
  /** Interviews already on each interviewer's calendar, for the daily cap. */
  existingBookings?: Record<string, TimeWindow[]>;
  /** Names that must never appear in this candidate's mail. */
  otherCandidateNames?: string[];
}
