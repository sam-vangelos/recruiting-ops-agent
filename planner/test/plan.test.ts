import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countWords } from '../src/guard.js';
import { InvalidInputError, plan, type GmailStep, type Plan } from '../src/plan.js';
import { loadTemplate } from '../src/templates.js';
import type { PlanInput } from '../src/types.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixture = (name: string): PlanInput => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as PlanInput;
const gmail = (p: Plan, step: string) => p.steps.find((s): s is GmailStep => s.step === step && s.kind === 'gmail')!;

const EVENT_ID = 'schedo1cmgo932ar7rgsj4d5it93hlokpgnp1f3e5v6f201g9tljr38rg';
const DISCLOSURE = "Scheduling for this interview is handled with Turing's AI assistant on Sam's behalf; reply here and Sam reads it directly.";
const THREAD = {
  to: ['priya.ramos@example.com'],
  subject: 'Re: Field Engineer, AI Labs at Turing: next steps',
  threadId: '19a0f1c2d3e4f5a6',
  inReplyTo: '<CAPRIYA0001.fixture@mail.gmail.com>',
  references: '<CAPRIYA0001.fixture@mail.gmail.com>',
};

const HOLD_DESCRIPTION = [
  'Hello Dana,',
  '',
  'Sam Vangelos has requested you to participate in the interview for Priya Ramos for the role of Field Engineer, AI Labs. Please respond to this invitation within 24 hours to confirm your participation.',
  '',
  "Your feedback is appreciated and requested to be shared within 24 hours after the interview by submitting your completed scorecard. You can view the candidate's resume and complete the scorecard using the link below.",
  '',
  'Interview Kit: https://app4.greenhouse.io/guides/900000000004/people/900000000003?application_id=900000000001',
  '',
  'If for any reason you need to reschedule please reach out to me as soon as possible.',
  '',
  'Interview Schedule',
  'Friday, October 9, 2026, 1:30 to 2:00 pm Pacific Time, Google Meet (Friday, October 9 at 4:30 pm Eastern Time for Priya, who is in Raleigh, NC).',
  'Priya is holding this slot pending your acceptance; once you accept, Sam adds Priya to this invite.',
  '',
  'Candidate summary: Priya leads field deployments for an inference platform and has shipped on-site integrations for three enterprise customers. Strong on debugging under customer pressure; wants more hands-on model work.',
  '',
  'Thank you for your participation!',
  'Sam',
].join('\n');

const HOLD_REPLY = [
  'Hey Priya,',
  '',
  "Great, thanks. I've put a hold with Dana for Friday, October 9 at 4:30 pm Eastern Time for a 30-minute Google Meet. As soon as Dana confirms on that end I'll send you the calendar invite with the link. If that time stops working for you, just say so and I'll find another.",
  '',
  'Best,',
  'Sam',
  '',
  DISCLOSURE,
].join('\n');

const CONFIRMATION = [
  'Hi Priya,',
  '',
  'Thank you for taking the time to continue the interview process with Turing. We are excited to keep getting to know you.',
  '',
  'Your video interview with Dana Okafor, Hiring Manager, AI Labs, is confirmed for Friday, October 9 at 4:30 pm Eastern Time (30 minutes).',
  '',
  'The interview is on Google Meet: https://meet.google.com/abc-defg-hij. A calendar invite with the same link is on its way separately. Please join a few minutes early to check that your camera and microphone work, and find a quiet spot so both sides can hear each other.',
  '',
  "Prepare your stories, wins, learnings, and, most importantly, questions in advance so you can share what makes you stand out for the position. We're always curious to see what you have learned about Turing; the newsroom and blog are a good start.",
  '',
  'If a short prep call beforehand would help, reply here and I will set one up.',
  '',
  "If you're running behind or can't make it, email me right away so I can let Dana Okafor know or move the time. We understand life happens and will happily reschedule if it means you'll be in a better place to interview.",
  '',
  'Best,',
  'Sam Vangelos',
  'Senior Recruiter',
  '',
  DISCLOSURE,
].join('\n');

const ALTERNATIVES = [
  'Hi Priya,',
  '',
  "Thanks for your patience. Dana Okafor, who runs the 30-minute conversation for the Field Engineer, AI Labs role, isn't free at the time we had in mind, but these are open, shown in your time zone:",
  '',
  '- Thursday, October 8 at 4:30 pm Eastern Time',
  '- Friday, October 9 at 12:00 pm Eastern Time',
  '- Monday, October 12 at 12:00 pm Eastern Time',
  '- Tuesday, October 13 at 2:30 pm Eastern Time',
  '- Wednesday, October 14 at 12:00 pm Eastern Time',
  '',
  "Reply with the one that suits you. If none of these work, tell me what does and I'll find another slot.",
  '',
  'Best,',
  'Sam',
  '',
  DISCLOSURE,
].join('\n');

test('plan-held: Friday 4:30 pm Eastern, the exact hold event and the exact candidate reply', () => {
  const p = plan(fixture('plan-held'));
  assert.equal(p.dispatchable, true, p.reasons.join('; '));
  assert.equal(p.fromState, 'detected');
  assert.deepEqual(p.stateTrail.map((t) => `${t.from}>${t.event}>${t.to}`), ['detected>availability_received>slot_proposed', 'slot_proposed>slot_found>slot_proposed']);
  assert.equal(p.nextState, 'slot_proposed');
  assert.equal(p.stateAfterDispatch, 'held');
  assert.deepEqual(p.freeBusyRequest, {
    timeMin: '2026-10-08T15:00:00.000Z',
    timeMax: '2026-10-15T15:00:00.000Z',
    items: [{ id: 'primary' }, { id: 'dana.okafor@turing.com' }],
  });
  assert.equal(p.searchedDays, 7);
  assert.equal(p.slots.length, 5);
  assert.deepEqual(p.chosenSlot, { start: '2026-10-09T13:30:00-07:00', end: '2026-10-09T14:00:00-07:00' });
  assert.deepEqual(p.times, {
    candidate: 'Friday, October 9 at 4:30 pm Eastern Time',
    interviewer: 'Friday, October 9 at 1:30 pm Pacific Time',
    interviewerWindow: 'Friday, October 9, 2026, 1:30 to 2:00 pm Pacific Time',
  });
  assert.deepEqual(p.steps.map((s) => [s.step, s.ledgerKey]), [
    ['hold-create', 'hold-create:900000000001:900000000002:1'],
    ['candidate-hold-reply', 'candidate-hold-reply:900000000001:900000000002:1'],
  ]);
  assert.deepEqual(p.steps[0], {
    step: 'hold-create',
    ledgerKey: 'hold-create:900000000001:900000000002:1',
    kind: 'calendar',
    request: {
      method: 'POST',
      path: 'calendars/primary/events',
      query: { conferenceDataVersion: '1', sendUpdates: 'all' },
      body: {
        id: EVENT_ID,
        summary: 'Virtual Interview with Priya Ramos for the role of Field Engineer, AI Labs',
        description: HOLD_DESCRIPTION,
        start: { dateTime: '2026-10-09T13:30:00-07:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-10-09T14:00:00-07:00', timeZone: 'America/Los_Angeles' },
        attendees: [{ email: 'dana.okafor@turing.com', displayName: 'Dana Okafor' }],
        conferenceData: { createRequest: { requestId: EVENT_ID, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
        guestsCanModify: false,
        reminders: { useDefault: true },
      },
    },
  });
  assert.deepEqual(p.steps[1], {
    step: 'candidate-hold-reply',
    ledgerKey: 'candidate-hold-reply:900000000001:900000000002:1',
    kind: 'gmail',
    template: 'candidate-hold-placed',
    message: { ...THREAD, body: HOLD_REPLY },
  });
  const reply = gmail(p, 'candidate-hold-reply').message.body;
  assert.match(reply, /Eastern Time/);
  assert.match(reply, /\bMeet\b/);
  assert.doesNotMatch(reply, /zoom/i);
  assert.deepEqual(p.guard.map((g) => [g.step, g.ok, g.checks.length]), [
    ['hold-create', true, 7],
    ['candidate-hold-reply', true, 7],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p, 'JSON-serialisable without loss');
});

test('plan-accepted: the candidate-add patch, the exact confirmation, nextState confirming', () => {
  const p = plan(fixture('plan-accepted'));
  assert.equal(p.dispatchable, true, p.reasons.join('; '));
  assert.equal(p.fromState, 'held');
  assert.equal(p.nextState, 'confirming');
  assert.equal(p.stateAfterDispatch, 'confirmed');
  assert.equal(p.eventId, EVENT_ID);
  assert.deepEqual(p.steps[0], {
    step: 'candidate-add',
    ledgerKey: 'candidate-add:900000000001:900000000002:1',
    kind: 'calendar',
    request: {
      method: 'PATCH',
      path: `calendars/primary/events/${EVENT_ID}`,
      query: { sendUpdates: 'all' },
      body: {
        attendees: [
          { email: 'dana.okafor@turing.com', displayName: 'Dana Okafor', responseStatus: 'accepted' },
          { email: 'priya.ramos@example.com', displayName: 'Priya Ramos' },
        ],
      },
    },
  });
  assert.deepEqual(p.steps[1], {
    step: 'candidate-confirmation',
    ledgerKey: 'candidate-confirmation:900000000001:900000000002:1',
    kind: 'gmail',
    template: 'candidate-confirmation',
    message: { ...THREAD, body: CONFIRMATION },
  });
  assert.match(CONFIRMATION, /Eastern Time/);
  assert.match(CONFIRMATION, /\bMeet\b/);
  assert.doesNotMatch(CONFIRMATION, /zoom/i);
  assert.deepEqual(p.deferred.map((d) => d.ledgerKey), [
    'gh-interview-create:900000000001:900000000002:1',
    'gh-note:900000000001:900000000002:1',
    'reminder:900000000001:900000000002:1',
  ]);
});

test('accepted without a recruiter addition drops that line and its blank', () => {
  const input = fixture('plan-accepted');
  delete input.recruiterAdditions;
  const body = gmail(plan(input), 'candidate-confirmation').message.body;
  assert.equal(body, CONFIRMATION.replace('If a short prep call beforehand would help, reply here and I will set one up.\n\n', ''));
});

test('plan-no-fit: no_fit, and candidate-alternative-times with five days of calendar-confirmed slots', () => {
  const p = plan(fixture('plan-no-fit'));
  assert.equal(p.dispatchable, true, p.reasons.join('; '));
  assert.deepEqual(p.stateTrail.map((t) => t.event), ['availability_received', 'no_slot']);
  assert.equal(p.nextState, 'no_fit');
  assert.equal(p.stateAfterDispatch, 'awaiting_availability');
  assert.equal(p.searchedDays, 14);
  assert.equal(p.chosenSlot, null);
  assert.deepEqual(p.steps.map((s) => s.step), ['candidate-alternative-times']);
  assert.deepEqual(gmail(p, 'candidate-alternative-times').message, { ...THREAD, body: ALTERNATIVES });
});

test('no fit and fewer than three open slots in 14 days: a Slack escalation, nothing to the candidate', () => {
  const input = fixture('plan-no-fit');
  input.freeBusy['dana.okafor@turing.com'] = { busy: [{ start: '2026-10-08T00:00:00Z', end: '2026-10-22T16:00:00Z' }] };
  const p = plan(input);
  assert.equal(p.nextState, 'no_fit');
  assert.equal(p.stateAfterDispatch, null);
  assert.deepEqual(p.steps.map((s) => [s.step, s.kind, s.ledgerKey]), [['escalation', 'slack', 'escalation:900000000001:900000000002:1']]);
  const step = p.steps[0]!;
  assert.ok(step.kind === 'slack');
  assert.deepEqual(step.message.to, ['sam.vangelos@turing.com']);
  assert.match(step.message.text, /Priya Ramos/);
  assert.match(step.message.text, /0 open slot/);
});

test('free/busy shorter than the 14-day search is called out in notes', () => {
  const input = fixture('plan-no-fit');
  delete input.freeBusyRange;
  const p = plan(input);
  assert.ok(p.notes.some((n) => /covers only to 2026-10-15T15:00:00.000Z/.test(n)), p.notes.join('; '));
});

test('declined: rescheduling, alternatives that exclude the declined slot', () => {
  const input = fixture('plan-accepted');
  input.interviewerResponse = 'declined';
  delete input.meetLink;
  input.freeBusyRange = { start: input.now, end: '2026-10-22T22:00:00Z' };
  const p = plan(input);
  assert.equal(p.dispatchable, true, p.reasons.join('; '));
  assert.deepEqual(p.stateTrail.map((t) => `${t.from}>${t.to}`), ['held>rescheduling']);
  assert.equal(p.nextState, 'rescheduling');
  const body = gmail(p, 'candidate-alternative-times').message.body;
  // Friday's first open slot (1:30 pm Pacific) is the declined one, so Friday offers the next: 2:00 pm Pacific.
  assert.doesNotMatch(body, /Friday, October 9 at 4:30 pm/);
  assert.deepEqual(body.split('\n').filter((l) => l.startsWith('- ')), [
    '- Friday, October 9 at 5:00 pm Eastern Time',
    '- Monday, October 12 at 12:00 pm Eastern Time',
    '- Tuesday, October 13 at 12:00 pm Eastern Time',
    '- Wednesday, October 14 at 12:00 pm Eastern Time',
    '- Thursday, October 15 at 12:00 pm Eastern Time',
  ]);
  assert.equal(p.stateAfterDispatch, 'awaiting_availability', 'per the table: rescheduling --alternatives_sent--> awaiting_availability');
});

test('needsAction: stay held and send nothing', () => {
  const input = fixture('plan-accepted');
  input.interviewerResponse = 'needsAction';
  const p = plan(input);
  assert.equal(p.nextState, 'held');
  assert.deepEqual(p.stateTrail, []);
  assert.deepEqual(p.steps, []);
  assert.equal(p.dispatchable, true);
});

test('no candidate windows: awaiting_availability and nothing to send', () => {
  const input = fixture('plan-held');
  input.candidateWindows = [];
  const p = plan(input);
  assert.equal(p.nextState, 'awaiting_availability');
  assert.deepEqual(p.steps, []);
});

test('a guard failure still returns the plan, marked not dispatchable with every reason', () => {
  const input = fixture('plan-accepted');
  input.recruiterAdditions = 'The Zoom link is https://zoom.us/j/123 if Meet fails.';
  input.otherCandidateNames = ['Dana Okafor'];
  const p = plan(input);
  assert.equal(p.dispatchable, false);
  assert.equal(p.steps.length, 2, 'the payloads are still there to inspect');
  assert.ok(p.reasons.some((r) => r.startsWith('candidate-confirmation: ') && /zoom/i.test(r)));
  assert.ok(p.reasons.some((r) => /link https:\/\/zoom\.us/.test(r)));
  assert.ok(p.reasons.some((r) => /other candidate Dana Okafor/.test(r)));
  const conf = p.guard.find((g) => g.step === 'candidate-confirmation')!;
  assert.equal(conf.ok, false);
  assert.deepEqual(conf.checks.filter((c) => !c.ok).map((c) => c.rule), ['no-zoom', 'links', 'other-candidates']);
});

test('the hold reply and the confirmation stay inside their max_words with realistic values', () => {
  const held = gmail(plan(fixture('plan-held')), 'candidate-hold-reply').message.body;
  const conf = gmail(plan(fixture('plan-accepted')), 'candidate-confirmation').message.body;
  const holdMax = loadTemplate('candidate-hold-placed').maxWords;
  const confMax = loadTemplate('candidate-confirmation').maxWords;
  assert.equal(holdMax, 120);
  assert.equal(confMax, 240);
  assert.ok(countWords(held) <= holdMax, `hold reply is ${countWords(held)} words`);
  assert.ok(countWords(conf) <= confMax, `confirmation is ${countWords(conf)} words`);
});

test('invalid input is refused before anything is built', () => {
  const bad = (mut: (i: PlanInput) => void, pattern: RegExp) => {
    const input = fixture('plan-held');
    mut(input);
    assert.throws(() => plan(input), (e: Error) => e instanceof InvalidInputError && pattern.test(e.message));
  };
  bad((i) => (i.candidate.zone = 'ET'), /candidate\.zone/);
  bad((i) => (i.interviewer.zone = 'Mars/Olympus'), /interviewer\.zone/);
  bad((i) => (i.now = '2026-10-08 15:00'), /now/);
  bad((i) => (i.candidateWindows = [{ start: '2026-10-09T13:00:00-04:00', end: '2026-10-09T12:00:00-04:00' }]), /ends before/);
  bad((i) => (i.candidate.email = 'not-an-email'), /candidate\.email/);
  bad((i) => (i.candidate.lastMessageId = '19a0f1c2'), /Message-ID/);
  bad((i) => (i.spec.attempt = 0), /attempt/);
  bad((i) => (i.candidateSummary = ''), /candidateSummary/);
  bad((i) => (i.interviewerResponse = 'accepted'), /heldSlot/);
  bad((i) => {
    i.interviewerResponse = 'accepted';
    i.heldSlot = { start: '2026-10-09T13:30:00-07:00', end: '2026-10-09T14:00:00-07:00' };
  }, /meetLink/);
});

test('Greenhouse zone names in the input are normalised before anything is rendered', () => {
  const input = fixture('plan-held');
  assert.equal(input.candidate.zone, 'Eastern Time (US & Canada)');
  const p = plan(input);
  assert.equal(p.times?.candidate, 'Friday, October 9 at 4:30 pm Eastern Time');
  assert.equal(input.candidate.zone, 'Eastern Time (US & Canada)', 'the caller input is not mutated');
});
