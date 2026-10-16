import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCandidateAddPatch, buildHoldEvent, holdEventId } from '../src/hold.js';
import { ledgerKey, LEDGER_STEPS } from '../src/ledger-keys.js';
import { buildReply } from '../src/mail.js';
import type { Candidate } from '../src/types.js';

test('holdEventId is stable, distinct per (application, job interview, attempt), and Calendar-legal', () => {
  const a = holdEventId('900000000001', '900000000002', 1);
  assert.equal(a, 'schedo1cmgo932ar7rgsj4d5it93hlokpgnp1f3e5v6f201g9tljr38rg', 'pinned: a change here orphans every existing hold');
  assert.equal(holdEventId('900000000001', '900000000002', 1), a);
  assert.match(a, /^[0-9a-v]{5,1024}$/);
  const others = [holdEventId('900000000001', '900000000002', 2), holdEventId('900000000001', '900000000003', 1), holdEventId('90000000000', '1900000000002', 1)];
  for (const o of others) {
    assert.match(o, /^[0-9a-v]{5,1024}$/);
    assert.notEqual(o, a);
  }
  assert.throws(() => holdEventId('1', '2', 0), /attempt/);
  assert.throws(() => holdEventId('', '2', 1));
});

const interviewer = { firstName: 'Dana', fullName: 'Dana Okafor', email: 'dana.okafor@turing.com', title: 'Hiring Manager, AI Labs', zone: 'America/Los_Angeles' };
const spec = { applicationId: '900000000001', jobInterviewId: '900000000002', candidateId: '900000000003', jobName: 'Field Engineer, AI Labs', kitId: '900000000004', durationMin: 30, attempt: 1 };

test('the hold event: interviewer only, Meet requested with the event id, times in the interviewer zone', () => {
  const req = buildHoldEvent({ interviewer, spec }, { start: '2026-10-09T20:30:00Z', end: '2026-10-09T21:00:00Z' }, { summary: 'Title', body: 'Description' });
  const id = holdEventId('900000000001', '900000000002', 1);
  assert.deepEqual(req, {
    method: 'POST',
    path: 'calendars/primary/events',
    query: { conferenceDataVersion: '1', sendUpdates: 'all' },
    body: {
      id,
      summary: 'Title',
      description: 'Description',
      start: { dateTime: '2026-10-09T13:30:00-07:00', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-10-09T14:00:00-07:00', timeZone: 'America/Los_Angeles' },
      attendees: [{ email: 'dana.okafor@turing.com', displayName: 'Dana Okafor' }],
      conferenceData: { createRequest: { requestId: id, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      guestsCanModify: false,
      reminders: { useDefault: true },
    },
  });
  assert.throws(() => buildHoldEvent({ interviewer, spec }, { start: '2026-10-09T20:30:00Z', end: '2026-10-09T21:00:00Z' }, { body: 'x' }), /summary/);
});

test('the candidate-add patch appends the candidate once and keeps the interviewer response', () => {
  const existing = [{ email: 'dana.okafor@turing.com', displayName: 'Dana Okafor', responseStatus: 'accepted' }];
  const candidate = { email: 'priya.ramos@example.com', fullName: 'Priya Ramos' };
  const patch = buildCandidateAddPatch(existing, candidate);
  assert.deepEqual(patch, {
    query: { sendUpdates: 'all' },
    body: { attendees: [...existing, { email: 'priya.ramos@example.com', displayName: 'Priya Ramos' }] },
  });
  const again = buildCandidateAddPatch(patch.body.attendees, { ...candidate, email: 'Priya.Ramos@Example.com' });
  assert.equal(again.body.attendees.length, 2, 'no duplicate attendee');
  assert.deepEqual(existing, [{ email: 'dana.okafor@turing.com', displayName: 'Dana Okafor', responseStatus: 'accepted' }], 'input untouched');
});

test('ledger keys are <step>:<application>:<job interview>:<attempt>', () => {
  assert.equal(ledgerKey('hold-create', '900000000001', '900000000002', 1), 'hold-create:900000000001:900000000002:1');
  for (const step of ['hold-create', 'candidate-hold-reply', 'candidate-add', 'candidate-confirmation', 'gh-interview-create', 'gh-note', 'reminder'] as const) {
    assert.ok(LEDGER_STEPS.includes(step));
    assert.equal(ledgerKey(step, 'a1', 'j2', 3), `${step}:a1:j2:3`);
  }
  assert.throws(() => ledgerKey('send' as never, '1', '2', 1), /unknown ledger step/);
  assert.throws(() => ledgerKey('hold-create', '1:2', '2', 1), /plain id/);
  assert.throws(() => ledgerKey('hold-create', '1', '2', 0), /attempt/);
});

const candidate: Candidate = {
  firstName: 'Priya',
  fullName: 'Priya Ramos',
  email: 'priya.ramos@example.com',
  location: 'Raleigh, NC',
  zone: 'America/New_York',
  threadId: '19a0f1c2d3e4f5a6',
  threadSubject: 'Field Engineer, AI Labs at Turing: next steps',
  lastMessageId: '<CAPRIYA0001.fixture@mail.gmail.com>',
};

test('replies stay in the candidate thread under its subject, without doubling "Re:"', () => {
  assert.deepEqual(buildReply(candidate, 'gmail-reply', 'Body'), {
    to: ['priya.ramos@example.com'],
    subject: 'Re: Field Engineer, AI Labs at Turing: next steps',
    threadId: '19a0f1c2d3e4f5a6',
    inReplyTo: '<CAPRIYA0001.fixture@mail.gmail.com>',
    references: '<CAPRIYA0001.fixture@mail.gmail.com>',
    body: 'Body',
  });
  assert.equal(buildReply({ ...candidate, threadSubject: 'Re: Interview' }, 'gmail-reply', 'b').subject, 'Re: Interview');
  assert.equal(buildReply({ ...candidate, threadSubject: 'RE:Interview' }, 'gmail-reply', 'b').subject, 'RE:Interview');
  assert.throws(() => buildReply({ ...candidate, threadId: '' }, 'gmail-reply', 'b'), /thread/);
  assert.throws(() => buildReply({ ...candidate, lastMessageId: '18f0c0ffee' }, 'gmail-reply', 'b'), /Message-ID/);
});
