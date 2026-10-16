import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, permitted } from './gate.mjs';
import {
  buildRoster,
  classifyCalendarEvent,
  parseApplicationIdFromDescription,
  renderDayView,
  rosterCalendarWindow,
} from './roster.mjs';

test('gate allowlist includes search_my_applications and search_my_candidates with pilot job scoping', () => {
  assert.ok(ALLOWED.includes('mcp__greenhouse-recruiter__search_my_applications'));
  assert.ok(ALLOWED.includes('mcp__greenhouse-recruiter__search_my_candidates'));
  assert.equal(permitted('mcp__greenhouse-recruiter__search_my_applications', { job_ids: [5149015004], status: 'active' }), true);
  assert.equal(permitted('mcp__greenhouse-recruiter__search_my_applications', { job_ids: [999] }), false);
  assert.equal(permitted('mcp__greenhouse-recruiter__search_my_candidates', { candidate_ids: [101, 102] }), true);
  assert.equal(permitted('mcp__greenhouse-recruiter__search_my_candidates', { job_ids: [5149015004] }), true);
  assert.equal(permitted('mcp__greenhouse-recruiter__search_my_candidates', { job_ids: [999] }), false);
});

test('rosterCalendarWindow spans from min(today 00:00 Pacific, now - 24h) through today + 7 days', () => {
  const now = Date.parse('2026-10-16T18:30:00.000Z'); // 2026-10-16 11:30 PDT
  const win = rosterCalendarWindow(now, 'America/Los_Angeles');
  assert.equal(win.today_date_pacific, '2026-10-16');
  assert.equal(win.today_start, '2026-10-16T07:00:00.000Z');
  assert.equal(win.past_24h, '2026-10-15T18:30:00.000Z');
  assert.equal(win.start_time, '2026-10-15T18:30:00.000Z');
  assert.equal(win.end_time, '2026-10-23T07:00:00.000Z');
});

test('classifyCalendarEvent recognises Calendly, Greenhouse-created round, and hand-made candidate events by shape', () => {
  const known = new Set(['handmade.candidate@example.com']);

  const calendly = classifyCalendarEvent({
    id: 'cal-calendly-1',
    status: 'confirmed',
    summary: 'Alex Rivera: Initial Chat - USA',
    description: 'Event Name: Initial Chat - USA\nInvitee Email: alex.rivera@example.com\n',
    start: { dateTime: '2026-10-16T17:00:00Z' },
    end: { dateTime: '2026-10-16T17:30:00Z' },
    attendees: [{ email: 'sam.vangelos@turing.com', responseStatus: 'accepted' }],
  }, known);
  assert.equal(calendly.kind, 'calendly_screen');
  assert.equal(calendly.candidate_name, 'Alex Rivera');
  assert.equal(calendly.candidate_email, 'alex.rivera@example.com');

  const ghRound = classifyCalendarEvent({
    id: 'cal-gh-1',
    status: 'confirmed',
    summary: 'Interview Priya Patel for Field Engineer',
    description: 'Take a look at the interview guide: https://app4.greenhouse.io/guides/999?application_id=7000000002',
    start: { dateTime: '2026-10-16T19:00:00Z' },
    end: { dateTime: '2026-10-16T19:45:00Z' },
    attendees: [
      { email: 'khiem.doan@turing.com', responseStatus: 'needsAction' },
      { email: 'schedule@lily.greenhouse.io', responseStatus: 'accepted' },
    ],
  }, known);
  assert.equal(ghRound.kind, 'greenhouse_round');
  assert.equal(ghRound.application_id, '7000000002');
  assert.equal(ghRound.interviewer_acceptance, 'needsAction');
  assert.equal(ghRound.candidate_confirmed, false);

  const handmade = classifyCalendarEvent({
    id: 'cal-hm-1',
    status: 'confirmed',
    summary: 'Fictional Technical Deep Dive',
    description: 'Custom sync',
    start: { dateTime: '2026-10-16T21:00:00Z' },
    end: { dateTime: '2026-10-16T21:45:00Z' },
    attendees: [
      { email: 'khiem.doan@turing.com', responseStatus: 'accepted' },
      { email: 'handmade.candidate@example.com', displayName: 'Jordan Lee', responseStatus: 'accepted' },
    ],
  }, known);
  assert.equal(handmade.kind, 'handmade_candidate');
  assert.equal(handmade.candidate_email, 'handmade.candidate@example.com');
  assert.equal(handmade.interviewer_acceptance, 'accepted');
  assert.equal(handmade.candidate_confirmed, true);
  assert.equal(parseApplicationIdFromDescription('https://app4.greenhouse.io/guides/1?application_id=1234567890'), '1234567890');
});

test('roster joins on all three keys in order of confidence and surfaces all five discrepancy kinds', () => {
  const applications = {
    ok: true,
    data: [
      // App 1: joined by Key 1 (interview.external_event_id === event.id)
      {
        id: 7000000001,
        candidate_id: 9001,
        status: 'active',
        current_stage: { id: 10, name: 'HM Screen' },
        needs_decision: false,
        last_activity_at: '2026-10-16T12:00:00Z',
      },
      // App 2: joined by Key 2 (application_id parsed from event description) + time_mismatch
      {
        id: 7000000002,
        candidate_id: 9002,
        status: 'active',
        current_stage: { id: 20, name: 'Coding Challenge' },
        needs_decision: false,
        last_activity_at: '2026-10-16T13:00:00Z',
      },
      // App 3: joined by Key 3 (candidate email === Greenhouse email)
      {
        id: 7000000003,
        candidate_id: 9003,
        status: 'active',
        current_stage: { id: 30, name: 'System Design' },
        needs_decision: false,
        last_activity_at: '2026-10-16T14:00:00Z',
      },
      // App 4: to_be_scheduled_no_event
      {
        id: 7000000004,
        candidate_id: 9004,
        status: 'active',
        current_stage: { id: 10, name: 'HM Screen' },
        needs_decision: false,
        last_activity_at: '2026-10-16T10:00:00Z',
      },
      // App 5: complete_needs_decision (JOB.md step-1 trigger)
      {
        id: 7000000005,
        candidate_id: 9005,
        status: 'active',
        current_stage: { id: 1, name: 'Recruiter Screen' },
        needs_decision: true,
        last_activity_at: '2026-10-16T15:00:00Z',
      },
    ],
  };

  const candidates = {
    ok: true,
    data: [
      { id: 9001, first_name: 'Candidate', last_name: 'One', email_addresses: [{ value: 'cand1@example.com' }] },
      { id: 9002, first_name: 'Candidate', last_name: 'Two', email_addresses: [{ value: 'cand2@example.com' }] },
      { id: 9003, first_name: 'Candidate', last_name: 'Three', email_addresses: [{ value: 'cand3@example.com' }] },
      { id: 9004, first_name: 'Candidate', last_name: 'Four', email_addresses: [{ value: 'cand4@example.com' }] },
      { id: 9005, first_name: 'Candidate', last_name: 'Five', email_addresses: [{ value: 'cand5@example.com' }] },
    ],
  };

  const interviews = {
    ok: true,
    data: [
      // App 1 interview with external_event_id matching cal-ext-1
      {
        id: 8001,
        application_id: 7000000001,
        external_event_id: 'cal-ext-1',
        starts_at: '2026-10-16T18:00:00.000Z',
        ends_at: '2026-10-16T18:45:00.000Z',
        status: 'scheduled',
      },
      // App 2 interview with no external_event_id, matched by application_id in description, but with a time mismatch
      {
        id: 8002,
        application_id: 7000000002,
        external_event_id: null,
        starts_at: '2026-10-16T19:00:00.000Z',
        ends_at: '2026-10-16T19:45:00.000Z',
        status: 'scheduled',
      },
      // App 3 interview with no external_event_id, matched by candidate email
      {
        id: 8003,
        application_id: 7000000003,
        external_event_id: null,
        starts_at: '2026-10-16T21:00:00.000Z',
        ends_at: '2026-10-16T21:45:00.000Z',
        status: 'scheduled',
      },
      // App 4 interview to_be_scheduled with no event
      {
        id: 8004,
        application_id: 7000000004,
        external_event_id: null,
        starts_at: null,
        ends_at: null,
        status: 'to_be_scheduled',
      },
      // App 5 interview complete while application needs_decision is true
      {
        id: 8005,
        application_id: 7000000005,
        external_event_id: null,
        starts_at: '2026-10-15T20:00:00.000Z',
        ends_at: '2026-10-15T20:30:00.000Z',
        status: 'complete',
      },
    ],
  };

  const events = {
    events: [
      // Matches App 1 via Key 1 (external_event_id)
      {
        id: 'cal-ext-1',
        status: 'confirmed',
        summary: 'Interview Candidate One for Field Engineer',
        description: 'Guide: https://app4.greenhouse.io/guides/1?application_id=7000000001',
        start: { dateTime: '2026-10-16T18:00:00.000Z' },
        end: { dateTime: '2026-10-16T18:45:00.000Z' },
        attendees: [
          { email: 'khiem.doan@turing.com', responseStatus: 'accepted' },
          { email: 'cand1@example.com', responseStatus: 'accepted' },
          { email: 'schedule@lily.greenhouse.io', responseStatus: 'accepted' },
        ],
      },
      // Matches App 2 via Key 2 (application_id in description), shifted by 30m -> triggers time_mismatch
      {
        id: 'cal-desc-2',
        status: 'confirmed',
        summary: 'Interview Candidate Two for Field Engineer',
        description: 'Guide: https://app4.greenhouse.io/guides/2?application_id=7000000002',
        start: { dateTime: '2026-10-16T19:30:00.000Z' },
        end: { dateTime: '2026-10-16T20:15:00.000Z' },
        attendees: [
          { email: 'khiem.doan@turing.com', responseStatus: 'needsAction' },
          { email: 'schedule@lily.greenhouse.io', responseStatus: 'accepted' },
        ],
      },
      // Matches App 3 via Key 3 (candidate_email)
      {
        id: 'cal-email-3',
        status: 'confirmed',
        summary: 'System Design — Candidate Three',
        description: 'Manual calendar hold',
        start: { dateTime: '2026-10-16T21:00:00.000Z' },
        end: { dateTime: '2026-10-16T21:45:00.000Z' },
        attendees: [
          { email: 'khiem.doan@turing.com', responseStatus: 'accepted' },
          { email: 'cand3@example.com', responseStatus: 'accepted' },
        ],
      },
      // Greenhouse-shaped event with no matching Greenhouse interview row -> triggers event_no_greenhouse_row
      {
        id: 'cal-orphan-gh',
        status: 'confirmed',
        summary: 'Interview Mystery Candidate for Field Engineer',
        description: 'Guide: https://app4.greenhouse.io/guides/9?application_id=7000000999',
        start: { dateTime: '2026-10-16T22:00:00.000Z' },
        end: { dateTime: '2026-10-16T22:45:00.000Z' },
        attendees: [
          { email: 'khiem.doan@turing.com', responseStatus: 'accepted' },
          { email: 'schedule@lily.greenhouse.io', responseStatus: 'accepted' },
        ],
      },
      // Calendly screen with no Greenhouse application -> triggers screen_no_application
      {
        id: 'cal-screen-unmatched',
        status: 'confirmed',
        summary: 'Unmatched Screen: Initial Chat - USA',
        description: 'Invitee Email: unmatched.screen@example.com',
        start: { dateTime: '2026-10-16T16:00:00.000Z' },
        end: { dateTime: '2026-10-16T16:30:00.000Z' },
        attendees: [{ email: 'sam.vangelos@turing.com', responseStatus: 'accepted' }],
      },
    ],
  };

  const threads = [
    { id: 'thread-cand1', candidate_email: 'cand1@example.com', last_message_at: '2026-10-16T17:00:00.000Z' },
  ];

  const roster = buildRoster({ applications, interviews, candidates, events, threads });

  const byApp = new Map(roster.candidates.filter(c => c.application_id).map(c => [c.application_id, c]));
  assert.equal(byApp.get('7000000001').interviews[0].matched_by, 'external_event_id');
  assert.equal(byApp.get('7000000001').interviews[0].interviewer_acceptance, 'accepted');
  assert.equal(byApp.get('7000000001').interviews[0].candidate_confirmed, true);
  assert.deepEqual(byApp.get('7000000001').threads, ['thread-cand1']);

  assert.equal(byApp.get('7000000002').interviews[0].matched_by, 'application_id');
  assert.equal(byApp.get('7000000002').interviews[0].interviewer_acceptance, 'needsAction');
  assert.equal(byApp.get('7000000002').interviews[0].candidate_confirmed, false);

  assert.equal(byApp.get('7000000003').interviews[0].matched_by, 'candidate_email');
  assert.equal(byApp.get('7000000003').interviews[0].interviewer_acceptance, 'accepted');
  assert.equal(byApp.get('7000000003').interviews[0].candidate_confirmed, true);

  // Verify all 5 discrepancy kinds are detected
  const discrepancyKinds = new Set(roster.discrepancies.map(d => d.kind));
  assert.deepEqual(discrepancyKinds, new Set([
    'time_mismatch',
    'event_no_greenhouse_row',
    'screen_no_application',
    'to_be_scheduled_no_event',
    'complete_needs_decision',
  ]));

  // Verify day view orders today's events chronologically with interviewer acceptance and candidate confirmation state
  const dayView = renderDayView(roster, { now: Date.parse('2026-10-16T18:00:00.000Z') });
  assert.equal(dayView.date_pacific, '2026-10-16');
  assert.deepEqual(
    dayView.events.map(e => [e.calendar_event_id, e.interviewer_acceptance, e.candidate_confirmed]),
    [
      ['cal-screen-unmatched', 'accepted', true],
      ['cal-ext-1', 'accepted', true],
      ['cal-desc-2', 'needsAction', false],
      ['cal-email-3', 'accepted', true],
    ],
  );
});
