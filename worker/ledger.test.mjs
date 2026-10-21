import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { append, dedupe, dischargedKeys, isActionDischarged, ledgerPath, read, summarizeLedger, validateRecord } from './ledger.mjs';
import { ALLOWED } from './gate.mjs';
import { run as runPilot } from './pilot.mjs';
import { checkFreshness, renderClaudeMd, renderWorkerPrompt } from '../tools/render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduling-ledger-projects-'));
after(() => fs.rmSync(PROJECTS, { recursive: true, force: true }));

const names = Object.fromEntries(ALLOWED.map(n => [n.split('__').at(-1), n]));

function temp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduling-ledger-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('ledger append, read, and dedupe by idempotency_key across all record kinds', t => {
  const dir = temp(t);

  // 1. Two-phase action write: intent before dispatch, then dispatched with provider_id
  append(dir, {
    idempotency_key: 'act:5149015004:app-1000000001:hm_screen:hold:1',
    at: '2026-10-16T18:00:00.000Z',
    kind: 'action',
    episode_id: 'app-1000000001-hm_screen',
    action_key: 'propose-hold',
    provider: 'greenhouse',
    provider_id: null,
    status: 'intent',
    actor: 'sam',
    summary: 'Schedule HM screen in Greenhouse for fictional candidate.',
  });
  append(dir, {
    idempotency_key: 'act:5149015004:app-1000000001:hm_screen:hold:1',
    at: '2026-10-16T18:00:05.000Z',
    kind: 'action',
    episode_id: 'app-1000000001-hm_screen',
    action_key: 'propose-hold',
    provider: 'greenhouse',
    provider_id: 'gh-interview-9001',
    status: 'dispatched',
    actor: 'sam',
    summary: 'Scheduled HM screen in Greenhouse for fictional candidate.',
  });

  // 2. Approval records: one approved, one declined
  append(dir, {
    idempotency_key: 'appr:app-1000000001-hm_screen:propose-hold',
    at: '2026-10-16T17:59:50.000Z',
    kind: 'approval',
    episode_id: 'app-1000000001-hm_screen',
    action_key: 'propose-hold',
    decision: 'approved',
    actor: 'sam',
    notes: 'Sam approved hold proposal.',
  });
  append(dir, {
    idempotency_key: 'appr:app-1000000001-hm_screen:premature-confirm',
    at: '2026-10-16T18:01:00.000Z',
    kind: 'approval',
    episode_id: 'app-1000000001-hm_screen',
    action_key: 'premature-confirm',
    decision: 'declined',
    actor: 'sam',
    notes: 'Declined confirmation before interviewer accepted.',
  });

  // 3. Wait records: one active interviewer chase, one wait that gets resolved
  append(dir, {
    idempotency_key: 'wait:app-1000000001-hm_screen:interviewer_accept:1',
    at: '2026-10-16T18:00:10.000Z',
    kind: 'wait',
    episode_id: 'app-1000000001-hm_screen',
    waiting_on: 'interviewer:dana.okafor@turing.com',
    since: '2026-10-16T18:00:05.000Z',
    rule: '12h_interviewer_chase',
    resolved_at: null,
  });
  append(dir, {
    idempotency_key: 'wait:app-1000000002-coding:candidate_reply:1',
    at: '2026-10-15T18:00:00.000Z',
    kind: 'wait',
    episode_id: 'app-1000000002-coding',
    waiting_on: 'candidate:fictional@example.com',
    since: '2026-10-15T18:00:00.000Z',
    rule: '24h_candidate_nudge',
    resolved_at: null,
  });
  append(dir, {
    idempotency_key: 'wait:app-1000000002-coding:candidate_reply:1',
    at: '2026-10-16T16:00:00.000Z',
    kind: 'wait',
    episode_id: 'app-1000000002-coding',
    waiting_on: 'candidate:fictional@example.com',
    since: '2026-10-15T18:00:00.000Z',
    rule: '24h_candidate_nudge',
    resolved_at: '2026-10-16T16:00:00.000Z',
  });

  // 4. Note record
  append(dir, {
    idempotency_key: 'note:app-1000000001-hm_screen:tz',
    at: '2026-10-16T18:02:00.000Z',
    kind: 'note',
    episode_id: 'app-1000000001-hm_screen',
    text: 'Candidate is in America/New_York this week.',
  });

  const raw = read(dir);
  assert.equal(raw.length, 8, 'raw read returns every appended line');

  const deduped = dedupe(raw);
  assert.equal(deduped.length, 6, 'dedupe collapses matching idempotency_key entries');
  assert.equal(deduped[0].idempotency_key, 'act:5149015004:app-1000000001:hm_screen:hold:1');
  assert.equal(deduped[0].status, 'dispatched');
  assert.equal(deduped[0].provider_id, 'gh-interview-9001');

  const summary = summarizeLedger(dir);
  assert.deepEqual(summary.discharged_action_keys, [
    'propose-hold',
    'app-1000000001-hm_screen/propose-hold',
  ]);
  assert.deepEqual(summary.declined_action_keys, [
    'premature-confirm',
    'app-1000000001-hm_screen/premature-confirm',
  ]);
  assert.equal(summary.active_waits.length, 1);
  assert.equal(summary.active_waits[0].idempotency_key, 'wait:app-1000000001-hm_screen:interviewer_accept:1');
  assert.equal(isActionDischarged(summary, 'app-1000000001-hm_screen', 'propose-hold'), true);
  assert.equal(isActionDischarged(summary, 'app-1000000001-hm_screen', 'premature-confirm'), true);
  assert.equal(isActionDischarged(summary, 'app-1000000001-hm_screen', 'other-action'), false);

  // Private file and directory permissions
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(ledgerPath(dir)).mode & 0o777, 0o600);
});

test('ledger validateRecord rejects malformed entries', () => {
  assert.throws(() => validateRecord({ kind: 'action' }), /idempotency_key/);
  assert.throws(() => validateRecord({ idempotency_key: 'k1', kind: 'unknown' }), /Invalid ledger record kind/);
  assert.throws(() => validateRecord({ idempotency_key: 'k1', kind: 'action', episode_id: 'ep1', action_key: 'a1', status: 'dispatched', provider_id: '' }), /provider_id/);
  assert.throws(() => validateRecord({ idempotency_key: 'k1', kind: 'approval', episode_id: 'ep1', action_key: 'a1', decision: 'maybe' }), /decision/);
  assert.throws(() => validateRecord({ idempotency_key: 'k1', kind: 'wait', episode_id: 'ep1', waiting_on: '', since: '2026-10-16T00:00:00Z', rule: '12h' }), /waiting_on/);
  assert.throws(() => validateRecord({ idempotency_key: 'k1', kind: 'note', text: '' }), /text/);
});

test('worker/prompt.md and CLAUDE.md are fresh against JOB.md and fail when stale', () => {
  const fresh = checkFreshness();
  assert.equal(fresh.ok, true, `Expected fresh generated files, got stale: ${fresh.stale.join(', ')}`);

  const claudeText = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  const claudeLines = claudeText.trimEnd().split('\n');
  assert.ok(claudeLines.length < 150, `CLAUDE.md must stay under 150 lines (got ${claudeLines.length})`);
  assert.match(claudeText, /ledger\.jsonl/);
  assert.match(claudeText, /checkpoint\.json/);
  assert.match(claudeText, /DRAFTS\.md/);
  assert.match(claudeText, /\/Users\/sam\.vangelos\/Projects\/recruiting-tools\/recruiting-agents\/docs\/playbooks\/candidate-comms\.md/);
  assert.match(claudeText, /\/Users\/sam\.vangelos\/Projects\/recruiting-tools\/recruiting-agents\/docs\/playbooks\/greenhouse\.md/);

  // Mutating JOB.md content makes the checked-in renderings stale
  const jobText = fs.readFileSync(path.join(ROOT, 'JOB.md'), 'utf8');
  const mutatedJob = jobText.replace('12 hours', '14 hours');
  assert.notEqual(renderWorkerPrompt(mutatedJob), fs.readFileSync(path.join(ROOT, 'worker/prompt.md'), 'utf8'));
  assert.notEqual(renderClaudeMd(mutatedJob), claudeText);
});

test('worker run feeds ledger into scan_context and never re-proposes a discharged action_key', async t => {
  const dir = temp(t);

  // Seed ledger with one dispatched action and one declined approval, plus an active wait
  append(dir, {
    idempotency_key: 'act:fictional-episode:propose-hold:1',
    at: '2026-10-16T19:00:00.000Z',
    kind: 'action',
    episode_id: 'fictional-episode',
    action_key: 'propose-hold',
    provider: 'greenhouse',
    provider_id: 'gh-int-123',
    status: 'dispatched',
    actor: 'sam',
    summary: 'Sent hold in Greenhouse.',
  });
  append(dir, {
    idempotency_key: 'appr:fictional-episode:nudge-candidate:1',
    at: '2026-10-16T19:05:00.000Z',
    kind: 'approval',
    episode_id: 'fictional-episode',
    action_key: 'nudge-candidate',
    decision: 'declined',
    actor: 'sam',
    notes: 'Sam declined candidate nudge.',
  });
  append(dir, {
    idempotency_key: 'wait:fictional-episode:interviewer_accept:1',
    at: '2026-10-16T19:00:05.000Z',
    kind: 'wait',
    episode_id: 'fictional-episode',
    waiting_on: 'interviewer:dana.okafor@turing.com',
    since: '2026-10-16T19:00:00.000Z',
    rule: '12h_interviewer_chase',
    resolved_at: null,
  });

  const calls = [
    ['search_threads', { query: 'fictional scheduling' }, { threads: [{ id: 'thread-fictional' }] }],
    ['get_thread', { threadId: 'thread-fictional', format: 'FULL_CONTENT' }, { id: 'thread-fictional', messages: [{ textBody: 'Thursday works for Fictional Candidate.' }] }],
    ['list_events', { calendarId: 'primary' }, { events: [] }],
    ['slack_search_public_and_private', { filters: { in: 'field-engineering-hiring' } }, { results: [], pagination_info: '' }],
    ['get_my_job', { id: 5149015004 }, { data: { id: 5149015004 }, ok: true }],
    ['search_my_interviews', { job_ids: [5149015004] }, { data: [], nextCursor: null, ok: true, read: { complete: true } }],
    ['search_my_applications', { job_ids: [5149015004], status: 'active' }, { data: [], ok: true, read: { complete: true } }],
    ['search_my_candidates', { job_ids: [5149015004] }, { data: [], ok: true, read: { complete: true } }],
  ];
  const events = calls.flatMap(([n, input, result], i) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: `read-${i}`, name: names[n], input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `read-${i}`, content: JSON.stringify(result) }] } },
  ]);
  const report = {
    coverage: Object.fromEntries([
      ['gmail', 'get_thread'],
      ['calendar', 'list_events'],
      ['slack', 'slack_search_public_and_private'],
      ['greenhouse', 'search_my_interviews'],
    ].map(([s, n]) => [s, { complete: true, receipt_ids: [names[n]], notes: 'Fictional complete read.' }])),
    episodes: [{
      episode_id: 'fictional-episode',
      status: 'open',
      facts: [{ text: 'Fictional candidate offered Thursday.', evidence: [names.get_thread] }],
      next_actions: [
        { action_key: 'propose-hold', text: 'Review Thursday hold.', draft: 'Discharged draft.', evidence: [names.get_thread] },
        { action_key: 'nudge-candidate', text: 'Nudge candidate.', draft: 'Declined draft.', evidence: [names.get_thread] },
        { action_key: 'chase-interviewer', text: 'Chase interviewer in Slack after 12h.', draft: 'Hey @Interviewer — can you accept the Thursday hold?', evidence: [names.get_thread] },
      ],
      unknowns: [],
    }],
    unknowns: [],
  };
  events.push({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report) });

  const cliDir = temp(t);
  const stdinCapture = path.join(cliDir, 'captured-stdin.txt');
  const cli = path.join(cliDir, 'claude-fake');
  fs.writeFileSync(
    cli,
    `#!${process.execPath}\nconst fs = require('node:fs');\nlet buf = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', c => { buf += c; });\nprocess.stdin.on('end', () => {\n  fs.writeFileSync(${JSON.stringify(stdinCapture)}, buf);\n  process.stdout.write(${JSON.stringify(events.map(x => JSON.stringify(x)).join('\n') + '\n')});\n});\n`,
    { mode: 0o700 },
  );

  const outcome = await runPilot({ dataDir: dir, claude: cli, claudeProjectsDir: PROJECTS });
  assert.equal(outcome.success, true);

  // Verify ledger was passed in <scan_context> to Claude stdin
  const captured = fs.readFileSync(stdinCapture, 'utf8');
  const match = captured.match(/<scan_context>\n([\s\S]+)\n<\/scan_context>/);
  assert.ok(match, 'stdin must include <scan_context>');
  const scanContext = JSON.parse(match[1]);
  assert.deepEqual(scanContext.ledger.discharged_action_keys, [
    'propose-hold',
    'fictional-episode/propose-hold',
  ]);
  assert.deepEqual(scanContext.ledger.declined_action_keys, [
    'nudge-candidate',
    'fictional-episode/nudge-candidate',
  ]);
  assert.equal(scanContext.ledger.active_waits.length, 1);
  assert.equal(scanContext.ledger.active_waits[0].rule, '12h_interviewer_chase');

  // Verify discharged action_keys were stripped from checkpoint.json and DRAFTS.md
  const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  const remainingKeys = checkpoint.report.episodes[0].next_actions.map(a => a.action_key);
  assert.deepEqual(remainingKeys, ['chase-interviewer']);

  const draftsMd = fs.readFileSync(path.join(dir, 'DRAFTS.md'), 'utf8');
  assert.doesNotMatch(draftsMd, /Discharged draft\./);
  assert.doesNotMatch(draftsMd, /Declined draft\./);
  assert.match(draftsMd, /Chase interviewer in Slack after 12h\./);
});

test('crashed intent without terminal dispatched/succeeded/reconciled record surfaces as unresolved_intent and is NOT discharged', t => {
  const dir = temp(t);
  append(dir, {
    idempotency_key: 'act:fictional-ep:crashed-step:1',
    at: '2026-10-16T20:00:00.000Z',
    kind: 'action',
    episode_id: 'fictional-ep',
    action_key: 'crashed-step',
    service: 'greenhouse',
    status: 'intent',
    provider_id: null,
    summary: 'Started interview creation before crash.',
  });
  append(dir, {
    idempotency_key: 'act:fictional-ep:completed-step:1',
    at: '2026-10-16T20:01:00.000Z',
    kind: 'action',
    episode_id: 'fictional-ep',
    action_key: 'completed-step',
    service: 'greenhouse',
    status: 'succeeded',
    provider_id: 'gh-int-999',
    summary: 'Completed interview creation.',
  });
  // Monotonic status check: an out-of-order intent with the same idempotency_key must not downgrade succeeded
  append(dir, {
    idempotency_key: 'act:fictional-ep:completed-step:1',
    at: '2026-10-16T20:01:05.000Z',
    kind: 'action',
    episode_id: 'fictional-ep',
    action_key: 'completed-step',
    service: 'greenhouse',
    status: 'intent',
    provider_id: null,
  });

  assert.deepEqual(dischargedKeys(dir), [
    'completed-step',
    'fictional-ep/completed-step',
  ]);
  const summary = summarizeLedger(dir);
  assert.equal(isActionDischarged(summary, 'fictional-ep', 'crashed-step'), false);
  assert.equal(isActionDischarged(summary, 'fictional-ep', 'completed-step'), true);
  assert.equal(summary.unresolved_intents.length, 1);
  assert.equal(summary.unresolved_intents[0].idempotency_key, 'act:fictional-ep:crashed-step:1');
  assert.equal(summary.unresolved_intents[0].reconciliation_status, 'unresolved_intent');
  assert.deepEqual(summary.unresolved_action_keys, [
    'crashed-step',
    'fictional-ep/crashed-step',
  ]);

  // Once reconciled, it transitions out of unresolved_intents and into discharged_action_keys
  append(dir, {
    idempotency_key: 'act:fictional-ep:crashed-step:1',
    at: '2026-10-16T20:02:00.000Z',
    kind: 'action',
    episode_id: 'fictional-ep',
    action_key: 'crashed-step',
    service: 'greenhouse',
    status: 'reconciled',
    provider_id: 'gh-int-1000',
    summary: 'Reconciled against live Greenhouse interview.',
  });
  const afterReconcile = summarizeLedger(dir);
  assert.equal(afterReconcile.unresolved_intents.length, 0);
  assert.equal(isActionDischarged(afterReconcile, 'fictional-ep', 'crashed-step'), true);
});
