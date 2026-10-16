import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIELD_VOCABULARY,
  TEMPLATES_DIR,
  listTemplateIds,
  loadTemplate,
  parseTemplate,
  renderTemplate,
} from '../src/templates.js';

const placeholders = (s: string) => [...s.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]!);

test('FIELD_VOCABULARY is exactly the README table', () => {
  const readme = readFileSync(join(TEMPLATES_DIR, 'README.md'), 'utf8');
  const names = [...readme.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]!);
  assert.ok(names.length >= 20, 'README table found');
  assert.deepEqual([...FIELD_VOCABULARY], names);
});

test('every file in templates/ parses, declares every placeholder it uses, uses every field it declares, and stays inside the vocabulary', () => {
  const ids = listTemplateIds();
  assert.deepEqual(ids, [
    'candidate-alternative-times',
    'candidate-confirmation',
    'candidate-handoff',
    'candidate-hold-placed',
    'candidate-nudge',
    'candidate-reminder',
    'candidate-reschedule',
    'interviewer-invite',
  ]);
  for (const id of ids) {
    const t = loadTemplate(id);
    assert.equal(t.id, id);
    assert.ok(['gmail-reply', 'calendar-description'].includes(t.channel), `${id} channel`);
    assert.ok(['candidate', 'interviewer'].includes(t.audience), `${id} audience`);
    assert.ok(Number.isInteger(t.maxWords) && t.maxWords > 0, `${id} max_words`);
    assert.ok(t.derivedFrom.length > 0, `${id} derived_from`);
    assert.equal(t.summary !== undefined, t.channel === 'calendar-description', `${id}: summary iff calendar channel`);
    const declared = new Set([...t.fields, ...t.optionalFields]);
    const used = new Set(placeholders(`${t.summary ?? ''}\n${t.body}`));
    for (const p of used) assert.ok(declared.has(p), `${id} uses undeclared {{${p}}}`);
    for (const f of declared) {
      assert.ok(FIELD_VOCABULARY.includes(f), `${id} declares ${f}, not in the vocabulary`);
      assert.ok(used.has(f), `${id} declares ${f} but never uses it`);
    }
    assert.ok(!t.body.startsWith('---'), `${id} body excludes the front matter`);
  }
});

test('interviewer-invite front matter is read exactly', () => {
  const t = loadTemplate('interviewer-invite');
  assert.equal(t.summary, 'Virtual Interview with {{CANDIDATE_NAME}} for the role of {{JOB_NAME}}');
  assert.equal(t.maxWords, 260);
  assert.deepEqual(t.optionalFields, ['RULING_LINE']);
  assert.equal(t.fields[0], 'INTERVIEWER_FIRST_NAME');
  assert.equal(t.body.split('\n')[0], 'Hello {{INTERVIEWER_FIRST_NAME}},');
});

const SMALL = `---
id: small
channel: gmail-reply
audience: candidate
derived_from: test
fields:
  - CANDIDATE_FIRST_NAME
  - RECRUITER_FIRST_NAME
optional_fields:
  - RECRUITER_ADDITIONS
max_words: 50
---
Hi {{CANDIDATE_FIRST_NAME}},

{{RECRUITER_ADDITIONS}}

Thanks.
{{RECRUITER_FIRST_NAME}}
`;

const small = () => parseTemplate(SMALL, 'small');

test('an empty optional field drops its line and one following blank line', () => {
  const r = renderTemplate(small(), { CANDIDATE_FIRST_NAME: 'Priya', RECRUITER_FIRST_NAME: 'Sam', RECRUITER_ADDITIONS: '' });
  assert.equal(r.body, 'Hi Priya,\n\nThanks.\nSam');
  const absent = renderTemplate(small(), { CANDIDATE_FIRST_NAME: 'Priya', RECRUITER_FIRST_NAME: 'Sam' });
  assert.equal(absent.body, 'Hi Priya,\n\nThanks.\nSam');
});

test('a supplied optional field renders in place', () => {
  const r = renderTemplate(small(), { CANDIDATE_FIRST_NAME: 'Priya', RECRUITER_FIRST_NAME: 'Sam', RECRUITER_ADDITIONS: 'Bring a pen.' });
  assert.equal(r.body, 'Hi Priya,\n\nBring a pen.\n\nThanks.\nSam');
});

test('an empty optional field sharing a line with text leaves the text, trimmed', () => {
  const t = loadTemplate('interviewer-invite');
  const fields = {
    INTERVIEWER_FIRST_NAME: 'Dana',
    RECRUITER_FULL_NAME: 'Sam Vangelos',
    CANDIDATE_NAME: 'Priya Ramos',
    CANDIDATE_FIRST_NAME: 'Priya',
    JOB_NAME: 'Field Engineer, AI Labs',
    INTERVIEW_KIT_LINK: 'https://app4.greenhouse.io/guides/900001/people/900002?application_id=900003',
    INTERVIEW_WINDOW_INTERVIEWER: 'Friday, October 9, 2026, 1:30 to 2:00 pm Pacific Time',
    INTERVIEW_TIME_CANDIDATE: 'Friday, October 9 at 4:30 pm Eastern Time',
    CANDIDATE_LOCATION: 'Raleigh, NC',
    CANDIDATE_SUMMARY: 'Strong systems background.',
    RECRUITER_FIRST_NAME: 'Sam',
  };
  const r = renderTemplate(t, fields);
  assert.ok(r.body.includes('\nCandidate summary: Strong systems background.\n'), r.body);
  assert.equal(r.summary, 'Virtual Interview with Priya Ramos for the role of Field Engineer, AI Labs');
  const withRuling = renderTemplate(t, { ...fields, RULING_LINE: 'Your 8 Oct ruling: yes.' });
  assert.ok(withRuling.body.includes('\nCandidate summary: Strong systems background. Your 8 Oct ruling: yes.\n'));
});

test('a missing or empty required field fails the render and names every one', () => {
  assert.throws(() => renderTemplate(small(), { CANDIDATE_FIRST_NAME: 'Priya' }), /RECRUITER_FIRST_NAME/);
  assert.throws(() => renderTemplate(small(), { CANDIDATE_FIRST_NAME: '  ', RECRUITER_FIRST_NAME: '' }), /CANDIDATE_FIRST_NAME.*RECRUITER_FIRST_NAME/s);
});

test('a placeholder the front matter does not declare fails', () => {
  const t = { ...small(), body: 'Hi {{CANDIDATE_FIRST_NAME}}, the {{JOB_NAME}} role.\n{{RECRUITER_FIRST_NAME}}' };
  assert.throws(() => renderTemplate(t, { CANDIDATE_FIRST_NAME: 'Priya', RECRUITER_FIRST_NAME: 'Sam', JOB_NAME: 'X' }), /undeclared.*JOB_NAME/i);
  assert.throws(() => parseTemplate(SMALL.replace('Thanks.', 'Thanks for {{JOB_NAME}}.'), 'small'), /JOB_NAME/);
});

test('a supplied key outside the README vocabulary fails', () => {
  assert.throws(
    () => renderTemplate(small(), { CANDIDATE_FIRST_NAME: 'Priya', RECRUITER_FIRST_NAME: 'Sam', JOB_TITLE: 'x' }),
    /JOB_TITLE.*vocabulary/,
  );
});

test('anything left looking like {{ after render fails, including one smuggled in through a value', () => {
  assert.throws(() => renderTemplate(small(), { CANDIDATE_FIRST_NAME: '{{JOB_NAME}}', RECRUITER_FIRST_NAME: 'Sam' }), /\{\{/);
  const t = { ...small(), body: 'Hi {{CANDIDATE_FIRST_NAME}}, {{ lower }}\n{{RECRUITER_FIRST_NAME}}' };
  assert.throws(() => renderTemplate(t, { CANDIDATE_FIRST_NAME: 'Priya', RECRUITER_FIRST_NAME: 'Sam' }), /\{\{/);
});

test('front matter that is not scalars or "- item" lists is refused', () => {
  assert.throws(() => parseTemplate(SMALL.replace('max_words: 50', 'max_words:\n  nested: 1'), 'small'));
  assert.throws(() => parseTemplate(SMALL.replace('id: small', 'id: other'), 'small'), /id/);
  assert.throws(() => parseTemplate(SMALL.replace('max_words: 50', 'max_words: lots'), 'small'), /max_words/);
  assert.throws(() => parseTemplate(SMALL.replace('derived_from: test', 'derived_from: test\ncolour: blue'), 'small'), /colour/);
  assert.throws(() => parseTemplate(SMALL.replace('  - RECRUITER_FIRST_NAME', '  - RECRUITER_FIRST_NAME\n  - JOB_TITLE'), 'small'), /JOB_TITLE/);
  assert.throws(() => parseTemplate('no front matter here', 'small'), /front matter/);
});
