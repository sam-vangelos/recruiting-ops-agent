import crypto from 'node:crypto';

export const DEFAULT_TIMEZONE = 'America/Los_Angeles';

/**
 * Canonical Rails ActiveSupport / Greenhouse / Calendly timezone names to IANA identifiers.
 */
export const RAILS_TO_IANA_TZ: Record<string, string> = {
  'International Date Line West': 'Etc/GMT+12',
  'Midway Island': 'Pacific/Midway',
  'American Samoa': 'Pacific/Pago_Pago',
  'Hawaii': 'Pacific/Honolulu',
  'Alaska': 'America/Anchorage',
  'Pacific Time (US & Canada)': 'America/Los_Angeles',
  'Tijuana': 'America/Tijuana',
  'Mountain Time (US & Canada)': 'America/Denver',
  'Arizona': 'America/Phoenix',
  'Chihuahua': 'America/Chihuahua',
  'Mazatlan': 'America/Mazatlan',
  'Central Time (US & Canada)': 'America/Chicago',
  'Saskatchewan': 'America/Regina',
  'Guadalajara': 'America/Mexico_City',
  'Mexico City': 'America/Mexico_City',
  'Monterrey': 'America/Monterrey',
  'Central America': 'America/Guatemala',
  'Eastern Time (US & Canada)': 'America/New_York',
  'Indiana (East)': 'America/Indiana/Indianapolis',
  'Bogota': 'America/Bogota',
  'Lima': 'America/Lima',
  'Quito': 'America/Lima',
  'Atlantic Time (Canada)': 'America/Halifax',
  'Caracas': 'America/Caracas',
  'La Paz': 'America/La_Paz',
  'Santiago': 'America/Santiago',
  'Newfoundland': 'America/St_Johns',
  'Brasilia': 'America/Sao_Paulo',
  'Sao Paulo': 'America/Sao_Paulo',
  'Buenos Aires': 'America/Argentina/Buenos_Aires',
  'Georgetown': 'America/Guyana',
  'Greenland': 'America/Godthab',
  'Mid-Atlantic': 'Atlantic/South_Georgia',
  'Azores': 'Atlantic/Azores',
  'Cape Verde Is.': 'Atlantic/Cape_Verde',
  'Dublin': 'Europe/Dublin',
  'Edinburgh': 'Europe/London',
  'Lisbon': 'Europe/Lisbon',
  'London': 'Europe/London',
  'Casablanca': 'Africa/Casablanca',
  'Monrovia': 'Africa/Monrovia',
  'UTC': 'UTC',
  'GMT': 'UTC',
  'Belgrade': 'Europe/Belgrade',
  'Bratislava': 'Europe/Bratislava',
  'Budapest': 'Europe/Budapest',
  'Ljubljana': 'Europe/Ljubljana',
  'Prague': 'Europe/Prague',
  'Sarajevo': 'Europe/Sarajevo',
  'Skopje': 'Europe/Skopje',
  'Warsaw': 'Europe/Warsaw',
  'Zagreb': 'Europe/Zagreb',
  'Brussels': 'Europe/Brussels',
  'Copenhagen': 'Europe/Copenhagen',
  'Madrid': 'Europe/Madrid',
  'Paris': 'Europe/Paris',
  'Amsterdam': 'Europe/Amsterdam',
  'Berlin': 'Europe/Berlin',
  'Bern': 'Europe/Zurich',
  'Zurich': 'Europe/Zurich',
  'Rome': 'Europe/Rome',
  'Stockholm': 'Europe/Stockholm',
  'Vienna': 'Europe/Vienna',
  'West Central Africa': 'Africa/Lagos',
  'Bucharest': 'Europe/Bucharest',
  'Cairo': 'Africa/Cairo',
  'Helsinki': 'Europe/Helsinki',
  'Kyiv': 'Europe/Kyiv',
  'Riga': 'Europe/Riga',
  'Sofia': 'Europe/Sofia',
  'Tallinn': 'Europe/Tallinn',
  'Vilnius': 'Europe/Vilnius',
  'Athens': 'Europe/Athens',
  'Istanbul': 'Europe/Istanbul',
  'Minsk': 'Europe/Minsk',
  'Jerusalem': 'Asia/Jerusalem',
  'Harare': 'Africa/Harare',
  'Pretoria': 'Africa/Johannesburg',
  'Kaliningrad': 'Europe/Kaliningrad',
  'Moscow': 'Europe/Moscow',
  'St. Petersburg': 'Europe/Moscow',
  'Volgograd': 'Europe/Volgograd',
  'Samara': 'Europe/Samara',
  'Kuwait': 'Asia/Kuwait',
  'Riyadh': 'Asia/Riyadh',
  'Nairobi': 'Africa/Nairobi',
  'Baghdad': 'Asia/Baghdad',
  'Tehran': 'Asia/Tehran',
  'Abu Dhabi': 'Asia/Dubai',
  'Muscat': 'Asia/Muscat',
  'Baku': 'Asia/Baku',
  'Tbilisi': 'Asia/Tbilisi',
  'Yerevan': 'Asia/Yerevan',
  'Kabul': 'Asia/Kabul',
  'Ekaterinburg': 'Asia/Yekaterinburg',
  'Islamabad': 'Asia/Karachi',
  'Karachi': 'Asia/Karachi',
  'Tashkent': 'Asia/Tashkent',
  'Chennai': 'Asia/Kolkata',
  'Kolkata': 'Asia/Kolkata',
  'Mumbai': 'Asia/Kolkata',
  'New Delhi': 'Asia/Kolkata',
  'Sri Jayawardenepura': 'Asia/Colombo',
  'Kathmandu': 'Asia/Kathmandu',
  'Astana': 'Asia/Almaty',
  'Dhaka': 'Asia/Dhaka',
  'Urumqi': 'Asia/Urumqi',
  'Rangoon': 'Asia/Yangon',
  'Bangkok': 'Asia/Bangkok',
  'Hanoi': 'Asia/Bangkok',
  'Jakarta': 'Asia/Jakarta',
  'Krasnoyarsk': 'Asia/Krasnoyarsk',
  'Novosibirsk': 'Asia/Novosibirsk',
  'Beijing': 'Asia/Shanghai',
  'Chongqing': 'Asia/Chongqing',
  'Hong Kong': 'Asia/Hong_Kong',
  'Kuala Lumpur': 'Asia/Kuala_Lumpur',
  'Perth': 'Australia/Perth',
  'Singapore': 'Asia/Singapore',
  'Taipei': 'Asia/Taipei',
  'Ulaanbaatar': 'Asia/Ulaanbaatar',
  'Irkutsk': 'Asia/Irkutsk',
  'Osaka': 'Asia/Tokyo',
  'Sapporo': 'Asia/Tokyo',
  'Tokyo': 'Asia/Tokyo',
  'Seoul': 'Asia/Seoul',
  'Yakutsk': 'Asia/Yakutsk',
  'Adelaide': 'Australia/Adelaide',
  'Darwin': 'Australia/Darwin',
  'Brisbane': 'Australia/Brisbane',
  'Canberra': 'Australia/Sydney',
  'Melbourne': 'Australia/Melbourne',
  'Sydney': 'Australia/Sydney',
  'Hobart': 'Australia/Hobart',
  'Vladivostok': 'Asia/Vladivostok',
  'Guam': 'Pacific/Guam',
  'Port Moresby': 'Pacific/Port_Moresby',
  'Auckland': 'Pacific/Auckland',
  'Wellington': 'Pacific/Auckland',
  'Fiji': 'Pacific/Fiji',
  'Toronto': 'America/Toronto',
  'Vancouver': 'America/Vancouver',
  'Montreal': 'America/Toronto',
};

const ABBREV_TO_IANA: Record<string, string> = {
  PT: 'America/Los_Angeles',
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  MT: 'America/Denver',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  CT: 'America/Chicago',
  CST: 'America/Chicago',
  CDT: 'America/Chicago',
  ET: 'America/New_York',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  UTC: 'UTC',
  GMT: 'UTC',
  BST: 'Europe/London',
  CET: 'Europe/Berlin',
  CEST: 'Europe/Berlin',
  IST: 'Asia/Kolkata',
  JST: 'Asia/Tokyo',
  KST: 'Asia/Seoul',
  SGT: 'Asia/Singapore',
  AEST: 'Australia/Sydney',
  AEDT: 'Australia/Sydney',
};

const CASE_INSENSITIVE_RAILS = new Map<string, string>(
  Object.entries(RAILS_TO_IANA_TZ).map(([k, v]) => [k.toLowerCase(), v]),
);

export const US_COMPANY_HOLIDAYS = new Set<string>([
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03',
  '2026-09-07',
  '2026-11-26',
  '2026-11-27',
  '2026-12-24',
  '2026-12-25',
  '2027-01-01',
]);

export function isValidIanaTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves any Greenhouse/Rails timezone string, abbreviation, or IANA zone to a valid IANA zone,
 * falling back to America/Los_Angeles when unknown.
 */
export function resolveTimezone(input?: string | null, fallback: string = DEFAULT_TIMEZONE): string {
  if (typeof input !== 'string' || !input.trim()) return fallback;
  const cleaned = input
    .trim()
    .replace(/^\(GMT[+-]\d{2}:\d{2}\)\s*/i, '')
    .replace(/^\(UTC[+-]\d{2}:\d{2}\)\s*/i, '')
    .trim();
  if (!cleaned) return fallback;

  if (RAILS_TO_IANA_TZ[cleaned]) return RAILS_TO_IANA_TZ[cleaned];
  const ci = CASE_INSENSITIVE_RAILS.get(cleaned.toLowerCase());
  if (ci) return ci;

  const upper = cleaned.toUpperCase();
  if (ABBREV_TO_IANA[upper]) return ABBREV_TO_IANA[upper];

  if (isValidIanaTimezone(cleaned)) return cleaned;
  return fallback;
}

export interface LocalTimeParts {
  year: number;
  month: number;
  day: number;
  weekday: string; // 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun'
  hour: number;
  minute: number;
  second: number;
  dateStr: string; // YYYY-MM-DD
}

export function getLocalParts(utcMsOrIso: number | string | Date, timeZoneInput?: string | null): LocalTimeParts {
  const tz = resolveTimezone(timeZoneInput);
  const ms = typeof utcMsOrIso === 'number'
    ? utcMsOrIso
    : utcMsOrIso instanceof Date
      ? utcMsOrIso.getTime()
      : Date.parse(utcMsOrIso);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid timestamp: ${String(utcMsOrIso)}`);
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour === '24' ? '0' : map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  const dateStr = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    year,
    month,
    day,
    weekday: map.weekday,
    hour,
    minute,
    second,
    dateStr,
  };
}

/**
 * Converts a local wall-clock time (year, month, day, hour, minute, second) in `timeZone`
 * to a UTC epoch timestamp in milliseconds, handling DST transitions accurately.
 */
export function localWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number = 0,
  second: number = 0,
  timeZoneInput?: string | null,
): number {
  const tz = resolveTimezone(timeZoneInput);
  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  let guess = targetAsUtc;
  for (let i = 0; i < 4; i++) {
    const actual = getLocalParts(guess, tz);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0,
    );
    const diff = targetAsUtc - actualAsUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

export function addLocalCalendarDays(
  year: number,
  month: number,
  day: number,
  daysToAdd: number,
): { year: number; month: number; day: number; dateStr: string } {
  const d = new Date(Date.UTC(year, month - 1, day + daysToAdd, 12, 0, 0));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dom = d.getUTCDate();
  return {
    year: y,
    month: m,
    day: dom,
    dateStr: `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dom).padStart(2, '0')}`,
  };
}

export function isBusinessDay(
  utcMsOrIso: number | string | Date,
  timeZoneInput?: string | null,
  holidays: Set<string> = US_COMPANY_HOLIDAYS,
): boolean {
  const parts = getLocalParts(utcMsOrIso, timeZoneInput);
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false;
  if (holidays.has(parts.dateStr)) return false;
  return true;
}

export interface WorkingHoursOptions {
  businessHoursOnly?: boolean;
  workdayStartHour?: number;
  workdayStartMinute?: number;
  workdayEndHour?: number;
  workdayEndMinute?: number;
  holidays?: Set<string>;
}

/**
 * Adds `hours` of working time in `timeZoneInput` (Mon-Fri, excluding holidays).
 * - When `businessHoursOnly` is false (default for Step 2/7/10 12h/24h/48h weekday timers):
 *   counts elapsed hours across Monday 00:00 through Friday 24:00 in the recipient's local zone,
 *   pausing across weekends and company holidays.
 * - When `businessHoursOnly` is true (used for WF4 09:00-17:00 working-hour floor):
 *   counts elapsed minutes strictly inside `[workdayStart, workdayEnd)` on business days.
 */
export function addWorkingHours(
  startIsoOrMs: string | number | Date,
  hours: number,
  timeZoneInput?: string | null,
  options: WorkingHoursOptions = {},
): string {
  const tz = resolveTimezone(timeZoneInput);
  const holidays = options.holidays ?? US_COMPANY_HOLIDAYS;
  const startMs = typeof startIsoOrMs === 'number'
    ? startIsoOrMs
    : startIsoOrMs instanceof Date
      ? startIsoOrMs.getTime()
      : Date.parse(startIsoOrMs);
  if (!Number.isFinite(startMs)) {
    throw new Error(`Invalid start timestamp: ${String(startIsoOrMs)}`);
  }
  if (hours <= 0) return new Date(startMs).toISOString();

  const businessHoursOnly = options.businessHoursOnly ?? false;
  const startHour = options.workdayStartHour ?? 9;
  const startMinute = options.workdayStartMinute ?? 0;
  const endHour = options.workdayEndHour ?? 17;
  const endMinute = options.workdayEndMinute ?? 0;

  let remainingMs = Math.round(hours * 3_600_000);
  let cursorMs = startMs;

  let guard = 0;
  while (remainingMs > 0 && guard++ < 10_000) {
    const parts = getLocalParts(cursorMs, tz);
    const isBiz = parts.weekday !== 'Sat' && parts.weekday !== 'Sun' && !holidays.has(parts.dateStr);
    if (!isBiz) {
      const nextDay = addLocalCalendarDays(parts.year, parts.month, parts.day, 1);
      cursorMs = localWallClockToUtcMs(
        nextDay.year,
        nextDay.month,
        nextDay.day,
        businessHoursOnly ? startHour : 0,
        businessHoursOnly ? startMinute : 0,
        0,
        tz,
      );
      continue;
    }

    const windowStartMs = businessHoursOnly
      ? localWallClockToUtcMs(parts.year, parts.month, parts.day, startHour, startMinute, 0, tz)
      : localWallClockToUtcMs(parts.year, parts.month, parts.day, 0, 0, 0, tz);
    const nextDay = addLocalCalendarDays(parts.year, parts.month, parts.day, 1);
    const windowEndMs = businessHoursOnly
      ? localWallClockToUtcMs(parts.year, parts.month, parts.day, endHour, endMinute, 0, tz)
      : localWallClockToUtcMs(nextDay.year, nextDay.month, nextDay.day, 0, 0, 0, tz);

    if (cursorMs < windowStartMs) {
      cursorMs = windowStartMs;
      continue;
    }
    if (cursorMs >= windowEndMs) {
      cursorMs = localWallClockToUtcMs(
        nextDay.year,
        nextDay.month,
        nextDay.day,
        businessHoursOnly ? startHour : 0,
        businessHoursOnly ? startMinute : 0,
        0,
        tz,
      );
      continue;
    }

    const availableMs = windowEndMs - cursorMs;
    if (remainingMs <= availableMs) {
      cursorMs += remainingMs;
      remainingMs = 0;
    } else {
      remainingMs -= availableMs;
      cursorMs = localWallClockToUtcMs(
        nextDay.year,
        nextDay.month,
        nextDay.day,
        businessHoursOnly ? startHour : 0,
        businessHoursOnly ? startMinute : 0,
        0,
        tz,
      );
    }
  }

  return new Date(cursorMs).toISOString();
}

export function deterministicDelayMinutes(seed: string | number, minMinutes = 60, maxMinutes = 180): number {
  const digest = crypto.createHash('sha256').update(String(seed), 'utf8').digest();
  const uint32 = digest.readUInt32BE(0);
  const span = maxMinutes - minMinutes + 1;
  return minMinutes + (uint32 % span);
}

export function deterministicJitter47(applicationId: string | number): number {
  const digest = crypto.createHash('sha256').update(String(applicationId), 'utf8').digest();
  return digest.readUInt32BE(0) % 47;
}

export interface DeliberationWindowInput {
  interview_ends_at?: string | number | Date | null;
  scorecard_submitted_at?: string | number | Date | null;
  candidate_tz?: string | null;
  application_id?: string | number;
  scorecard_id?: string | number;
  random_minutes?: number;
  rng?: () => number;
  holidays?: Set<string>;
}

export interface DeliberationWindowResult {
  fire_at: string;
  fire_at_ms: number;
  candidate_tz: string;
  delay_minutes: number;
  clamped_or_rolled: boolean;
  local_date: string;
  local_time: string;
}

/**
 * Ruling 2 Deliberation Calculator (Business-Hours Clamping [08:30, 17:30] Mon-Fri in candidate's local timezone):
 * Adds `random[60, 180]` minutes after `max(interview_ends_at, scorecard_submitted_at)` and clamps/rolls forward
 * into `08:30-17:30` Mon-Fri (excluding US company holidays) in the candidate's local timezone
 * (or `America/Los_Angeles` when unknown).
 */
export function computeDeliberationFireAt(input: DeliberationWindowInput): DeliberationWindowResult {
  const tz = resolveTimezone(input.candidate_tz, DEFAULT_TIMEZONE);
  const holidays = input.holidays ?? US_COMPANY_HOLIDAYS;

  const anchorCandidates: number[] = [];
  for (const raw of [input.interview_ends_at, input.scorecard_submitted_at]) {
    if (raw !== undefined && raw !== null) {
      const ms = typeof raw === 'number' ? raw : raw instanceof Date ? raw.getTime() : Date.parse(raw);
      if (Number.isFinite(ms)) anchorCandidates.push(ms);
    }
  }
  if (anchorCandidates.length === 0) {
    throw new Error('computeDeliberationFireAt requires interview_ends_at or scorecard_submitted_at.');
  }
  const anchorMs = Math.max(...anchorCandidates);

  let delayMinutes: number;
  if (typeof input.random_minutes === 'number' && Number.isFinite(input.random_minutes)) {
    delayMinutes = Math.min(180, Math.max(60, Math.round(input.random_minutes)));
  } else if (typeof input.rng === 'function') {
    const r = Math.max(0, Math.min(0.9999999, input.rng()));
    delayMinutes = 60 + Math.floor(r * 121);
  } else if (input.application_id !== undefined || input.scorecard_id !== undefined) {
    delayMinutes = deterministicDelayMinutes(
      `${input.application_id ?? ''}:${input.scorecard_id ?? ''}`,
      60,
      180,
    );
  } else {
    delayMinutes = 60 + crypto.randomInt(0, 121);
  }

  const rawTargetMs = anchorMs + delayMinutes * 60_000;
  const clamped = clampIntoBusinessWindow(rawTargetMs, tz, {
    startHour: 8,
    startMinute: 30,
    endHour: 17,
    endMinute: 30,
    holidays,
  });

  const finalParts = getLocalParts(clamped.ms, tz);
  return {
    fire_at: new Date(clamped.ms).toISOString(),
    fire_at_ms: clamped.ms,
    candidate_tz: tz,
    delay_minutes: delayMinutes,
    clamped_or_rolled: clamped.clamped,
    local_date: finalParts.dateStr,
    local_time: `${String(finalParts.hour).padStart(2, '0')}:${String(finalParts.minute).padStart(2, '0')}`,
  };
}

export function clampIntoBusinessWindow(
  targetMs: number,
  timeZoneInput?: string | null,
  options: {
    startHour?: number;
    startMinute?: number;
    endHour?: number;
    endMinute?: number;
    holidays?: Set<string>;
  } = {},
): { ms: number; clamped: boolean } {
  const tz = resolveTimezone(timeZoneInput);
  const startHour = options.startHour ?? 8;
  const startMinute = options.startMinute ?? 30;
  const endHour = options.endHour ?? 17;
  const endMinute = options.endMinute ?? 30;
  const holidays = options.holidays ?? US_COMPANY_HOLIDAYS;

  let cursorMs = targetMs;
  let clamped = false;
  let overflowMinutes = 0;

  for (let i = 0; i < 30; i++) {
    const parts = getLocalParts(cursorMs, tz);
    const isBiz = parts.weekday !== 'Sat' && parts.weekday !== 'Sun' && !holidays.has(parts.dateStr);
    const dayStartMs = localWallClockToUtcMs(parts.year, parts.month, parts.day, startHour, startMinute, 0, tz);
    const dayEndMs = localWallClockToUtcMs(parts.year, parts.month, parts.day, endHour, endMinute, 0, tz);

    if (!isBiz) {
      clamped = true;
      const next = addLocalCalendarDays(parts.year, parts.month, parts.day, 1);
      cursorMs = localWallClockToUtcMs(next.year, next.month, next.day, startHour, startMinute, 0, tz) + overflowMinutes * 60_000;
      continue;
    }

    if (cursorMs < dayStartMs) {
      clamped = true;
      cursorMs = dayStartMs + overflowMinutes * 60_000;
      overflowMinutes = 0;
      if (cursorMs > dayEndMs) {
        cursorMs = dayEndMs;
      }
      return { ms: cursorMs, clamped };
    }

    if (cursorMs > dayEndMs) {
      clamped = true;
      // Preserve bounded offset into the next business day's window (capped so it stays inside [start, end])
      const windowSpanMinutes = Math.max(60, Math.floor((dayEndMs - dayStartMs) / 60_000));
      overflowMinutes = Math.min(
        windowSpanMinutes - 1,
        Math.max(0, Math.floor((cursorMs - dayEndMs) / 60_000) % 121),
      );
      let next = addLocalCalendarDays(parts.year, parts.month, parts.day, 1);
      for (let d = 0; d < 14; d++) {
        const probeMs = localWallClockToUtcMs(next.year, next.month, next.day, 12, 0, 0, tz);
        const probeParts = getLocalParts(probeMs, tz);
        if (probeParts.weekday !== 'Sat' && probeParts.weekday !== 'Sun' && !holidays.has(next.dateStr)) {
          break;
        }
        next = addLocalCalendarDays(next.year, next.month, next.day, 1);
      }
      cursorMs = localWallClockToUtcMs(next.year, next.month, next.day, startHour, startMinute, 0, tz) + overflowMinutes * 60_000;
      overflowMinutes = 0;
      continue;
    }

    return { ms: cursorMs, clamped };
  }

  return { ms: cursorMs, clamped };
}

/**
 * ARCHITECTURE.md §3.2 Next-Business-Day Deliberation Formula:
 * - t_wall = interview_ended_at + 18 hours
 * - t_work = addWorkingHours(interview_ended_at, 4, candidate_tz, { businessHoursOnly: true, workdayStartHour: 9, workdayEndHour: 17 })
 * - t_next_day = start of next calendar day in candidate_tz
 * - t_floor = max(t_wall, t_work, t_next_day)
 * - Advance d to first business day (Mon-Fri, non-holiday) in candidate_tz where d_14:13_local >= t_floor
 * - base_time = max(t_floor, d_10:00_local)
 * - fire_at = base_time + (sha256_uint32(String(application_id)) % 47) minutes (guaranteed within [10:00, 15:00] local time)
 */
export function computeNextBusinessDayDeliberationFireAt(input: {
  interview_ended_at: string | number | Date;
  candidate_tz?: string | null;
  application_id: string | number;
  holidays?: Set<string>;
}): DeliberationWindowResult {
  const tz = resolveTimezone(input.candidate_tz, DEFAULT_TIMEZONE);
  const holidays = input.holidays ?? US_COMPANY_HOLIDAYS;
  const endedMs = typeof input.interview_ended_at === 'number'
    ? input.interview_ended_at
    : input.interview_ended_at instanceof Date
      ? input.interview_ended_at.getTime()
      : Date.parse(input.interview_ended_at);
  if (!Number.isFinite(endedMs)) {
    throw new Error(`Invalid interview_ended_at: ${String(input.interview_ended_at)}`);
  }

  const tWall = endedMs + 18 * 3600_000;
  const tWork = Date.parse(
    addWorkingHours(endedMs, 4, tz, {
      businessHoursOnly: true,
      workdayStartHour: 9,
      workdayEndHour: 17,
      holidays,
    }),
  );
  const endedParts = getLocalParts(endedMs, tz);
  const nextCalDay = addLocalCalendarDays(endedParts.year, endedParts.month, endedParts.day, 1);
  const tNextDay = localWallClockToUtcMs(nextCalDay.year, nextCalDay.month, nextCalDay.day, 0, 0, 0, tz);

  const tFloor = Math.max(tWall, tWork, tNextDay);
  const jitter = deterministicJitter47(input.application_id);

  let dayCursor = getLocalParts(tFloor, tz);
  for (let i = 0; i < 30; i++) {
    const dateStr = `${String(dayCursor.year).padStart(4, '0')}-${String(dayCursor.month).padStart(2, '0')}-${String(dayCursor.day).padStart(2, '0')}`;
    const probeMs = localWallClockToUtcMs(dayCursor.year, dayCursor.month, dayCursor.day, 12, 0, 0, tz);
    const probeParts = getLocalParts(probeMs, tz);
    const isBiz = probeParts.weekday !== 'Sat' && probeParts.weekday !== 'Sun' && !holidays.has(dateStr);
    const d1413 = localWallClockToUtcMs(dayCursor.year, dayCursor.month, dayCursor.day, 14, 13, 0, tz);
    if (isBiz && d1413 >= tFloor) {
      const d1000 = localWallClockToUtcMs(dayCursor.year, dayCursor.month, dayCursor.day, 10, 0, 0, tz);
      const baseTime = Math.max(tFloor, d1000);
      const fireAtMs = baseTime + jitter * 60_000;
      const finalParts = getLocalParts(fireAtMs, tz);
      return {
        fire_at: new Date(fireAtMs).toISOString(),
        fire_at_ms: fireAtMs,
        candidate_tz: tz,
        delay_minutes: Math.round((fireAtMs - endedMs) / 60_000),
        clamped_or_rolled: true,
        local_date: finalParts.dateStr,
        local_time: `${String(finalParts.hour).padStart(2, '0')}:${String(finalParts.minute).padStart(2, '0')}`,
      };
    }
    const next = addLocalCalendarDays(dayCursor.year, dayCursor.month, dayCursor.day, 1);
    dayCursor = { ...dayCursor, year: next.year, month: next.month, day: next.day, dateStr: next.dateStr };
  }

  throw new Error('Unable to find business day for deliberation window.');
}

/**
 * Missed-window guard at fire time (ARCHITECTURE.md §3.2):
 * If the Executor wakes up outside the allowed candidate local business window (e.g. after 17:30 local
 * or on a weekend/holiday), rolls `fire_at` forward to the next business day in `candidate_tz` instead of firing at night.
 */
export function guardDeliberationFireTime(params: {
  now_ms: number;
  scheduled_fire_at_ms: number;
  candidate_tz?: string | null;
  application_id?: string | number;
  window_start_hour?: number;
  window_start_minute?: number;
  window_end_hour?: number;
  window_end_minute?: number;
  holidays?: Set<string>;
}): { can_fire_now: boolean; next_fire_at?: string } {
  const tz = resolveTimezone(params.candidate_tz, DEFAULT_TIMEZONE);
  const holidays = params.holidays ?? US_COMPANY_HOLIDAYS;
  const startHour = params.window_start_hour ?? 8;
  const startMin = params.window_start_minute ?? 30;
  const endHour = params.window_end_hour ?? 17;
  const endMin = params.window_end_minute ?? 30;

  if (params.now_ms < params.scheduled_fire_at_ms) {
    return { can_fire_now: false, next_fire_at: new Date(params.scheduled_fire_at_ms).toISOString() };
  }

  const nowParts = getLocalParts(params.now_ms, tz);
  const isBiz = nowParts.weekday !== 'Sat' && nowParts.weekday !== 'Sun' && !holidays.has(nowParts.dateStr);
  const windowStart = localWallClockToUtcMs(nowParts.year, nowParts.month, nowParts.day, startHour, startMin, 0, tz);
  const windowEnd = localWallClockToUtcMs(nowParts.year, nowParts.month, nowParts.day, endHour, endMin, 0, tz);

  if (isBiz && params.now_ms >= windowStart && params.now_ms <= windowEnd) {
    return { can_fire_now: true };
  }

  // Advance to the next business day's start + jitter
  const jitter = params.application_id !== undefined ? deterministicJitter47(params.application_id) : 0;
  let cursor = nowParts.hour > endHour || (nowParts.hour === endHour && nowParts.minute > endMin) || !isBiz
    ? addLocalCalendarDays(nowParts.year, nowParts.month, nowParts.day, 1)
    : { year: nowParts.year, month: nowParts.month, day: nowParts.day, dateStr: nowParts.dateStr };

  for (let i = 0; i < 30; i++) {
    const probeMs = localWallClockToUtcMs(cursor.year, cursor.month, cursor.day, 12, 0, 0, tz);
    const probeParts = getLocalParts(probeMs, tz);
    if (probeParts.weekday !== 'Sat' && probeParts.weekday !== 'Sun' && !holidays.has(cursor.dateStr)) {
      const baseMs = localWallClockToUtcMs(cursor.year, cursor.month, cursor.day, startHour, startMin, 0, tz);
      return {
        can_fire_now: false,
        next_fire_at: new Date(baseMs + jitter * 60_000).toISOString(),
      };
    }
    cursor = addLocalCalendarDays(cursor.year, cursor.month, cursor.day, 1);
  }

  return { can_fire_now: false };
}
