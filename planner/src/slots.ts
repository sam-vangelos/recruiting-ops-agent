/**
 * Slot finding (WORKFLOW.md step 1 and "Time"). A candidate start is proposed only when every rule holds:
 * inside one of the candidate's windows; inside the span the free/busy read covered and the search
 * horizon; at least two hours after `now`; on a Monday-to-Friday calendar day in the interviewer's zone,
 * starting and ending inside their interview hours on that same day; clear of every busy block on Sam's
 * primary calendar and the interviewer's by 15 minutes either side; on a day the interviewer has fewer
 * than their cap of interviews; and starting on a 30-minute boundary of the interviewer's wall clock.
 * A calendar whose free/busy errored, or that is missing from the result, is busy throughout.
 */
import type { PlanInput, Slot, TimeWindow } from './types.js';
import { DAY_MS, MINUTE_MS, normalizeZone, parseInstant, toZonedIso, wallParts } from './time.js';

export const DEFAULT_HOURS = { start: '09:00', end: '17:00' } as const;
export const DEFAULT_DAILY_CAP = 4;
export const BUFFER_MIN = 15;
export const LEAD_TIME_MIN = 120;
export const ALIGN_MIN = 30;
export const MAX_SLOTS = 10;
/** Every UTC offset in use is a multiple of 15 minutes, so stepping by 15 visits every 30-minute wall boundary. */
const STEP_MS = 15 * MINUTE_MS;

export type SlotInput = Pick<PlanInput, 'candidateWindows' | 'freeBusy' | 'interviewer' | 'spec' | 'now' | 'existingBookings' | 'freeBusyRange'>;

export interface SlotOptions {
  /** Search horizon from `now`, in days. 7 by default; the planner extends to 14 when nothing fits. */
  horizonDays?: number;
  /** Default 10. */
  limit?: number;
}

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

interface Span {
  start: number;
  end: number;
}

const span = (w: TimeWindow, what: string): Span => {
  const start = parseInstant(w.start, `${what} start`);
  const end = parseInstant(w.end, `${what} end`);
  if (end <= start) throw new Error(`${what} ends (${w.end}) before it starts (${w.start})`);
  return { start, end };
};

/** Looks a calendar up by id, case-insensitively for email ids. Missing means unknown, which means busy. */
function calendarEntry(freeBusy: PlanInput['freeBusy'], id: string) {
  if (freeBusy[id] !== undefined) return freeBusy[id];
  const key = Object.keys(freeBusy).find((k) => k.toLowerCase() === id.toLowerCase());
  return key === undefined ? undefined : freeBusy[key];
}

function lookup<T>(rec: Record<string, T> | undefined, email: string): T | undefined {
  if (rec === undefined) return undefined;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === email.toLowerCase());
  return key === undefined ? undefined : rec[key];
}

export function findSlots(input: SlotInput, opts: SlotOptions = {}): Slot[] {
  const horizonDays = opts.horizonDays ?? 7;
  const limit = opts.limit ?? MAX_SLOTS;
  const iv = input.interviewer;
  const zone = normalizeZone(iv.zone);
  const hours = iv.hours ?? DEFAULT_HOURS;
  if (!HM.test(hours.start) || !HM.test(hours.end) || hours.end <= hours.start) {
    throw new Error(`interviewer hours must be HH:MM with start before end; got ${JSON.stringify(hours)}`);
  }
  const cap = iv.dailyCap ?? DEFAULT_DAILY_CAP;
  if (!Number.isInteger(cap) || cap < 0) throw new Error(`interviewer dailyCap must be a whole number; got ${cap}`);
  const durationMs = input.spec.durationMin * MINUTE_MS;
  if (!Number.isInteger(input.spec.durationMin) || input.spec.durationMin <= 0) {
    throw new Error(`interview duration must be a positive whole number of minutes; got ${input.spec.durationMin}`);
  }

  const now = parseInstant(input.now, 'now');
  const range = input.freeBusyRange ? span(input.freeBusyRange, 'freeBusyRange') : { start: now, end: now + 7 * DAY_MS };
  const earliest = Math.max(now + LEAD_TIME_MIN * MINUTE_MS, range.start);
  const latest = Math.min(now + horizonDays * DAY_MS, range.end);
  if (latest <= earliest) return [];

  const busy: Span[] = [];
  for (const id of ['primary', iv.email]) {
    const entry = calendarEntry(input.freeBusy, id);
    if (entry === undefined || 'error' in entry) return [];
    entry.busy.forEach((b, i) => busy.push(span(b, `freeBusy ${id} busy[${i}]`)));
  }
  const bookings = (lookup(input.existingBookings, iv.email) ?? []).map((b, i) => span(b, `existingBookings[${i}]`));
  busy.push(...bookings);

  const bookingsPerDay = new Map<string, number>();
  for (const b of bookings) {
    const d = wallParts(b.start, zone).date;
    bookingsPerDay.set(d, (bookingsPerDay.get(d) ?? 0) + 1);
  }

  const buffer = BUFFER_MIN * MINUTE_MS;
  const starts = new Set<number>();
  for (const [i, w] of input.candidateWindows.entries()) {
    const win = span(w, `candidateWindows[${i}]`);
    const from = Math.max(win.start, earliest);
    const to = Math.min(win.end, latest);
    for (let s = Math.ceil(from / STEP_MS) * STEP_MS; s + durationMs <= to; s += STEP_MS) {
      const e = s + durationMs;
      const a = wallParts(s, zone);
      if (Number(a.minute) % ALIGN_MIN !== 0) continue;
      if (a.isoWeekday > 5) continue;
      const b = wallParts(e, zone);
      if (b.date !== a.date || a.hm < hours.start || b.hm > hours.end) continue;
      if ((bookingsPerDay.get(a.date) ?? 0) >= cap) continue;
      if (busy.some((x) => s < x.end + buffer && e > x.start - buffer)) continue;
      starts.add(s);
    }
  }

  return [...starts]
    .sort((x, y) => x - y)
    .slice(0, limit)
    .map((s) => ({ start: toZonedIso(s, zone), end: toZonedIso(s + durationMs, zone) }));
}
