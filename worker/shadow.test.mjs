import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ALLOWED } from './gate.mjs';
// Never import pilot.mjs here: its MODEL is read once at module load, and cycle must be the first to load it.
import { pair, subjectKey } from './shadow.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHADOW = path.join(HERE, 'shadow.mjs');
const SOURCES = ['gmail', 'calendar', 'slack', 'greenhouse'];
// Fictional candidate content. It may live in the private verification snapshots, never in score.json, meta.json, pairs.jsonl or SHADOW.md.
const CANDIDATE = 'Quinby Marsh-Fictional';
const EMAIL = 'quinby.marsh@example.invalid';
const DRAFT = 'Hi Quinby, DRAFT-TEXT-MARKER can you make Thursday at 10?';
const STREAM_ONLY = 'STREAM-ONLY-MARKER';
const PRIVATE = [CANDIDATE, EMAIL, 'DRAFT-TEXT-MARKER', STREAM_ONLY];
const BASE = Date.parse('2026-10-16T15:20:00.000Z'); // 08:20 Pacific
const at = minutes => new Date(BASE + minutes * 60_000).toISOString();
const idOf = iso => iso.replaceAll(':', '-');

function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduling-pilot-shadow-test-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function episode(id, status, actions = [], unknowns = []) {
  return {
    episode_id: id, status,
    facts: [{ text: `${CANDIDATE} <${EMAIL}> replied with availability.`, evidence: ['receipt-1'] }],
    next_actions: actions.map(([key, draft]) => ({ action_key: key, text: `Write to ${CANDIDATE}.`, draft, evidence: ['receipt-1'] })),
    unknowns,
  };
}
function verification({ ok = true, incomplete = [], episodes = [], unknowns = [], errors = [] } = {}) {
  return {
    report: { coverage: Object.fromEntries(SOURCES.map(s => [s, { complete: !incomplete.includes(s), receipt_ids: ['receipt-1'], notes: `Fictional ${s} read for ${CANDIDATE}.` }])), episodes, unknowns },
    ok, errors, warnings: [], partial: incomplete, recovered_reads: [], reads: [],
  };
}
// Writes one run the way pilot.mjs keeps it: runs/<started_at with : as ->-stream.jsonl and, when verified, -verification.json.
function writeRun(dataDir, startedAt, { model = 'claude-sonnet-5-5', verification: v = verification({ episodes: [episode('ep-a', 'open', [['hold', DRAFT]])] }), cost = 1, durationMs = 300_000, turns = 30, finished = true } = {}) {
  const runs = path.join(dataDir, 'runs');
  fs.mkdirSync(runs, { recursive: true, mode: 0o700 });
  const lines = [
    { type: 'system', subtype: 'init', model, session_id: 'fictional-session' },
    { type: 'assistant', message: { content: [{ type: 'text', text: `${CANDIDATE} ${EMAIL} ${STREAM_ONLY}` }] } },
    ...(finished ? [{ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, duration_ms: durationMs, num_turns: turns, result: JSON.stringify(v?.report ?? {}) + STREAM_ONLY, modelUsage: { [model]: { costUSD: cost } } }] : []),
  ];
  fs.writeFileSync(path.join(runs, `${idOf(startedAt)}-stream.jsonl`), lines.map(x => JSON.stringify(x)).join('\n') + '\n', { mode: 0o600 });
  if (v) fs.writeFileSync(path.join(runs, `${idOf(startedAt)}-verification.json`), JSON.stringify(v, null, 2), { mode: 0o600 });
}
function dirs(t) {
  const root = temp(t), shadowDir = path.join(root, 'shadow-data'), liveDir = path.join(root, 'live-data');
  fs.mkdirSync(path.join(liveDir, 'runs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(shadowDir, { recursive: true, mode: 0o700 });
  return { root, shadowDir, liveDir, out: path.join(shadowDir, 'shadow') };
}
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const pairsLines = out => fs.readFileSync(path.join(out, 'pairs.jsonl'), 'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x));
function tree(dir) {
  const out = {};
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(e.parentPath, e.name);
    out[path.relative(dir, p)] = e.isFile() ? fs.readFileSync(p, 'utf8') + `|${fs.statSync(p).mtimeMs}` : 'dir';
  }
  return out;
}

test('pair matches the live run nearest before the shadow start', t => {
  const { shadowDir, liveDir, out } = dirs(t);
  for (const m of [-40, -10, 5]) writeRun(liveDir, at(m));
  writeRun(shadowDir, at(-90), { model: 'claude-haiku-5-5' });
  writeRun(shadowDir, at(0), { model: 'claude-haiku-5-5' });
  const score = pair({ shadowDir, liveDir, out });
  assert.equal(score.shadow_run_id, idOf(at(0)), 'the newest shadow run is paired');
  assert.equal(score.live_run_id, idOf(at(-10)));
  assert.equal(score.gap_minutes, 10);
});

test('with no live run before inside the window, pair falls back to the nearest after, else live is null', t => {
  const a = dirs(t);
  writeRun(a.liveDir, at(-60)); writeRun(a.liveDir, at(20)); writeRun(a.shadowDir, at(0));
  const after = pair(a);
  assert.equal(after.live_run_id, idOf(at(20)));
  assert.equal(after.gap_minutes, -20);

  const b = dirs(t);
  writeRun(b.liveDir, at(-60)); writeRun(b.liveDir, at(50)); writeRun(b.shadowDir, at(0), { cost: 0.5 });
  const none = pair(b);
  assert.equal(none.live_run_id, null);
  assert.equal(none.gap_minutes, null);
  assert.equal(none.shadow_ok, true, 'the shadow side is still scored');
  assert.equal(none.cost_usd.shadow, 0.5);
  assert.equal(none.cost_usd.live, null);
  assert.equal(none.cost_usd.ratio, null);
  assert.equal(none.episodes, null, 'no comparison without a live run');
  assert.equal(readJson(path.join(b.out, 'pairs', none.shadow_run_id, 'meta.json')).live, null);
  assert.equal(fs.existsSync(path.join(b.out, 'pairs', none.shadow_run_id, 'live-verification.json')), false);

  const wide = pair({ ...b, windowMinutes: 90 });
  assert.equal(wide.live_run_id, idOf(at(-60)), 'a wider window admits the earlier live run');
  assert.equal(wide.gap_minutes, 60);
});

test('pair snapshots both verifications and result records, never a stream copy, privately', t => {
  const { shadowDir, liveDir, out } = dirs(t);
  writeRun(liveDir, at(-8), { cost: 2.25, durationMs: 480_000, turns: 44 });
  writeRun(shadowDir, at(0), { model: 'claude-haiku-5-5', cost: 0.4, durationMs: 150_000, turns: 21 });
  const score = pair({ shadowDir, liveDir, out });
  const dir = path.join(out, 'pairs', score.shadow_run_id);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['live-verification.json', 'meta.json', 'score.json', 'shadow-verification.json']);
  for (const file of fs.readdirSync(dir)) {
    assert.doesNotMatch(fs.readFileSync(path.join(dir, file), 'utf8'), new RegExp(STREAM_ONLY), `${file} holds no stream content`);
    assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600, file);
  }
  for (const d of [out, path.join(out, 'pairs'), dir]) assert.equal(fs.statSync(d).mode & 0o777, 0o700, d);
  assert.deepEqual(readJson(path.join(dir, 'live-verification.json')), readJson(path.join(liveDir, 'runs', `${idOf(at(-8))}-verification.json`)));
  assert.deepEqual(readJson(path.join(dir, 'shadow-verification.json')), readJson(path.join(shadowDir, 'runs', `${idOf(at(0))}-verification.json`)));
  const meta = readJson(path.join(dir, 'meta.json'));
  assert.equal(meta.shadow.run_id, idOf(at(0)));
  assert.equal(meta.live.run_id, idOf(at(-8)));
  assert.deepEqual(meta.shadow.result, { model: 'claude-haiku-5-5', subtype: 'success', is_error: false, total_cost_usd: 0.4, duration_ms: 150_000, num_turns: 21 });
  assert.deepEqual(meta.live.result, { model: 'claude-sonnet-5-5', subtype: 'success', is_error: false, total_cost_usd: 2.25, duration_ms: 480_000, num_turns: 44 });
  for (const p of PRIVATE) assert.ok(!fs.readFileSync(path.join(dir, 'meta.json'), 'utf8').includes(p), p);
});

test('score compares coverage, episodes, actions, unknowns, cost, duration and turns', t => {
  const { shadowDir, liveDir, out } = dirs(t);
  writeRun(liveDir, at(-12), { cost: 2, durationMs: 480_000, turns: 40, verification: verification({
    episodes: [
      episode('ep-a', 'open', [['hold', 'one two three'], ['nudge', 'four five']], ['live episode question']),
      episode('ep-b', 'open', [['confirm', 'same draft words']]),
      episode('ep-c', 'closed'),
    ],
    unknowns: ['live global question'],
  }) });
  writeRun(shadowDir, at(0), { model: 'claude-haiku-5-5', cost: 0.5, durationMs: 120_000, turns: 20, verification: verification({
    incomplete: ['slack'],
    episodes: [
      episode('ep-a', 'open', [['hold', 'a different draft of five']]),
      episode('ep-b', 'closed', [['confirm', '  same draft words ']]),
      episode('ep-d', 'open', [['ask', DRAFT]], ['shadow question one', 'shadow question two']),
    ],
  }) });
  const score = pair({ shadowDir, liveDir, out });
  assert.equal(score.shadow_run_id, idOf(at(0)));
  assert.equal(score.live_run_id, idOf(at(-12)));
  assert.equal(score.gap_minutes, 12);
  assert.deepEqual(score.models, { shadow: 'claude-haiku-5-5', live: 'claude-sonnet-5-5' });
  assert.equal(score.shadow_ok, true);
  assert.equal(score.shadow_failed_reason, null);
  assert.equal(score.live_ok, true);
  assert.deepEqual(score.coverage, { gmail: { shadow: true, live: true }, calendar: { shadow: true, live: true }, slack: { shadow: false, live: true }, greenhouse: { shadow: true, live: true } });
  assert.deepEqual(score.coverage_complete_all, { shadow: false, live: true });
  assert.deepEqual(score.episodes, { only_live: ['ep-c'], only_shadow: ['ep-d'], both: ['ep-a', 'ep-b'], status_diff: [{ episode_id: 'ep-b', shadow: 'closed', live: 'open' }] });
  assert.deepEqual(score.actions, {
    only_live: ['ep-a/nudge'], only_shadow: ['ep-d/ask'],
    shared: [{ key: 'ep-a/hold', draft_differs: true, shadow_words: 5, live_words: 3 }, { key: 'ep-b/confirm', draft_differs: false, shadow_words: 3, live_words: 3 }],
  });
  assert.deepEqual(score.unknowns, { shadow: { report: 0, episodes: 2 }, live: { report: 1, episodes: 1 } });
  assert.deepEqual(score.cost_usd, { shadow: 0.5, live: 2, ratio: 0.25 });
  assert.deepEqual(score.duration_ms, { shadow: 120_000, live: 480_000, ratio: 0.25 });
  assert.deepEqual(score.num_turns, { shadow: 20, live: 40, ratio: 0.5 });
  assert.deepEqual(readJson(path.join(out, 'pairs', score.shadow_run_id, 'score.json')), score);
  assert.deepEqual(pairsLines(out), [score]);
  const written = fs.readFileSync(path.join(out, 'pairs', score.shadow_run_id, 'score.json'), 'utf8');
  for (const p of PRIVATE) assert.ok(!written.includes(p), p);
});

test('a shadow run that never verified is a scored failure with its recorded reason', t => {
  const { shadowDir, liveDir, out } = dirs(t);
  writeRun(liveDir, at(-5), { cost: 2 });
  writeRun(shadowDir, at(0), { verification: null, finished: false });
  fs.writeFileSync(path.join(shadowDir, 'state.json'), JSON.stringify({ started_at: at(0), running: false, last_error: 'Claude process failed; see private latest-stderr.txt.' }));
  const score = pair({ shadowDir, liveDir, out });
  assert.equal(score.shadow_run_id, idOf(at(0)), 'a stream without verification is still a run');
  assert.equal(score.shadow_ok, false);
  assert.equal(score.shadow_failed_reason, 'Claude process failed; see private latest-stderr.txt.');
  assert.equal(score.live_ok, true);
  assert.deepEqual(score.coverage.gmail, { shadow: null, live: true });
  assert.deepEqual(score.coverage_complete_all, { shadow: null, live: true });
  assert.equal(score.episodes, null);
  assert.equal(score.actions, null);
  assert.deepEqual(score.unknowns.shadow, null);
  assert.deepEqual(score.cost_usd, { shadow: null, live: 2, ratio: null });
  const dir = path.join(out, 'pairs', score.shadow_run_id);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['live-verification.json', 'meta.json', 'score.json']);
  assert.match(fs.readFileSync(path.join(out, 'SHADOW.md'), 'utf8'), /Shadow failures: 1\b/);

  // Verification present but rejected, with state.json describing a different run: the verification errors are the reason.
  writeRun(shadowDir, at(30), { verification: verification({ ok: false, errors: ['Incomplete gmail coverage.', 'Missing actual read: __list_events'] }) });
  const rejected = pair({ shadowDir, liveDir, out });
  assert.equal(rejected.shadow_ok, false);
  assert.equal(rejected.shadow_failed_reason, 'Incomplete gmail coverage. Missing actual read: __list_events');
});

test('re-pairing a shadow run replaces its pair dir and its pairs.jsonl line, and keeps a pruned live snapshot', t => {
  const { shadowDir, liveDir, out } = dirs(t);
  writeRun(liveDir, at(-6), { cost: 3 });
  writeRun(shadowDir, at(0), { model: 'claude-haiku-5-5' });
  const first = pair({ shadowDir, liveDir, out });
  pair({ shadowDir, liveDir, out });
  assert.equal(pairsLines(out).length, 1);
  writeRun(shadowDir, at(0), { model: 'claude-haiku-5-5', verification: verification({ episodes: [episode('ep-a', 'open', [['hold', DRAFT]]), episode('ep-z', 'open')] }) });
  const second = pair({ shadowDir, liveDir, out });
  assert.deepEqual(second.episodes.only_shadow, ['ep-z']);
  assert.deepEqual(pairsLines(out).map(x => x.episodes.only_shadow), [['ep-z']], 'one line, replaced');
  assert.deepEqual(readJson(path.join(out, 'pairs', first.shadow_run_id, 'shadow-verification.json')).report.episodes.map(e => e.episode_id), ['ep-a', 'ep-z']);
  // pilot.mjs prunes runs/ to 10; a live run gone from runs/ is still paired from the snapshot.
  for (const f of fs.readdirSync(path.join(liveDir, 'runs'))) fs.rmSync(path.join(liveDir, 'runs', f));
  const third = pair({ shadowDir, liveDir, out });
  assert.equal(third.live_run_id, idOf(at(-6)));
  assert.equal(third.cost_usd.live, 3);
  assert.equal(third.live_ok, true);
  assert.ok(fs.existsSync(path.join(out, 'pairs', third.shadow_run_id, 'live-verification.json')));
  assert.equal(pairsLines(out).length, 1);
});

test('SHADOW.md regenerates one row per pair, newest first, with totals and no candidate content', t => {
  const { shadowDir, liveDir, out } = dirs(t);
  writeRun(liveDir, at(-5), { cost: 2, durationMs: 600_000, turns: 40 });
  writeRun(shadowDir, at(0), { model: 'claude-haiku-5-5', cost: 0.5, durationMs: 180_000, turns: 20 });
  pair({ shadowDir, liveDir, out });
  writeRun(liveDir, at(85), { cost: 2, durationMs: 600_000, turns: 40 });
  writeRun(shadowDir, at(90), { model: 'claude-haiku-5-5', verification: null, finished: false });
  pair({ shadowDir, liveDir, out });
  writeRun(liveDir, at(175), { cost: 2, durationMs: 600_000, turns: 40, verification: verification({ episodes: [episode('ep-a', 'open', [['hold', DRAFT]]), episode('ep-b', 'open')] }) });
  writeRun(shadowDir, at(180), { model: 'claude-haiku-5-5', cost: 0.7, durationMs: 240_000, turns: 26 });
  pair({ shadowDir, liveDir, out });
  pair({ shadowDir, liveDir, out });
  const text = fs.readFileSync(path.join(out, 'SHADOW.md'), 'utf8');
  const rows = text.split('\n').filter(line => /^\| 2026-/.test(line));
  assert.equal(rows.length, 3);
  assert.equal(pairsLines(out).length, 3);
  assert.match(rows[0], /^\| 2026-10-16 11:20 \|/, 'newest first, in Pacific time');
  assert.match(rows[2], /^\| 2026-10-16 08:20 \|/);
  assert.match(text, /claude-haiku-5-5/);
  assert.match(text, /claude-sonnet-5-5/);
  assert.match(text, /Pairs: 3\b/);
  assert.match(text, /Shadow failures: 1\b/);
  assert.match(text, /shadow 2 of 3\b/);
  assert.match(text, /live 3 of 3\b/);
  assert.match(text, /\$0\.60/, 'mean shadow cost over the runs that reported one');
  assert.match(text, /\$2\.00/);
  assert.match(text, /Episode mismatches: 1\b/);
  for (const p of PRIVATE) {
    assert.ok(!text.includes(p), `SHADOW.md: ${p}`);
    assert.ok(!fs.readFileSync(path.join(out, 'pairs.jsonl'), 'utf8').includes(p), `pairs.jsonl: ${p}`);
  }
  assert.equal(fs.statSync(path.join(out, 'SHADOW.md')).mode & 0o777, 0o600);
});

// The same fictional, verifiable read set that pilot.test.mjs uses.
function fixtureEvents() {
  const names = Object.fromEntries(ALLOWED.map(n => [n.split('__').at(-1), n]));
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
  const report = { coverage: Object.fromEntries([['gmail', 'get_thread'], ['calendar', 'list_events'], ['slack', 'slack_search_public_and_private'], ['greenhouse', 'search_my_interviews']].map(([s, n]) => [s, { complete: true, receipt_ids: [names[n]], notes: 'Fictional complete read.' }])), episodes: [{ episode_id: 'fictional-episode', status: 'open', facts: [{ text: 'Fictional candidate offered Thursday.', evidence: [names.get_thread] }], next_actions: [{ action_key: 'propose-hold', text: 'Review Thursday hold.', draft: 'Draft for review only.', evidence: [names.get_thread] }], unknowns: [] }], unknowns: [] };
  events.push({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.31, duration_ms: 90_000, num_turns: 17, result: JSON.stringify(report) });
  return events;
}
// A fake Claude CLI that records its argv, then streams an init line naming the model it was given and the fixture.
function fakeClaude(dir, exitCode = 0) {
  const cli = path.join(dir, 'claude-fake'), argvFile = path.join(dir, 'argv.json');
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv), { mode: 0o600 });
const model = argv[argv.indexOf('--model') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  if (${exitCode}) { process.exitCode = ${exitCode}; return; }
  const lines = [{ type: 'system', subtype: 'init', model }, ...${JSON.stringify(fixtureEvents())}];
  process.stdout.write(lines.map(x => JSON.stringify(x)).join('\\n') + '\\n');
});
`, { mode: 0o700 });
  return { cli, argvFile };
}
function runShadow(t, args, env = {}) {
  return spawnSync(process.execPath, [SHADOW, ...args], { encoding: 'utf8', env: { ...process.env, PILOT_MODEL: '', HOME: temp(t), ...env } });
}
function liveFixture(t) {
  const d = dirs(t);
  writeRun(d.liveDir, new Date(Date.now() - 5 * 60_000).toISOString(), { cost: 1.8, durationMs: 400_000, turns: 35 });
  fs.writeFileSync(path.join(d.liveDir, 'state.json'), JSON.stringify({ last_success: new Date().toISOString() }), { mode: 0o600 });
  fs.writeFileSync(path.join(d.liveDir, 'checkpoint.json'), JSON.stringify({ report: { episodes: [] } }), { mode: 0o600 });
  return d;
}

test('cycle sets PILOT_MODEL before loading the pilot, runs in the shadow dir only, and pairs the run', t => {
  const { root, shadowDir, liveDir } = liveFixture(t);
  const { cli, argvFile } = fakeClaude(root);
  const liveBefore = tree(liveDir);
  const result = runShadow(t, ['cycle', '--model', 'claude-haiku-5-5', '--shadow-dir', shadowDir, '--live-dir', liveDir, '--claude', cli]);
  assert.equal(result.status, 0, result.stderr);
  const argv = JSON.parse(fs.readFileSync(argvFile, 'utf8'));
  assert.equal(argv[argv.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(argv[argv.indexOf('--settings') + 1], path.join(shadowDir, 'settings.json'), 'the shadow run uses its own data dir');
  const printed = JSON.parse(result.stdout);
  const score = readJson(path.join(shadowDir, 'shadow', 'pairs', printed.shadow_run_id, 'score.json'));
  assert.equal(score.shadow_ok, true, score.shadow_failed_reason);
  assert.equal(score.models.shadow, 'claude-haiku-5-5');
  assert.equal(score.cost_usd.shadow, 0.31);
  assert.equal(score.cost_usd.live, 1.8);
  assert.ok(Math.abs(score.gap_minutes) < 10, String(score.gap_minutes));
  assert.ok(fs.existsSync(path.join(shadowDir, 'checkpoint.json')));
  assert.ok(fs.existsSync(path.join(shadowDir, 'shadow', 'SHADOW.md')));
  assert.deepEqual(tree(liveDir), liveBefore, 'the live data dir is untouched');
});

test('cycle exits 0 and scores a shadow run whose CLI failed', t => {
  const { root, shadowDir, liveDir } = liveFixture(t);
  const { cli } = fakeClaude(root, 1);
  const liveBefore = tree(liveDir);
  const result = runShadow(t, ['cycle', '--model', 'claude-haiku-5-5', '--shadow-dir', shadowDir, '--live-dir', liveDir, '--claude', cli]);
  assert.equal(result.status, 0, result.stderr);
  const printed = JSON.parse(result.stdout);
  assert.match(printed.run_error, /Claude process failed/);
  const score = readJson(path.join(shadowDir, 'shadow', 'pairs', printed.shadow_run_id, 'score.json'));
  assert.equal(score.shadow_ok, false);
  assert.match(score.shadow_failed_reason, /Claude process failed/);
  assert.equal(pairsLines(path.join(shadowDir, 'shadow')).length, 1);
  assert.deepEqual(tree(liveDir), liveBefore);
});

test('harness errors exit nonzero: bad arguments, overlapping dirs, missing live runs, a pilot loaded with another model', t => {
  const { root, shadowDir, liveDir } = liveFixture(t);
  const { cli, argvFile } = fakeClaude(root);
  const liveBefore = tree(liveDir);
  const base = ['--model', 'claude-haiku-5-5', '--claude', cli];
  for (const [label, args] of [
    ['unknown command', ['bogus']],
    ['unknown argument', ['pair', '--shadow-dir', shadowDir, '--live-dir', liveDir, '--surprise']],
    ['missing model', ['cycle', '--shadow-dir', shadowDir, '--live-dir', liveDir, '--claude', cli]],
    ['same dir', ['cycle', ...base, '--shadow-dir', liveDir, '--live-dir', liveDir]],
    ['shadow inside live', ['cycle', ...base, '--shadow-dir', path.join(liveDir, 'nested'), '--live-dir', liveDir]],
    ['live inside shadow', ['cycle', ...base, '--shadow-dir', root, '--live-dir', liveDir]],
    ['out inside live', ['cycle', ...base, '--shadow-dir', shadowDir, '--live-dir', liveDir, '--out', path.join(liveDir, 'shadow')]],
    ['live runs missing', ['cycle', ...base, '--shadow-dir', shadowDir, '--live-dir', path.join(root, 'absent')]],
    ['bad window', ['pair', '--shadow-dir', shadowDir, '--live-dir', liveDir, '--window-minutes', '0']],
  ]) {
    const result = runShadow(t, args);
    assert.notEqual(result.status, 0, label);
    assert.ok(result.stderr.trim(), `${label}: an error is printed`);
  }
  assert.equal(fs.existsSync(argvFile), false, 'no Claude run started');
  assert.deepEqual(tree(liveDir), liveBefore);
  const preloaded = spawnSync(process.execPath, ['--input-type=module', '-e', `
    await import(${JSON.stringify(path.join(HERE, 'pilot.mjs'))});
    const shadow = await import(${JSON.stringify(SHADOW)});
    await shadow.main(${JSON.stringify(['cycle', ...base, '--shadow-dir', shadowDir, '--live-dir', liveDir])});
  `], { encoding: 'utf8', env: { ...process.env, PILOT_MODEL: '', HOME: temp(t) } });
  assert.notEqual(preloaded.status, 0);
  assert.match(preloaded.stderr, /already loaded/);
  assert.equal(fs.existsSync(argvFile), false, 'a pilot pinned to another model never runs');
  assert.equal(fs.existsSync(path.join(shadowDir, 'runs')), false);
});

test('subjectKey reduces model-chosen episode ids to the application, Gmail thread or Slack message they track', () => {
  for (const [id, subject] of [
    // Sonnet's naming, from the first live pair.
    ['178089685004:screening-round-14297391004', 'app:178089685004'],
    ['gmail:1a11d9f2c33774e5', 'thread:1a11d9f2c33774e5'],
    ['slack:C0C9VEPBAJC:1791999286.444579', 'slack:C0C9VEPBAJC:1791999286.444579'],
    // Haiku's naming of the same work.
    ['178089685004:dana-screen', 'app:178089685004'],
    ['177214133004:take-home-pending', 'app:177214133004'],
    ['1a11d9f2c33774e5', 'thread:1a11d9f2c33774e5'],
    // Bare fallback: the raw id, lowercased.
    ['Dana-Take-Home', 'dana-take-home'],
    // A Slack ts is not an application id, and ten digits inside a hex thread id are not one either.
    ['1791999286.444579', '1791999286.444579'],
    ['19a1234567890bcd', 'thread:19a1234567890bcd'],
    ['GMAIL:1A11D9F2C33774E5', 'thread:1a11d9f2c33774e5'],
    ['177214133004-1a11d9f2c33774e5', 'app:177214133004'],
    [null, ''],
  ]) {
    assert.equal(subjectKey(id), subject, String(id));
    assert.equal(subjectKey(id), subjectKey(id), 'deterministic');
  }
});

// The two naming schemes the first live pair used for the same applications and threads.
function namingPair(t) {
  const d = dirs(t);
  writeRun(d.liveDir, at(-10), { verification: verification({ episodes: [
    episode('178089685004:screening-round-14297391004', 'open', [['propose-slot', 'one two three']]),
    episode('gmail:1a11d9f2c33774e5', 'open', [['nudge', 'a b']]),
    episode('slack:C0C9VEPBAJC:1791999286.444579', 'open'),
    episode('177214133004:take-home-review', 'closed'),
  ] }) });
  writeRun(d.shadowDir, at(0), { model: 'claude-haiku-5-5', verification: verification({ episodes: [
    episode('178089685004:dana-screen', 'open', [['send-slots', 'x y z w'], ['hold', 'q']]),
    episode('178089685004:onsite', 'closed'),
    episode('177214133004:take-home-pending', 'open', [['chase', DRAFT]]),
    episode('1a11d9f2c33774e5', 'open'),
    episode('dana-take-home', 'open'),
  ] }) });
  return { ...d, score: pair(d) };
}

test('episodes are also compared by subject, so different naming of the same work still matches', t => {
  const { out, score } = namingPair(t);
  assert.deepEqual(score.episodes.both, [], 'raw ids share nothing');
  assert.equal(score.episodes.only_live.length, 4);
  assert.equal(score.episodes.only_shadow.length, 5);
  assert.deepEqual(score.episodes_by_subject, {
    only_live: ['slack:C0C9VEPBAJC:1791999286.444579'],
    only_shadow: ['dana-take-home'],
    both: ['app:178089685004', 'thread:1a11d9f2c33774e5', 'app:177214133004'],
    status_diff: [
      { subject: 'app:178089685004', shadow: 'closed+open', live: 'open' },
      { subject: 'app:177214133004', shadow: 'open', live: 'closed' },
    ],
  });
  assert.deepEqual(score.actions_by_subject, {
    subjects_with_actions_only_live: ['thread:1a11d9f2c33774e5'],
    subjects_with_actions_only_shadow: ['app:177214133004'],
    subjects_with_actions_both: [{ subject: 'app:178089685004', shadow_action_count: 2, live_action_count: 1, shadow_draft_words: 5, live_draft_words: 3 }],
  });
  assert.deepEqual(readJson(path.join(out, 'pairs', score.shadow_run_id, 'score.json')), score);
  const written = fs.readFileSync(path.join(out, 'pairs', score.shadow_run_id, 'score.json'), 'utf8');
  for (const p of PRIVATE) assert.ok(!written.includes(p), p);
});

test('subject comparison is null when either side has no verification', t => {
  const { shadowDir, liveDir, out } = dirs(t);
  writeRun(liveDir, at(-5));
  writeRun(shadowDir, at(0), { verification: null, finished: false });
  const score = pair({ shadowDir, liveDir, out });
  assert.equal(score.episodes_by_subject, null);
  assert.equal(score.actions_by_subject, null);
  const row = fs.readFileSync(path.join(out, 'SHADOW.md'), 'utf8').split('\n').find(line => /^\| 2026-/.test(line)).split(' | ');
  assert.equal(row[5], '–', 'the subject cell shows a dash');
});

test('SHADOW.md carries the subject mismatch line after the episode line and a subject column after the episode column', t => {
  const { out } = namingPair(t);
  const lines = fs.readFileSync(path.join(out, 'SHADOW.md'), 'utf8').split('\n');
  const episodeLine = lines.findIndex(line => line.startsWith('- Episode mismatches: '));
  assert.equal(lines[episodeLine], '- Episode mismatches: 9 (only in live 4, only in shadow 5, status differs 0)');
  assert.equal(lines[episodeLine + 1], '- Subject mismatches: 4 (only in live 1, only in shadow 1, status differs 2)');
  const cells = line => line.split('|').slice(1, -1).map(x => x.trim());
  const header = cells(lines.find(line => line.startsWith('| Shadow start')));
  const at = header.indexOf('Episodes only L / only S / status');
  assert.equal(header[at + 1], 'Subjects only L / only S / status');
  assert.equal(cells(lines.find(line => /^\|---/.test(line))).length, header.length);
  const row = cells(lines.find(line => /^\| 2026-/.test(line)));
  assert.equal(row.length, header.length);
  assert.equal(row[at], '4 / 5 / 0');
  assert.equal(row[at + 1], '1 / 1 / 2');
  for (const p of PRIVATE) assert.ok(!lines.join('\n').includes(p), p);
});
