import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

const FIXTURES = join(import.meta.dirname, 'fixtures');

function run(argv: string[]) {
  let out = '';
  let err = '';
  const code = main(argv, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

function withTemp(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'clo430-cli-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('plan on a clean fixture prints the plan JSON and exits 0', () => {
  const r = run(['plan', join(FIXTURES, 'plan-held.json')]);
  assert.equal(r.code, 0, r.err);
  const p = JSON.parse(r.out);
  assert.equal(p.dispatchable, true);
  assert.equal(p.steps[0].request.body.summary, 'Virtual Interview with Priya Ramos for the role of Field Engineer, AI Labs');
});

test('plan exits 2 when the guard refuses, still printing the plan', () => {
  withTemp((dir) => {
    const input = JSON.parse(readFileSync(join(FIXTURES, 'plan-accepted.json'), 'utf8'));
    input.recruiterAdditions = 'Zoom works too.';
    const path = join(dir, 'in.json');
    writeFileSync(path, JSON.stringify(input));
    const r = run(['plan', path]);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.out).dispatchable, false);
    assert.match(r.err, /not dispatchable/);
  });
});

test('plan exits 1 on invalid input, a missing file, or bad JSON', () => {
  withTemp((dir) => {
    const input = JSON.parse(readFileSync(join(FIXTURES, 'plan-held.json'), 'utf8'));
    input.candidate.zone = 'ET';
    writeFileSync(join(dir, 'bad.json'), JSON.stringify(input));
    writeFileSync(join(dir, 'junk.json'), '{ not json');
    for (const f of ['bad.json', 'junk.json', 'missing.json']) {
      const r = run(['plan', join(dir, f)]);
      assert.equal(r.code, 1, f);
      assert.equal(r.out, '');
      assert.match(r.err, /^error: /);
    }
  });
});

test('render prints one template; a missing field exits 1; anything else is usage and exits 1', () => {
  withTemp((dir) => {
    const fields = {
      CANDIDATE_FIRST_NAME: 'Priya',
      JOB_NAME: 'Field Engineer, AI Labs',
      RECRUITER_FIRST_NAME: 'Sam',
      DISCLOSURE_LINE: 'Disclosure.',
    };
    writeFileSync(join(dir, 'f.json'), JSON.stringify(fields));
    const ok = run(['render', 'candidate-handoff', join(dir, 'f.json')]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(
      ok.out,
      "Hi Priya,\n\nThanks for your patience on the Field Engineer, AI Labs scheduling. I'm picking this up personally from here and will come back to you directly with next steps. Reply to this thread any time and it reaches me.\n\nBest,\nSam\n\nDisclosure.\n",
    );
    const missing = run(['render', 'candidate-nudge', join(dir, 'f.json')]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /INTERVIEWER_NAME/);
  });
  assert.equal(run([]).code, 1);
  assert.equal(run(['send', 'x']).code, 1);
  assert.match(run(['dispatch']).err, /usage/);
});
