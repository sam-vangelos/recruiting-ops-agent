#!/usr/bin/env node
// Roster builder:
// Joins Greenhouse active applications + interviews + candidates with primary Google Calendar events
// on three keys in order of confidence:
//   1. interview.external_event_id === calendarEvent.id
//   2. application_id parsed from calendarEvent.description
//   3. candidate email === Greenhouse candidate email_addresses

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GREENHOUSE_SCHEDULER_EMAIL = 'schedule@lily.greenhouse.io';
const SAM_EMAIL = 'sam.vangelos@turing.com';

const CALENDLY_TITLE_RE = /^(.+?):\s*Initial Chat\s*-\s*USA\b/i;
const INVITEE_EMAIL_RE = /Invitee Email:\s*([^\s\n<>]+@[^\s\n<>]+)/i;
const GH_INTERVIEW_TITLE_RE = /^Interview\s+(.+?)\s+for\s+(.+)$/i;
const APPLICATION_ID_URL_RE = /[?&]application_id=(\d+)\b/i;
const APPLICATION_ID_TEXT_RE = /\bapplication_id\s*[=:]\s*(\d+)\b/i;

function unwrapList(input, key = 'data') {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input?.[key])) return input[key];
  if (Array.isArray(input?.events)) return input.events;
  return [];
}

function normEmail(email) {
  return typeof email === 'string' && email.includes('@') ? email.trim().toLowerCase() : null;
}

function eventInstant(bound) {
  if (!bound) return null;
  if (typeof bound === 'string') return bound;
  return bound.dateTime ?? bound.date ?? null;
}

function parseMs(isoString) {
  if (typeof isoString !== 'string' || !isoString) return NaN;
  return Date.parse(isoString);
}

export function pacificDateString(instant = Date.now(), timeZone = 'America/Los_Angeles') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map(p => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function rosterCalendarWindow(now = Date.now(), timeZone = 'America/Los_Angeles') {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const dateStr = pacificDateString(nowMs, timeZone);
  // Compute 00:00:00 Pacific on dateStr
  const probeUtc = Date.parse(`${dateStr}T00:00:00Z`);
  const tzParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(probeUtc))
      .map(p => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(tzParts.year),
    Number(tzParts.month) - 1,
    Number(tzParts.day),
    Number(tzParts.hour),
    Number(tzParts.minute),
    Number(tzParts.second),
  );
  const offsetMs = asUtc - probeUtc;
  const todayStartMs = probeUtc - offsetMs;
  const past24hMs = nowMs - DAY;
  const startTimeMs = Math.min(todayStartMs, past24hMs);
  const endTimeMs = todayStartMs + 7 * DAY;
  return {
    today_date_pacific: dateStr,
    today_start: new Date(todayStartMs).toISOString(),
    past_24h: new Date(past24hMs).toISOString(),
    start_time: new Date(startTimeMs).toISOString(),
    end_time: new Date(endTimeMs).toISOString(),
  };
}

export function parseApplicationIdFromDescription(description) {
  if (typeof description !== 'string' || !description) return null;
  const urlMatch = description.match(APPLICATION_ID_URL_RE) ?? description.match(APPLICATION_ID_TEXT_RE);
  return urlMatch ? String(urlMatch[1]) : null;
}

export function classifyCalendarEvent(event, knownCandidateEmails = new Set()) {
  if (!event || typeof event !== 'object' || event.status === 'cancelled') return null;
  const id = event.id ? String(event.id) : null;
  const summary = String(event.summary ?? '').trim();
  const description = String(event.description ?? '');
  const startsAt = eventInstant(event.start ?? event.starts_at);
  const endsAt = eventInstant(event.end ?? event.ends_at);
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  const attendeeEmails = attendees.map(a => normEmail(a?.email)).filter(Boolean);

  // 1. Calendly event: title "<name>: Initial Chat - USA", description line "Invitee Email: <email>"
  const calendlyMatch = summary.match(CALENDLY_TITLE_RE);
  const inviteeEmailMatch = description.match(INVITEE_EMAIL_RE);
  if (calendlyMatch || inviteeEmailMatch) {
    const candidateName = calendlyMatch ? calendlyMatch[1].trim() : null;
    const inviteeEmail = normEmail(inviteeEmailMatch?.[1]) ??
      attendeeEmails.find(e => e !== SAM_EMAIL && !e.endsWith('@turing.com') && e !== GREENHOUSE_SCHEDULER_EMAIL) ??
      null;
    return {
      id,
      kind: 'calendly_screen',
      summary,
      starts_at: startsAt,
      ends_at: endsAt,
      application_id: parseApplicationIdFromDescription(description),
      candidate_name: candidateName,
      candidate_email: inviteeEmail,
      interviewer_acceptance: 'accepted',
      candidate_confirmed: true,
      interviewer_emails: [SAM_EMAIL],
      raw: event,
    };
  }

  // 2. Greenhouse-created round: title "Interview <name> for <job>", description carries application_id=<id>,
  // or attendees include schedule@lily.greenhouse.io
  const ghTitleMatch = summary.match(GH_INTERVIEW_TITLE_RE);
  const appIdFromDesc = parseApplicationIdFromDescription(description);
  const hasLilyAttendee = attendeeEmails.includes(GREENHOUSE_SCHEDULER_EMAIL);
  if (ghTitleMatch || appIdFromDesc || hasLilyAttendee) {
    const candidateName = ghTitleMatch ? ghTitleMatch[1].trim() : null;
    const candidateAttendee = attendees.find(a => {
      const e = normEmail(a?.email);
      return e && (knownCandidateEmails.has(e) || (!e.endsWith('@turing.com') && e !== GREENHOUSE_SCHEDULER_EMAIL && !e.endsWith('@resource.calendar.google.com')));
    });
    const candidateEmail = normEmail(candidateAttendee?.email);
    const interviewerAttendees = attendees.filter(a => {
      const e = normEmail(a?.email);
      return e && e !== GREENHOUSE_SCHEDULER_EMAIL && e !== candidateEmail && !e.endsWith('@resource.calendar.google.com');
    });
    const statuses = interviewerAttendees.map(a => a.responseStatus).filter(Boolean);
    let interviewerAcceptance = 'unknown';
    if (statuses.includes('declined')) interviewerAcceptance = 'declined';
    else if (statuses.length && statuses.every(s => s === 'accepted')) interviewerAcceptance = 'accepted';
    else if (statuses.includes('tentative')) interviewerAcceptance = 'tentative';
    else if (statuses.includes('needsAction')) interviewerAcceptance = 'needsAction';

    return {
      id,
      kind: 'greenhouse_round',
      summary,
      starts_at: startsAt,
      ends_at: endsAt,
      application_id: appIdFromDesc,
      candidate_name: candidateName,
      candidate_email: candidateEmail,
      interviewer_acceptance: interviewerAcceptance,
      candidate_confirmed: Boolean(candidateEmail && candidateAttendee?.responseStatus !== 'declined'),
      interviewer_emails: interviewerAttendees.map(a => normEmail(a.email)).filter(Boolean),
      raw: event,
    };
  }

  // 3. Hand-made event with a candidate email as attendee
  const matchedCandidateAttendee = attendees.find(a => {
    const e = normEmail(a?.email);
    return e && knownCandidateEmails.has(e);
  });
  if (matchedCandidateAttendee) {
    const candidateEmail = normEmail(matchedCandidateAttendee.email);
    const interviewerAttendees = attendees.filter(a => {
      const e = normEmail(a?.email);
      return e && e !== candidateEmail && e !== GREENHOUSE_SCHEDULER_EMAIL && !e.endsWith('@resource.calendar.google.com');
    });
    const statuses = interviewerAttendees.map(a => a.responseStatus).filter(Boolean);
    let interviewerAcceptance = 'unknown';
    if (statuses.includes('declined')) interviewerAcceptance = 'declined';
    else if (statuses.length && statuses.every(s => s === 'accepted')) interviewerAcceptance = 'accepted';
    else if (statuses.includes('tentative')) interviewerAcceptance = 'tentative';
    else if (statuses.includes('needsAction')) interviewerAcceptance = 'needsAction';

    return {
      id,
      kind: 'handmade_candidate',
      summary,
      starts_at: startsAt,
      ends_at: endsAt,
      application_id: null,
      candidate_name: matchedCandidateAttendee.displayName ?? null,
      candidate_email: candidateEmail,
      interviewer_acceptance: interviewerAcceptance,
      candidate_confirmed: matchedCandidateAttendee.responseStatus !== 'declined',
      interviewer_emails: interviewerAttendees.map(a => normEmail(a.email)).filter(Boolean),
      raw: event,
    };
  }

  return null;
}

function candidateDisplayName(candidate, fallbackName = null) {
  if (!candidate) return fallbackName;
  if (typeof candidate.name === 'string' && candidate.name.trim()) return candidate.name.trim();
  const full = [candidate.first_name, candidate.last_name].filter(Boolean).join(' ').trim();
  return full || fallbackName;
}

function extractCandidateEmails(candidate, application) {
  const emails = new Set();
  for (const src of [candidate, application, application?.candidate]) {
    if (!src || typeof src !== 'object') continue;
    if (typeof src.email === 'string') {
      const e = normEmail(src.email);
      if (e) emails.add(e);
    }
    for (const item of Array.isArray(src.email_addresses) ? src.email_addresses : []) {
      const e = normEmail(typeof item === 'string' ? item : item?.value ?? item?.email);
      if (e) emails.add(e);
    }
    for (const item of Array.isArray(src.emails) ? src.emails : []) {
      const e = normEmail(typeof item === 'string' ? item : item?.value ?? item?.email);
      if (e) emails.add(e);
    }
  }
  return [...emails];
}

function latestIso(...timestamps) {
  let best = null;
  let bestMs = -Infinity;
  for (const ts of timestamps.flat()) {
    const ms = parseMs(ts);
    if (Number.isFinite(ms) && ms > bestMs) {
      bestMs = ms;
      best = new Date(ms).toISOString();
    }
  }
  return best;
}

export function buildRoster({
  applications = [],
  interviews = [],
  candidates = [],
  events = [],
  threads = [],
} = {}) {
  const appRows = unwrapList(applications);
  const interviewRows = unwrapList(interviews);
  const candidateRows = unwrapList(candidates);
  const eventRows = unwrapList(events);
  const threadRows = Array.isArray(threads) ? threads : [];

  const candidateById = new Map();
  const candidateByAppId = new Map();
  for (const c of candidateRows) {
    if (c?.id !== undefined && c?.id !== null) candidateById.set(String(c.id), c);
    for (const appId of Array.isArray(c?.application_ids) ? c.application_ids : []) {
      candidateByAppId.set(String(appId), c);
    }
  }

  // Build application records keyed by application_id
  const appMap = new Map();
  const emailToAppId = new Map();
  const knownCandidateEmails = new Set();

  for (const c of candidateRows) {
    for (const e of extractCandidateEmails(c, null)) knownCandidateEmails.add(e);
  }

  for (const app of appRows) {
    if (app?.status && String(app.status).toLowerCase() !== 'active') continue;
    const appId = String(app.id ?? app.application_id);
    const cand =
      (app.candidate_id !== undefined && app.candidate_id !== null ? candidateById.get(String(app.candidate_id)) : null) ??
      candidateByAppId.get(appId) ??
      app.candidate ??
      null;
    const emails = extractCandidateEmails(cand, app);
    for (const e of emails) {
      knownCandidateEmails.add(e);
      if (!emailToAppId.has(e)) emailToAppId.set(e, appId);
    }
    const stageName =
      typeof app.current_stage === 'string'
        ? app.current_stage
        : app.current_stage?.name ?? app.stage_name ?? app.stage ?? 'Unknown Stage';
    const needsDecision = Boolean(
      app.needs_decision === true ||
      app.current_stage?.needs_decision === true ||
      app.decision_pending === true,
    );

    appMap.set(appId, {
      application_id: appId,
      episode_id: `app:${appId}`,
      candidate_id: app.candidate_id ?? cand?.id ?? null,
      name: candidateDisplayName(cand, app.candidate_name ?? null),
      emails,
      stage: stageName,
      needs_decision: needsDecision,
      interviews: [],
      calendar_events: [],
      threads: [],
      last_contact: app.last_activity_at ?? cand?.last_activity ?? null,
    });
  }

  // Index interviews by id, external_event_id, and application_id
  const interviewByExternalEventId = new Map();
  const interviewsByAppId = new Map();
  const interviewRecordById = new Map();

  for (const row of interviewRows) {
    const intId = String(row.id);
    const appId = row.application_id !== undefined && row.application_id !== null ? String(row.application_id) : null;
    const extId = row.external_event_id ? String(row.external_event_id) : null;
    const record = {
      id: intId,
      application_id: appId,
      job_interview_id: row.job_interview_id ?? null,
      external_event_id: extId,
      status: row.status ?? 'unknown',
      starts_at: row.starts_at ?? eventInstant(row.start) ?? null,
      ends_at: row.ends_at ?? eventInstant(row.end) ?? null,
      calendar_event_id: null,
      matched_by: null,
      interviewer_acceptance: row.interviewer_acceptance ?? 'unknown',
      candidate_confirmed: Boolean(row.candidate_confirmed),
    };
    interviewRecordById.set(intId, record);
    if (extId) interviewByExternalEventId.set(extId, record);
    if (appId) {
      if (!interviewsByAppId.has(appId)) interviewsByAppId.set(appId, []);
      interviewsByAppId.get(appId).push(record);
      if (!appMap.has(appId)) {
        const cand = candidateByAppId.get(appId) ?? null;
        const emails = extractCandidateEmails(cand, null);
        for (const e of emails) {
          knownCandidateEmails.add(e);
          if (!emailToAppId.has(e)) emailToAppId.set(e, appId);
        }
        appMap.set(appId, {
          application_id: appId,
          episode_id: `app:${appId}`,
          candidate_id: cand?.id ?? null,
          name: candidateDisplayName(cand, null),
          emails,
          stage: 'Unknown Stage',
          needs_decision: false,
          interviews: [],
          calendar_events: [],
          threads: [],
          last_contact: row.updated_at ?? row.created_at ?? null,
        });
      }
      appMap.get(appId).interviews.push(record);
      appMap.get(appId).last_contact = latestIso(appMap.get(appId).last_contact, row.updated_at, row.created_at, row.starts_at);
    }
  }

  const discrepancies = [];
  const screenOnlyRecords = new Map();

  // Classify and join calendar events in order of confidence:
  // 1) interview.external_event_id === event.id
  // 2) application_id parsed from event description
  // 3) candidate email === Greenhouse candidate email
  for (const rawEvent of eventRows) {
    const classified = classifyCalendarEvent(rawEvent, knownCandidateEmails);
    if (!classified) continue;

    let matchedInterview = null;
    let matchedApp = null;
    let matchedBy = null;

    // Key 1: interview.external_event_id === event.id
    if (classified.id && interviewByExternalEventId.has(classified.id)) {
      matchedInterview = interviewByExternalEventId.get(classified.id);
      matchedApp = matchedInterview.application_id ? appMap.get(matchedInterview.application_id) : null;
      matchedBy = 'external_event_id';
    }

    // Key 2: application_id parsed from event description
    if (!matchedBy && classified.application_id) {
      matchedApp = appMap.get(String(classified.application_id)) ?? null;
      const appInterviews = interviewsByAppId.get(String(classified.application_id)) ?? [];
      matchedInterview = appInterviews.find(i => !i.calendar_event_id) ?? appInterviews[0] ?? null;
      if (matchedApp || matchedInterview) {
        matchedBy = 'application_id';
      }
    }

    // Key 3: candidate email matches Greenhouse email address
    if (!matchedBy && classified.candidate_email && emailToAppId.has(classified.candidate_email)) {
      const appId = emailToAppId.get(classified.candidate_email);
      matchedApp = appMap.get(appId) ?? null;
      const appInterviews = interviewsByAppId.get(appId) ?? [];
      matchedInterview = appInterviews.find(i => !i.calendar_event_id) ?? appInterviews[0] ?? null;
      matchedBy = 'candidate_email';
    }

    const calEntry = {
      id: classified.id,
      kind: classified.kind,
      summary: classified.summary,
      starts_at: classified.starts_at,
      ends_at: classified.ends_at,
      matched_by: matchedBy,
      application_id: matchedApp?.application_id ?? classified.application_id ?? null,
      interview_id: matchedInterview?.id ?? null,
      interviewer_acceptance: classified.interviewer_acceptance,
      candidate_confirmed: classified.candidate_confirmed,
    };

    if (matchedInterview) {
      matchedInterview.calendar_event_id = classified.id;
      matchedInterview.matched_by = matchedBy;
      matchedInterview.interviewer_acceptance = classified.interviewer_acceptance;
      matchedInterview.candidate_confirmed = classified.candidate_confirmed;

      // Check time_mismatch between Greenhouse interview row and Calendar event
      const ghStart = parseMs(matchedInterview.starts_at);
      const calStart = parseMs(classified.starts_at);
      const ghEnd = parseMs(matchedInterview.ends_at);
      const calEnd = parseMs(classified.ends_at);
      const startDiffers = Number.isFinite(ghStart) && Number.isFinite(calStart) && ghStart !== calStart;
      const endDiffers = Number.isFinite(ghEnd) && Number.isFinite(calEnd) && ghEnd !== calEnd;
      if (startDiffers || endDiffers) {
        discrepancies.push({
          kind: 'time_mismatch',
          application_id: matchedApp?.application_id ?? matchedInterview.application_id ?? null,
          interview_id: matchedInterview.id,
          calendar_event_id: classified.id,
          greenhouse_starts_at: matchedInterview.starts_at,
          calendar_starts_at: classified.starts_at,
          greenhouse_ends_at: matchedInterview.ends_at,
          calendar_ends_at: classified.ends_at,
        });
      }
    } else if (classified.kind === 'calendly_screen' && !matchedApp) {
      discrepancies.push({
        kind: 'screen_no_application',
        calendar_event_id: classified.id,
        candidate_name: classified.candidate_name,
        candidate_email: classified.candidate_email,
        starts_at: classified.starts_at,
      });
      const screenKey = classified.candidate_email ?? `event:${classified.id}`;
      if (!screenOnlyRecords.has(screenKey)) {
        screenOnlyRecords.set(screenKey, {
          application_id: null,
          episode_id: `screen:${screenKey}`,
          candidate_id: null,
          name: classified.candidate_name,
          emails: classified.candidate_email ? [classified.candidate_email] : [],
          stage: 'Calendly Screen (no Greenhouse application)',
          needs_decision: false,
          interviews: [],
          calendar_events: [],
          threads: [],
          last_contact: classified.starts_at,
        });
      }
      screenOnlyRecords.get(screenKey).calendar_events.push(calEntry);
      continue;
    } else if (classified.kind !== 'calendly_screen') {
      discrepancies.push({
        kind: 'event_no_greenhouse_row',
        application_id: matchedApp?.application_id ?? classified.application_id ?? null,
        calendar_event_id: classified.id,
        candidate_name: classified.candidate_name ?? matchedApp?.name ?? null,
        candidate_email: classified.candidate_email ?? null,
        starts_at: classified.starts_at,
      });
    }

    if (matchedApp) {
      if (!matchedApp.name && classified.candidate_name) matchedApp.name = classified.candidate_name;
      if (classified.candidate_email && !matchedApp.emails.includes(classified.candidate_email)) {
        matchedApp.emails.push(classified.candidate_email);
      }
      matchedApp.calendar_events.push(calEntry);
      matchedApp.last_contact = latestIso(matchedApp.last_contact, classified.starts_at);
    }
  }

  // Attach Gmail threads per candidate (by application_id or candidate_email)
  for (const t of threadRows) {
    const threadId = String(t.id ?? t.threadId ?? '');
    if (!threadId) continue;
    const appId =
      (t.application_id && appMap.has(String(t.application_id)) ? String(t.application_id) : null) ??
      (t.candidate_email && emailToAppId.has(normEmail(t.candidate_email)) ? emailToAppId.get(normEmail(t.candidate_email)) : null);
    if (appId && appMap.has(appId)) {
      const rec = appMap.get(appId);
      if (!rec.threads.includes(threadId)) rec.threads.push(threadId);
      rec.last_contact = latestIso(rec.last_contact, t.last_message_at, t.updated_at);
    }
  }

  // Check interview and application discrepancies:
  // - to_be_scheduled_no_event
  // - complete_needs_decision
  for (const rec of appMap.values()) {
    for (const intRec of rec.interviews) {
      if (intRec.status === 'to_be_scheduled' && !intRec.calendar_event_id) {
        discrepancies.push({
          kind: 'to_be_scheduled_no_event',
          application_id: rec.application_id,
          interview_id: intRec.id,
          stage: rec.stage,
        });
      }
    }
    const hasCompletedInterview = rec.interviews.some(i =>
      ['complete', 'completed', 'awaiting_feedback'].includes(String(i.status).toLowerCase()),
    );
    if (rec.needs_decision && (hasCompletedInterview || rec.interviews.length > 0)) {
      discrepancies.push({
        kind: 'complete_needs_decision',
        application_id: rec.application_id,
        stage: rec.stage,
        interview_ids: rec.interviews.map(i => i.id),
      });
    }
  }

  const candidatesList = [...appMap.values(), ...screenOnlyRecords.values()];
  return {
    candidates: candidatesList,
    discrepancies,
  };
}

export function renderDayView(roster, { now = Date.now(), timeZone = 'America/Los_Angeles' } = {}) {
  const targetDate = pacificDateString(now, timeZone);
  const items = [];
  for (const cand of roster?.candidates ?? []) {
    for (const ev of cand.calendar_events ?? []) {
      if (!ev.starts_at) continue;
      if (pacificDateString(ev.starts_at, timeZone) !== targetDate) continue;
      items.push({
        starts_at: ev.starts_at,
        ends_at: ev.ends_at,
        calendar_event_id: ev.id,
        kind: ev.kind,
        application_id: cand.application_id,
        candidate_name: cand.name,
        stage: cand.stage,
        interviewer_acceptance: ev.interviewer_acceptance,
        candidate_confirmed: ev.candidate_confirmed,
      });
    }
  }
  items.sort((a, b) => parseMs(a.starts_at) - parseMs(b.starts_at));
  return {
    date_pacific: targetDate,
    events: items,
  };
}
