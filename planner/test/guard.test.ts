import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOutgoing, type GuardFacts, type OutgoingMessage } from '../src/guard.js';

const CONFIRMED = 'Friday, October 9 at 4:30 pm Eastern Time';

const facts: GuardFacts = {
  allowedRecipients: ['priya.ramos@example.com'],
  confirmedTimeStrings: [CONFIRMED],
  otherCandidateNames: ['Jordan Mbeki'],
  maxWords: 40,
};

const base: OutgoingMessage = {
  to: ['priya.ramos@example.com'],
  subject: 'Re: Field Engineer, AI Labs at Turing',
  body: `Hi Priya,\n\nYour interview is ${CONFIRMED} on Google Meet: https://meet.google.com/abc-defg-hij.\n\nBest,\nSam`,
  channel: 'gmail-reply',
};

function reasons(msg: Partial<OutgoingMessage>, f: Partial<GuardFacts> = {}): string[] {
  const r = checkOutgoing({ ...base, ...msg }, { ...facts, ...f });
  return r.ok ? [] : r.reasons;
}

function failsWith(msg: Partial<OutgoingMessage>, pattern: RegExp, f: Partial<GuardFacts> = {}): void {
  const rs = reasons(msg, f);
  assert.ok(rs.some((r) => pattern.test(r)), `expected a reason matching ${pattern}, got ${JSON.stringify(rs)}`);
}

test('a clean candidate reply passes every check', () => {
  assert.deepEqual(checkOutgoing(base, facts), { ok: true });
});

test('recipients: only allowed addresses, compared case-insensitively', () => {
  assert.deepEqual(reasons({ to: ['Priya.Ramos@Example.com'] }), []);
  failsWith({ to: ['priya.ramos@example.com', 'someone.else@example.com'] }, /recipient.*someone\.else@example\.com/i);
});

test('the word "zoom" fails anywhere, as a word, in any case; "zoomed" does not', () => {
  assert.deepEqual(reasons({ body: `${base.body}\nWe zoomed through the screen.` }), []);
  failsWith({ body: `${base.body}\nThe ZOOM link follows.` }, /zoom/i);
  failsWith({ subject: 'Re: Zoom interview' }, /zoom/i);
});

test('links: only meet.google.com, app4.greenhouse.io, turing.com and its subdomains', () => {
  const ok = [
    'https://meet.google.com/abc-defg-hij',
    'https://app4.greenhouse.io/guides/1/people/2?application_id=3',
    'https://turing.com/careers',
    'https://www.turing.com/blog.',
    'https://newsroom.turing.com/x',
  ];
  for (const url of ok) assert.deepEqual(reasons({ body: `${base.body}\n${url}` }), [], url);
  const bad = [
    'https://calendly.com/sam',
    'https://app.greenhouse.io/x',
    'https://meet.google.com.evil.example/x',
    'https://meet.google.com@evil.example/x',
    'https://notturing.com/x',
    'http://example.com/?next=https://turing.com',
    'www.example.com/page',
  ];
  for (const url of bad) failsWith({ body: `${base.body}\n${url}` }, /link/i);
});

test('clock times must sit inside a calendar-confirmed time string', () => {
  assert.deepEqual(reasons({}), []);
  failsWith({ body: `${base.body}\nOr 5:30 pm if easier.` }, /time.*5:30 pm/i);
  failsWith({ body: 'See you Friday at 4:30 pm.' }, /time.*4:30 pm/i);
  failsWith({ body: `${base.body}\nOr 5 PM works.` }, /time/i);
});

test('no other candidate may be named, in any case', () => {
  assert.deepEqual(reasons({ body: `${base.body}\nJordan says hello.` }), []);
  failsWith({ body: `${base.body}\nI also spoke with jordan mbeki today.` }, /other candidate.*Jordan Mbeki/i);
});

test('unresolved placeholders fail: {{FIELD}} and [Something Like This]', () => {
  assert.deepEqual(reasons({ body: `${base.body}\n(Turing)` }), []);
  failsWith({ body: `${base.body}\nThe {{JOB_NAME}} role.` }, /placeholder/i);
  failsWith({ body: `${base.body}\nThe [Job Title] role.` }, /placeholder/i);
});

test('word cap: exactly maxWords passes, one more fails', () => {
  const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
  assert.deepEqual(reasons({ body: words(40) }), []);
  failsWith({ body: words(41) }, /41 words.*40/);
});

test('every failing rule is reported, not just the first', () => {
  const rs = reasons({
    to: ['intruder@example.com'],
    body: 'Join on Zoom at https://zoom.us/j/1 with Jordan Mbeki at 6:00 pm for [Job Title].',
  });
  for (const p of [/recipient/i, /zoom/i, /link/i, /time/i, /other candidate/i, /placeholder/i]) {
    assert.ok(rs.some((r) => p.test(r)), `missing ${p} in ${JSON.stringify(rs)}`);
  }
});
