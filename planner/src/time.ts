/**
 * Every zone conversion in the planner goes through here, and every one goes through `Intl`. There is
 * no wall-clock string arithmetic: instants are compared and offset as epoch milliseconds, and wall-clock
 * fields are only ever read out of `Intl.DateTimeFormat` for a named IANA zone (WORKFLOW.md, "Time").
 */

/** Greenhouse's zone names that are not IANA ids, mapped to IANA. */
const GREENHOUSE_ZONES: Record<string, string> = {
  'Eastern Time (US & Canada)': 'America/New_York',
  'Central Time (US & Canada)': 'America/Chicago',
  'Mountain Time (US & Canada)': 'America/Denver',
  'Pacific Time (US & Canada)': 'America/Los_Angeles',
  'Asia/Calcutta': 'Asia/Kolkata',
  Bogota: 'America/Bogota',
  Brasilia: 'America/Sao_Paulo',
  London: 'Europe/London',
};

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Parses an ISO 8601 instant that carries an explicit offset; anything else throws. */
export function parseInstant(iso: string, what = 'time'): number {
  const ms = Date.parse(iso);
  if (typeof iso !== 'string' || !ISO_WITH_OFFSET.test(iso) || Number.isNaN(ms)) {
    throw new Error(`${what} must be an ISO 8601 date-time with an offset, e.g. 2026-10-09T13:30:00-07:00; got ${JSON.stringify(iso)}`);
  }
  return ms;
}

/**
 * Greenhouse zone string or IANA id → canonical IANA id. Offsets ("+05:30", "UTC-4") and abbreviations
 * ("ET") are refused: a zone must be a name that carries its own daylight-saving rules.
 */
export function normalizeZone(s: string): string {
  if (typeof s !== 'string' || s.trim() === '') throw new Error('time zone is empty');
  const z = s.trim();
  const mapped = GREENHOUSE_ZONES[z];
  if (mapped !== undefined) return mapped;
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(z) || (!z.includes('/') && z !== 'UTC')) {
    throw new Error(`unknown time zone ${JSON.stringify(s)}: expected an IANA id like America/New_York or a Greenhouse zone name`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
  } catch {
    throw new Error(`unknown time zone ${JSON.stringify(s)}: expected an IANA id like America/New_York or a Greenhouse zone name`);
  }
  // Keep the caller's id rather than ICU's resolved one: ICU canonicalises to legacy names (Asia/Kolkata
  // resolves to Asia/Calcutta, Europe/Kyiv to Europe/Kiev). Only the letter case is corrected, where ICU lists the id.
  const known = Intl.supportedValuesOf('timeZone');
  if (known.includes(z)) return z;
  return known.find((k) => k.toLowerCase() === z.toLowerCase()) ?? z;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(zone: string, key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = `${zone}|${key}`;
  let f = formatters.get(k);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, ...opts });
    formatters.set(k, f);
  }
  return f;
}

export interface WallParts {
  /** YYYY-MM-DD in the zone. */
  date: string;
  /** HH:MM, 24-hour, in the zone. */
  hm: string;
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  /** 1 = Monday ... 7 = Sunday. */
  isoWeekday: number;
  /** "+HH:MM" / "-HH:MM" for this instant in the zone. */
  offset: string;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The wall-clock fields of an instant in a zone, read out of Intl. */
export function wallParts(at: number | string, zone: string): WallParts {
  const ms = typeof at === 'number' ? at : parseInstant(at);
  const parts = fmt(zone, 'parts', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
    timeZoneName: 'longOffset',
  }).formatToParts(ms);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  const gmt = get('timeZoneName'); // "GMT-07:00", "GMT+05:30", or "GMT" for zero
  const offset = gmt === 'GMT' ? '+00:00' : gmt.replace(/^GMT/, '');
  if (!/^[+-]\d{2}:\d{2}$/.test(offset)) throw new Error(`Intl gave an unreadable offset ${JSON.stringify(gmt)} for ${zone}`);
  const weekday = WEEKDAYS[get('weekday')];
  if (weekday === undefined) throw new Error(`Intl gave an unreadable weekday for ${zone}`);
  const [year, month, day, hour, minute, second] = (['year', 'month', 'day', 'hour', 'minute', 'second'] as const).map(get) as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return { date: `${year}-${month}-${day}`, hm: `${hour}:${minute}`, year, month, day, hour, minute, second, isoWeekday: weekday, offset };
}

/** The same instant written as ISO 8601 with the zone's offset at that instant, e.g. 2026-10-09T13:30:00-07:00. */
export function toZonedIso(at: number | string, zone: string): string {
  const p = wallParts(at, zone);
  return `${p.date}T${p.hm}:${p.second}${p.offset}`;
}

/** "Eastern Time", "India Standard Time". Falls back to the IANA id where Intl only has a GMT offset (UTC). */
export function zoneNoun(zone: string, at: number | string = Date.now()): string {
  const ms = typeof at === 'number' ? at : parseInstant(at);
  const name = fmt(zone, 'generic', { timeZoneName: 'longGeneric' })
    .formatToParts(ms)
    .find((p) => p.type === 'timeZoneName')?.value;
  return name === undefined || /^GMT/.test(name) ? zone : name;
}

interface Clock {
  weekday: string;
  monthDay: string;
  year: string;
  clock: string;
  period: string;
}

function clockParts(ms: number, zone: string): Clock {
  const parts = fmt(zone, 'clock', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(ms);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return {
    weekday: get('weekday'),
    monthDay: `${get('month')} ${get('day')}`,
    year: get('year'),
    clock: `${get('hour')}:${get('minute')}`,
    period: get('dayPeriod').toLowerCase(),
  };
}

/** "Friday, October 9 at 4:30 pm Eastern Time". */
export function formatTime(iso: string, zone: string): string {
  const ms = parseInstant(iso);
  const c = clockParts(ms, zone);
  return `${c.weekday}, ${c.monthDay} at ${c.clock} ${c.period} ${zoneNoun(zone, ms)}`;
}

/**
 * "Friday, October 9, 2026, 1:30 to 2:00 pm Pacific Time"; "11:30 am to 12:00 pm" when the period
 * changes; both dates written out when the window crosses midnight in the zone.
 */
export function formatWindow(startIso: string, endIso: string, zone: string): string {
  const s = parseInstant(startIso, 'window start');
  const e = parseInstant(endIso, 'window end');
  if (e <= s) throw new Error(`window end ${endIso} is not after its start ${startIso}`);
  const a = clockParts(s, zone);
  const b = clockParts(e, zone);
  const noun = zoneNoun(zone, s);
  const dayA = `${a.weekday}, ${a.monthDay}, ${a.year}`;
  const dayB = `${b.weekday}, ${b.monthDay}, ${b.year}`;
  if (dayA !== dayB) return `${dayA}, ${a.clock} ${a.period} to ${dayB}, ${b.clock} ${b.period} ${noun}`;
  if (a.period === b.period) return `${dayA}, ${a.clock} to ${b.clock} ${b.period} ${noun}`;
  return `${dayA}, ${a.clock} ${a.period} to ${b.clock} ${b.period} ${noun}`;
}

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
