import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSlots, type SlotInput } from '../src/slots.js';

const DANA = 'dana.okafor@turing.com';

/** Thursday 8 Oct 2026, 08:00 Pacific. */
const base: SlotInput = {
  now: '2026-10-08T15:00:00Z',
  interviewer: { firstName: 'Dana', fullName: 'Dana Okafor', email: DANA, title: 'Hiring Manager, AI Labs', zone: 'America/Los_Angeles' },
  spec: { applicationId: '1', jobInterviewId: '2', candidateId: '3', jobName: 'Field Engineer, AI Labs', kitId: '4', durationMin: 30, attempt: 1 },
  candidateWindows: [{ start: '2026-10-09T13:00:00-04:00', end: '2026-10-09T17:00:00-04:00' }],
  freeBusy: { primary: { busy: [] }, [DANA]: { busy: [] } },
};

const starts = (input: Partial<SlotInput>, opts?: Parameters<typeof findSlots>[1]) => findSlots({ ...base, ...input }, opts).map((s) => s.start);

test('open calendars: every 30-minute start inside the window and Dana\'s 9 to 5, earliest first, in her zone', () => {
  assert.deepEqual(starts({}), [
    '2026-10-09T10:00:00-07:00',
    '2026-10-09T10:30:00-07:00',
    '2026-10-09T11:00:00-07:00',
    '2026-10-09T11:30:00-07:00',
    '2026-10-09T12:00:00-07:00',
    '2026-10-09T12:30:00-07:00',
    '2026-10-09T13:00:00-07:00',
    '2026-10-09T13:30:00-07:00',
  ]);
  assert.deepEqual(findSlots(base)[0], { start: '2026-10-09T10:00:00-07:00', end: '2026-10-09T10:30:00-07:00' });
});

test('a calendar whose free/busy errored is busy throughout: nothing is returned', () => {
  assert.deepEqual(starts({ freeBusy: { primary: { busy: [] }, [DANA]: { error: 'notFound' } } }), []);
  assert.deepEqual(starts({ freeBusy: { primary: { error: 'internalError' }, [DANA]: { busy: [] } } }), []);
});

test('a calendar missing from the result is unknown, and unknown is busy', () => {
  assert.deepEqual(starts({ freeBusy: { primary: { busy: [] } } }), []);
  assert.deepEqual(starts({ freeBusy: { [DANA]: { busy: [] } } }), []);
});

test('busy blocks on Sam\'s primary and Dana\'s calendar both count, with 15 minutes either side', () => {
  const got = starts({
    freeBusy: {
      primary: { busy: [{ start: '2026-10-09T18:00:00Z', end: '2026-10-09T20:00:00Z' }] }, // 11:00-13:00 PT
      [DANA]: { busy: [{ start: '2026-10-09T16:00:00Z', end: '2026-10-09T18:00:00Z' }] }, // 09:00-11:00 PT
    },
  });
  // 13:00 PT is inside the 15-minute buffer after Sam's block; 13:30 is the first clear start.
  assert.deepEqual(got, ['2026-10-09T13:30:00-07:00']);
  // A block ending at 10:45 PT pushes the next start to 11:00 (10:45 + 15 = 11:00, exactly clear).
  const edge = starts({ freeBusy: { primary: { busy: [] }, [DANA]: { busy: [{ start: '2026-10-09T17:00:00Z', end: '2026-10-09T17:45:00Z' }] } } });
  assert.equal(edge[0], '2026-10-09T11:00:00-07:00');
  // A block starting at 11:15 PT: 10:30-11:00 ends exactly 15 minutes before it (clear); 11:00 does not.
  const before = starts({ freeBusy: { primary: { busy: [] }, [DANA]: { busy: [{ start: '2026-10-09T18:15:00Z', end: '2026-10-09T23:00:00Z' }] } } });
  assert.deepEqual(before, ['2026-10-09T10:00:00-07:00', '2026-10-09T10:30:00-07:00']);
});

test('a candidate window across Dana\'s day boundary yields only her hours on each day, by her calendar day', () => {
  // Candidate in Kolkata: Mon 12 Oct 21:30 IST to Tue 13 Oct 23:30 IST = Mon 09:00 PT to Tue 11:00 PT.
  const got = starts({
    interviewer: { ...base.interviewer, hours: { start: '15:00', end: '17:00' } },
    candidateWindows: [{ start: '2026-10-12T21:30:00+05:30', end: '2026-10-13T23:30:00+05:30' }],
  });
  assert.deepEqual(got, [
    '2026-10-12T15:00:00-07:00',
    '2026-10-12T15:30:00-07:00',
    '2026-10-12T16:00:00-07:00',
    '2026-10-12T16:30:00-07:00',
  ]);
  // Default hours: Monday 09:00-17:00 then Tuesday from 09:00; nothing from 17:00 Monday to 09:00 Tuesday PT.
  const all = findSlots({ ...base, candidateWindows: [{ start: '2026-10-12T21:30:00+05:30', end: '2026-10-13T23:30:00+05:30' }] }, { limit: 100 });
  const mon = all.filter((s) => s.start.startsWith('2026-10-12'));
  const tue = all.filter((s) => s.start.startsWith('2026-10-13'));
  assert.equal(mon[0]!.start, '2026-10-12T09:00:00-07:00');
  assert.equal(mon.at(-1)!.start, '2026-10-12T16:30:00-07:00');
  assert.deepEqual(tue.map((s) => s.start), ['2026-10-13T09:00:00-07:00', '2026-10-13T09:30:00-07:00', '2026-10-13T10:00:00-07:00', '2026-10-13T10:30:00-07:00']);
});

test('weekends in the interviewer\'s zone are out, even when the UTC day is a weekday', () => {
  // Sunday 11 Oct 18:00 PT to Monday 12 Oct 10:00 PT; Monday 01:00 UTC is still Sunday in LA.
  const got = starts({ candidateWindows: [{ start: '2026-10-12T01:00:00Z', end: '2026-10-12T17:00:00Z' }] });
  assert.deepEqual(got, ['2026-10-12T09:00:00-07:00', '2026-10-12T09:30:00-07:00']);
});

test('daily cap: four interviews on Dana\'s calendar day close it, counted by her day, not UTC', () => {
  // Four bookings on Monday 12 Oct Pacific. Two of them fall on Tuesday in UTC.
  const monday = [
    { start: '2026-10-12T16:00:00Z', end: '2026-10-12T16:30:00Z' }, // 09:00 PT
    { start: '2026-10-12T17:00:00Z', end: '2026-10-12T17:30:00Z' }, // 10:00 PT
    { start: '2026-10-13T00:00:00Z', end: '2026-10-13T00:30:00Z' }, // 17:00 PT Monday
    { start: '2026-10-13T01:00:00Z', end: '2026-10-13T01:30:00Z' }, // 18:00 PT Monday
  ];
  const windows = [{ start: '2026-10-12T19:00:00Z', end: '2026-10-13T20:00:00Z' }]; // Mon 12:00 PT to Tue 13:00 PT
  const capped = starts({ candidateWindows: windows, existingBookings: { [DANA]: monday } }, { limit: 100 });
  assert.ok(capped.length > 0);
  assert.ok(capped.every((s) => s.startsWith('2026-10-13')), `Monday is full: ${capped.join(', ')}`);
  // Three bookings leave Monday open (minus their buffers).
  const three = starts({ candidateWindows: windows, existingBookings: { [DANA]: monday.slice(0, 3) } }, { limit: 100 });
  assert.equal(three[0], '2026-10-12T12:00:00-07:00');
  // A custom cap of 3 closes it again.
  const cap3 = starts({ interviewer: { ...base.interviewer, dailyCap: 3 }, candidateWindows: windows, existingBookings: { [DANA]: monday.slice(0, 3) } }, { limit: 100 });
  assert.ok(cap3.every((s) => s.startsWith('2026-10-13')));
});

test('nothing earlier than now plus two hours', () => {
  // now = Friday 9 Oct 10:10 PT; floor is 12:10 PT, so the first aligned start is 12:30.
  const got = starts({ now: '2026-10-09T17:10:00Z' });
  assert.equal(got[0], '2026-10-09T12:30:00-07:00');
  // Exactly two hours is allowed.
  assert.equal(starts({ now: '2026-10-09T17:00:00Z' })[0], '2026-10-09T12:00:00-07:00');
});

test('slots never leave the span free/busy covered, nor the horizon', () => {
  const far = [{ start: '2026-10-19T16:00:00Z', end: '2026-10-19T18:00:00Z' }]; // 11 days out
  assert.deepEqual(starts({ candidateWindows: far }), [], 'default range is 7 days');
  assert.deepEqual(starts({ candidateWindows: far }, { horizonDays: 14 }), [], '14-day horizon still needs 14-day coverage');
  const covered = starts({ candidateWindows: far, freeBusyRange: { start: base.now, end: '2026-10-22T15:00:00Z' } }, { horizonDays: 14 });
  assert.deepEqual(covered, ['2026-10-19T09:00:00-07:00', '2026-10-19T09:30:00-07:00', '2026-10-19T10:00:00-07:00', '2026-10-19T10:30:00-07:00']);
});

test('at most ten, deduplicated across overlapping windows, and the duration comes from the spec', () => {
  const wide = [
    { start: '2026-10-12T16:00:00Z', end: '2026-10-13T00:00:00Z' },
    { start: '2026-10-12T16:00:00Z', end: '2026-10-12T20:00:00Z' },
  ];
  const got = findSlots({ ...base, candidateWindows: wide });
  assert.equal(got.length, 10);
  assert.equal(new Set(got.map((s) => s.start)).size, 10);
  const hour = findSlots({ ...base, spec: { ...base.spec, durationMin: 60 } });
  assert.deepEqual(hour.at(-1), { start: '2026-10-09T13:00:00-07:00', end: '2026-10-09T14:00:00-07:00' });
});

test('30-minute alignment is on the interviewer\'s wall clock, even for a :45-offset candidate', () => {
  // Kathmandu is UTC+5:45; the window starts at an odd UTC minute and slots still land on :00 and :30 Pacific.
  const got = starts({ candidateWindows: [{ start: '2026-10-09T22:50:00+05:45', end: '2026-10-10T00:50:00+05:45' }] });
  assert.ok(got.length > 0);
  assert.ok(got.every((s) => /T\d{2}:(00|30):00-07:00$/.test(s)), got.join(', '));
});
