/**
 * Step 2a and 4a payloads (WORKFLOW.md, "Provider calls, in order"): the hold event on Sam's primary
 * calendar, interviewer only, with a Meet; and the later patch that adds the candidate to the same event.
 */
import { createHash } from 'node:crypto';
import type { Rendered } from './templates.js';
import type { Attendee, Candidate, Interviewer, InterviewSpec, Slot } from './types.js';
import { normalizeZone, toZonedIso } from './time.js';

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv';

function base32hex(bytes: Uint8Array): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32HEX[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * Client-chosen event id: `sched` + base32hex(sha256 of the three ids). Only `0-9a-v`, 57 characters,
 * so Google accepts it (base32hex, 5 to 1024), and a retried insert gets 409 instead of a second event.
 */
export function holdEventId(applicationId: string, jobInterviewId: string, attempt: number): string {
  if (applicationId === '' || jobInterviewId === '') throw new Error('holdEventId needs both ids');
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt must be a whole number from 1; got ${attempt}`);
  const digest = createHash('sha256').update(JSON.stringify([applicationId, jobInterviewId, attempt]), 'utf8').digest();
  return `sched${base32hex(digest)}`;
}

export interface EventTime {
  dateTime: string;
  timeZone: string;
}

export interface HoldEventBody {
  id: string;
  summary: string;
  description: string;
  start: EventTime;
  end: EventTime;
  attendees: Array<{ email: string; displayName: string }>;
  conferenceData: { createRequest: { requestId: string; conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  guestsCanModify: false;
  reminders: { useDefault: true };
}

export interface HoldEventRequest {
  method: 'POST';
  path: 'calendars/primary/events';
  query: { conferenceDataVersion: '1'; sendUpdates: 'all' };
  body: HoldEventBody;
}

export interface HoldEventInput {
  interviewer: Interviewer;
  spec: InterviewSpec;
}

/** POST calendars/primary/events?conferenceDataVersion=1&sendUpdates=all — summary and description from `interviewer-invite`. */
export function buildHoldEvent(input: HoldEventInput, slot: Slot, descriptionFromTemplate: Rendered): HoldEventRequest {
  const summary = descriptionFromTemplate.summary;
  if (summary === undefined || summary.trim() === '') throw new Error('the hold event needs a summary from the interviewer-invite template');
  const zone = normalizeZone(input.interviewer.zone);
  const id = holdEventId(input.spec.applicationId, input.spec.jobInterviewId, input.spec.attempt);
  return {
    method: 'POST',
    path: 'calendars/primary/events',
    query: { conferenceDataVersion: '1', sendUpdates: 'all' },
    body: {
      id,
      summary,
      description: descriptionFromTemplate.body,
      start: { dateTime: toZonedIso(slot.start, zone), timeZone: zone },
      end: { dateTime: toZonedIso(slot.end, zone), timeZone: zone },
      attendees: [{ email: input.interviewer.email, displayName: input.interviewer.fullName }],
      conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      guestsCanModify: false,
      reminders: { useDefault: true },
    },
  };
}

export interface CandidateAddPatch {
  query: { sendUpdates: 'all' };
  body: { attendees: Attendee[] };
}

/**
 * PATCH body for step 4a. Calendar replaces the whole attendee list on PATCH, so the existing attendees
 * are carried verbatim (keeping the interviewer's `responseStatus`) and the candidate is appended once.
 */
export function buildCandidateAddPatch(existingAttendees: Attendee[], candidate: Pick<Candidate, 'email' | 'fullName'>): CandidateAddPatch {
  const present = existingAttendees.some((a) => a.email.trim().toLowerCase() === candidate.email.trim().toLowerCase());
  const attendees = present ? existingAttendees.map((a) => ({ ...a })) : [...existingAttendees.map((a) => ({ ...a })), { email: candidate.email, displayName: candidate.fullName }];
  return { query: { sendUpdates: 'all' }, body: { attendees } };
}
