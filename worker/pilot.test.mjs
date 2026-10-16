import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DENIED, verify, changes, run as runPilot, initialize, atomic, takeLock, recoverLock, assess, health, main, markdown } from './pilot.mjs';
import { permitted, ALLOWED } from './gate.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Runs clean persisted tool results under a Claude projects directory; tests never point it at the real one.
const PROJECTS = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduling-pilot-projects-'));
after(() => fs.rmSync(PROJECTS, { recursive: true, force: true }));
const run = options => runPilot({ claudeProjectsDir: PROJECTS, ...options });
const names = Object.fromEntries(ALLOWED.map(n => [n.split('__').at(-1), n]));
function fixture() {
  const calls = [
    ['search_threads', { query: 'fictional scheduling' }, { threads: [{ id: 'thread-fictional' }] }],
    ['get_thread', { threadId: 'thread-fictional', format: 'FULL_CONTENT' }, { id: 'thread-fictional', messages: [{ textBody: 'Thursday works for Fictional Candidate.' }] }],
    ['list_events', { calendarId: 'primary' }, { events: [] }],
    ['slack_search_public_and_private', { filters: { in: 'field-engineering-hiring' } }, { results: [], pagination_info: '' }],
    ['get_my_job', { id: 5149015004 }, { data: { id: 5149015004 }, ok: true }],
    ['search_my_interviews', { job_ids: [5149015004] }, { data: [], nextCursor: null, ok: true, read: { complete: true } }],
  ];
  const events = calls.flatMap(([n, input, result], i) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: `read-${i}`, name: names[n], input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `read-${i}`, content: JSON.stringify(result) }] } },
  ]);
  const report = { coverage: Object.fromEntries([['gmail', 'get_thread'], ['calendar', 'list_events'], ['slack', 'slack_search_public_and_private'], ['greenhouse', 'search_my_interviews']].map(([s, n]) => [s, { complete: true, receipt_ids: [names[n]], notes: 'Fictional complete read.' }])), episodes: [{ episode_id: 'fictional-episode', status: 'open', facts: [{ text: 'Fictional candidate offered Thursday.', evidence: [names.get_thread] }], next_actions: [{ action_key: 'propose-hold', text: 'Review Thursday hold.', draft: 'Draft for review only.', evidence: [names.get_thread] }], unknowns: [] }], unknowns: [] };
  events.push({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report) });
  return { events, report };
}
function resultOf(events, suffix) {
  const call = events.flatMap(e => e.message?.content ?? []).find(b => b.type === 'tool_use' && b.name.endsWith(suffix));
  return events.flatMap(e => e.message?.content ?? []).find(b => b.type === 'tool_result' && b.tool_use_id === call.id);
}
function temp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduling-pilot-test-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function fake(t, events, exitCode = 0) {
  const d = temp(t), cli = path.join(d, 'claude-fake');
  fs.writeFileSync(cli, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(${JSON.stringify(events.map(x => JSON.stringify(x)).join('\n') + '\n')}); process.exitCode=${exitCode}; });\n`, { mode: 0o700 });
  return cli;
}
test('real tool receipts from every service and full Gmail body pass; aliases bind to receipts', () => {
  const f = fixture(), v = verify(f.events, f.report);
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.deepEqual(v.report.episodes[0].next_actions[0].evidence, ['read-1']);
});
test('successful prose with no reads is rejected', () => {
  const f = fixture();
  assert.equal(verify([f.events.at(-1)], f.report).ok, false);
});
test('write tools and wrong Greenhouse job scope are refused both by hook and verifier', () => {
  assert.equal(permitted('mcp__claude_ai_Gmail__send_email', {}), false);
  assert.equal(permitted(names.get_my_job, { id: 42 }), false);
  assert.equal(permitted(names.search_my_interviews, { job_ids: [5149015004, 42] }), false);
  const f = fixture();
  f.events[0].message.content[0].name = 'Bash';
  assert.equal(verify(f.events, f.report).ok, false);
  const g = fixture(); g.events[8].message.content[0].input.id = 42;
  assert.equal(verify(g.events, g.report).ok, false);
  const denied = spawnSync(process.execPath, [path.join(HERE, 'gate.mjs')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: {} }), encoding: 'utf8' });
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
test('unexplained partial coverage, provider errors and Gmail metadata are not healthy scans', () => {
  const f = fixture(); f.report.coverage.slack.complete = false; f.report.coverage.slack.notes = '';
  assert.equal(verify(f.events, f.report).ok, false);
  f.report.coverage.slack.complete = 'unsure';
  assert.equal(verify(f.events, f.report).ok, false, 'only an explicit false is a partial source');
  const g = fixture(); resultOf(g.events, '__get_thread').content = JSON.stringify({ messages: [{ subject: 'Metadata only' }] });
  assert.equal(verify(g.events, g.report).ok, false);
  const h = fixture(); resultOf(h.events, '__get_my_job').content = JSON.stringify({ ok: false, error: 'Denied' });
  assert.equal(verify(h.events, h.report).ok, false);
});
test('Gmail, Slack prose cursor, and Greenhouse slice pagination cannot be skipped', () => {
  for (const [suffix, data] of [
    ['__search_threads', { threads: [], nextPageToken: 'next-fictional' }],
    ['__slack_search_public_and_private', { results: [], pagination_info: 'For the next page of results use cursor `next-fictional`' }],
    ['__search_my_interviews', { data: [], read: { complete: true, result_truncated: { next_offset: 5 } } }],
  ]) {
    const f = fixture(); resultOf(f.events, suffix).content = JSON.stringify(data);
    assert.equal(verify(f.events, f.report).ok, false, suffix);
  }
});
test('pagination only counts when matching scoped query was followed', () => {
  const f = fixture(); resultOf(f.events, '__search_threads').content = JSON.stringify({ threads: [], nextPageToken: 'next-fictional' });
  f.events.splice(-1, 0,
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'page2', name: names.search_threads, input: { query: 'different-query', pageToken: 'next-fictional' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'page2', content: '{"threads":[]}' }] } });
  const unfollowed = verify(f.events, f.report);
  assert.equal(unfollowed.ok, true, 'an uncited unfollowed page is a warning');
  assert.deepEqual(unfollowed.warnings, [{ id: 'read-0', name: names.search_threads, reason: 'Unread or unresolved pagination' }]);
  const cited = structuredClone(f.report); cited.coverage.gmail.receipt_ids.push('read-0');
  assert.equal(verify(f.events, cited).ok, false, 'a cited unfollowed page is fatal');
  f.events.at(-3).message.content[0].input.query = 'fictional scheduling';
  const followed = verify(f.events, cited);
  assert.equal(followed.ok, true, followed.errors.join('\n'));
  assert.deepEqual(followed.warnings, []);
});
test('draft comparison ignores changing receipt IDs and scan timestamps', () => {
  const f = fixture(), next = structuredClone(f.report);
  next.episodes[0].next_actions[0].evidence = ['new-receipt'];
  next.scanned_at = 'later';
  assert.deepEqual(changes(f.report, next), { new_or_changed: [], removed: [] });
  next.episodes[0].next_actions[0].draft = 'Changed suggestion.';
  assert.equal(changes(f.report, next).new_or_changed.length, 1);
});
test('public run accepts fake successful CLI then retains last-good checkpoint and drafts on failed scan', async t => {
  const dir = temp(t), f = fixture();
  const success = await run({ dataDir: dir, claude: fake(t, f.events) });
  assert.equal(success.success, true);
  const checkpoint = fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8');
  const drafts = fs.readFileSync(path.join(dir, 'DRAFTS.md'), 'utf8');
  await assert.rejects(run({ dataDir: dir, claude: fake(t, [f.events.at(-1)]) }), /verification failed/);
  assert.equal(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'), checkpoint);
  assert.equal(fs.readFileSync(path.join(dir, 'DRAFTS.md'), 'utf8'), drafts);
  assert.equal(health({ dataDir: dir }).status, 'attention');
  await run({ dataDir: dir, claude: fake(t, f.events) });
  assert.equal(health({ dataDir: dir }).status, 'healthy');
  for (const file of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, file === 'runs' ? 0o700 : 0o600, file);
  for (const file of fs.readdirSync(path.join(dir, 'runs'))) assert.equal(fs.statSync(path.join(dir, 'runs', file)).mode & 0o777, 0o600, file);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});
test('an empty later scan cannot erase an unresolved episode', async t => {
  const dir = temp(t), f = fixture(); await run({ dataDir: dir, claude: fake(t, f.events) });
  f.report.episodes = []; f.events.at(-1).result = JSON.stringify(f.report);
  await assert.rejects(run({ dataDir: dir, claude: fake(t, f.events) }), /Previously open episodes/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'))).report.episodes.length, 1);
});
test('lock prevents overlap and cannot recover a live owner', t => {
  const dir = temp(t); initialize(dir); const release = takeLock(dir);
  assert.throws(() => takeLock(dir), /lock exists/);
  assert.throws(() => recoverLock(dir), /live/);
  release(); const again = takeLock(dir); again();
});
test('health detects never-started, failed, hung, and overdue scans', () => {
  const now = Date.now(), config = { installed_at: new Date(now - 80 * 60_000).toISOString(), interval_minutes: 30 };
  assert.equal(assess(config, {}, null, now).status, 'attention');
  assert.equal(assess(config, { last_success: new Date(now).toISOString(), last_error: 'failed' }, null, now).status, 'attention');
  assert.equal(assess(config, { running: true, last_progress: new Date(now - 16 * 60_000).toISOString() }, null, now).status, 'attention');
  assert.equal(assess(config, { last_success: config.installed_at }, null, now).status, 'attention');
});
test('health alarm keys deduplicate until recovery without any live notification', t => {
  const dir = temp(t); initialize(dir);
  atomic(path.join(dir, 'state.json'), { last_error: 'failed' });
  const first = health({ dataDir: dir });
  atomic(path.join(dir, 'health.json'), { ...first, notified_key: first.alert_key });
  const second = health({ dataDir: dir }); assert.equal(second.notified_key, first.alert_key);
  atomic(path.join(dir, 'state.json'), { last_success: new Date().toISOString() });
  assert.equal(health({ dataDir: dir }).notified_key, null);
  atomic(path.join(dir, 'state.json'), { last_error: 'failed again' });
  assert.equal(health({ dataDir: dir }).notified_key, null);
});
test('nested JSON-stringified MCP content envelopes expose errors and pagination', () => {
  const f = fixture(); resultOf(f.events, '__search_my_interviews').content = JSON.stringify([{ type: 'text', text: JSON.stringify({ ok: false, error: 'Permission denied' }) }]);
  assert.equal(verify(f.events, f.report).ok, false);
  const g = fixture(); resultOf(g.events, '__search_my_interviews').content = JSON.stringify([{ type: 'text', text: JSON.stringify({ ok: true, data: [], read: { complete: true, result_truncated: { next_offset: 5 } } }) }]);
  assert.equal(verify(g.events, g.report).ok, false);
});
test('closing an episode requires current resolution evidence and no next actions', () => {
  const f = fixture(); f.report.episodes[0].status = 'closed';
  assert.equal(verify(f.events, f.report).ok, false);
  f.report.episodes[0].next_actions = [];
  f.report.episodes[0].resolution = { text: 'Fictional resolution observed.', evidence: [names.get_thread] };
  assert.equal(verify(f.events, f.report).ok, true);
});

test('stopping the worker terminates only its child and preserves a visible failure', { timeout: 15000 }, async t => {
  const dir = temp(t), fakeDir = temp(t), cli = path.join(fakeDir, 'hanging-claude');
  initialize(dir); atomic(path.join(dir, 'state.json'), { last_error: 'Previous scan incomplete.' });
  fs.writeFileSync(cli, `#!${process.execPath}\nprocess.stdin.resume(); process.stdout.write('{"type":"system"}\\n'); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
  const worker = spawn(process.execPath, [path.join(HERE, 'pilot.mjs'), 'run', '--data-dir', dir, '--claude', cli], { stdio: 'ignore', env: { ...process.env, HOME: temp(t) } });
  t.after(() => { try { worker.kill('SIGKILL'); } catch {} });
  const done = new Promise(resolve => worker.once('exit', code => resolve(code)));
  let child;
  for (let i = 0; i < 100; i++) {
    try { child = JSON.parse(fs.readFileSync(path.join(dir, 'run.lock'))).child_pid; } catch {}
    if (child) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(child, 'child started');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).last_error, 'Previous scan incomplete.');
  assert.equal(health({ dataDir: dir }).status, 'attention', 'retry start is not verified recovery');
  worker.kill('SIGTERM');
  assert.equal(await done, 1);
  assert.throws(() => process.kill(child, 0), { code: 'ESRCH' });
  assert.match(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))).last_error, /SIGTERM/);
  assert.equal(fs.existsSync(path.join(dir, 'run.lock')), false);
});

test('an unstructured provider response is not evidence of a successful source read', () => {
  for (const suffix of ['__list_events', '__slack_search_public_and_private', '__get_my_job', '__search_my_interviews']) {
    const f = fixture(); resultOf(f.events, suffix).content = 'Service temporarily unavailable.';
    assert.equal(verify(f.events, f.report).ok, false, suffix);
  }
});

test('the actual Claude stdin explains every allowed tool and exact Slack discovery', async t => {
  const dir = temp(t), fakeDir = temp(t), cli = path.join(fakeDir, 'capturing-claude');
  const captured = path.join(fakeDir, 'stdin.txt');
  const f = fixture();
  fs.writeFileSync(cli, `#!${process.execPath}\nconst fs=require('node:fs'); let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => input+=x); process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(captured)},input,{mode:0o600}); process.stdout.write(${JSON.stringify(f.events.map(x => JSON.stringify(x)).join('\n') + '\n')}); });\n`, { mode: 0o700 });
  await run({ dataDir: dir, claude: cli });
  const input = fs.readFileSync(captured, 'utf8');
  const context = JSON.parse(input.match(/<scan_context>\n([\s\S]*?)\n<\/scan_context>/)[1]);
  assert.deepEqual(context.allowed_tools, ALLOWED);
  assert.match(input, /select:mcp__claude_ai_Slack__slack_search_public_and_private/);
  assert.match(input, /in:field-engineering-hiring/);
  assert.match(input, /Do not call slack_search_channels or slack_read_channel/);
  assert.equal(permitted('mcp__claude_ai_Slack__slack_read_channel', {}), false);
  assert.match(context.scan_since_date_pacific, /^\d{4}\/\d{2}\/\d{2}$/);
  const pacific = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(context.scan_since)).map(p => [p.type, p.value]));
  assert.equal(context.scan_since_date_pacific, `${pacific.year}/${pacific.month}/${pacific.day}`);
  assert.match(input, /use scan_context\.scan_since_date_pacific for every Gmail after: and Slack after: filter/i);
  assert.doesNotMatch(input, /<scan_since_date>/);
  assert.ok(input.includes('Candidate interview confirmations are sent from Greenhouse with its default confirmation template, never as a drafted email. Propose the Greenhouse step; do not write a confirmation body. When the interviewer has changed since the candidate was last told, propose at most one added sentence naming the new interviewer.'))
  assert.ok(input.includes("Every proposed action, including the Greenhouse confirmation send, is one the agent will carry out itself once Sam approves it; Sam's part is the approval, never the execution."))
  assert.ok(input.includes('Every thread any search returns must be opened in full with get_thread, including calendar replies (subjects starting Accepted:, Declined:, Tentative:, Updated invitation:)'))
  assert.ok(input.includes('A query whose results you will not all open is a query you may not issue, so keep the role terms in every Gmail query and never search the inbox on scheduling words alone.'))
  assert.ok(input.includes('When an interviewer invite has sat unaccepted (needsAction) for 12 hours or more, propose a direct Slack message to that interviewer asking whether they can make the time'));
  assert.ok(input.includes("State times in the time zone the candidate used in their own message; add Pacific in parentheses only when the candidate's zone is not Pacific."));
  assert.ok(input.includes('n of m messages returned; the remainder are unsent drafts or inaccessible'));
  assert.doesNotMatch(input, /Exhaust every list_drafts page|must explain messageCount/);
});

test('mutation denials reach CLI arguments and settings without blocking approved reads', async t => {
  const dir = temp(t), fakeDir = temp(t), cli = path.join(fakeDir, 'capturing-claude');
  const captured = path.join(fakeDir, 'argv.json');
  const f = fixture();
  fs.writeFileSync(cli, `#!${process.execPath}\nconst fs=require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(captured)},JSON.stringify(process.argv.slice(2)),{mode:0o600}); process.stdout.write(${JSON.stringify(f.events.map(x => JSON.stringify(x)).join('\n') + '\n')}); });\n`, { mode: 0o700 });
  await run({ dataDir: dir, claude: cli });
  const args = JSON.parse(fs.readFileSync(captured));
  const denied = args[args.indexOf('--disallowedTools') + 1].split(',');
  assert.equal(args[args.indexOf('--model') + 1], 'claude-sonnet-5-5', 'the pilot pins its model instead of inheriting the user setting');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json')));
  assert.deepEqual(denied, DENIED);
  assert.deepEqual(settings.permissions.deny, DENIED);
  assert.equal(DENIED.indexOf('TaskStop'), DENIED.indexOf('Task') + 1, 'TaskStop is denied next to Agent and Task');
  assert.equal(permitted('TaskStop', {}), false);
  // A failing or crashing gate hook must block the tool call, not let it through.
  assert.deepEqual(settings.hooks.PreToolUse.map(entry => entry.hooks.map(hook => [hook.type, hook.onFailure])), [[['command', 'block']]]);
  const matches = (name, pattern) => new RegExp('^' + pattern.split('*').join('.*') + '$').test(name);
  for (const tool of ['mcp__claude_ai_Gmail__send_message', 'mcp__greenhouse-recruiter__apply_candidate_update', 'mcp__claude_ai_Slack__slack_send_message']) {
    assert.ok(DENIED.some(pattern => matches(tool, pattern)), tool);
    assert.equal(permitted(tool, {}), false);
  }
  for (const tool of ALLOWED) assert.equal(DENIED.some(pattern => matches(tool, pattern)), false, tool);
});

test('CLI status is read-only and preserves the independent monitor heartbeat', async t => {
  const dir = temp(t); initialize(dir);
  const tick = health({ dataDir: dir, now: Date.now() - 10 * 60_000 });
  const file = path.join(dir, 'health.json'), markdown = path.join(dir, 'HEALTH.md');
  const jsonBefore = fs.readFileSync(file, 'utf8'), textBefore = fs.readFileSync(markdown, 'utf8');
  const statBefore = fs.statSync(file).mtimeMs, textStatBefore = fs.statSync(markdown).mtimeMs;
  atomic(path.join(dir, 'state.json'), { last_error: 'A new failure after the monitor tick.' });
  const result = await main(['status', '--data-dir', dir]);
  assert.equal(result.status, 'attention');
  assert.equal(result.monitor_checked_at, tick.checked_at);
  assert.equal(fs.readFileSync(file, 'utf8'), jsonBefore);
  assert.equal(fs.readFileSync(markdown, 'utf8'), textBefore);
  assert.equal(fs.statSync(file).mtimeMs, statBefore);
  assert.equal(fs.statSync(markdown).mtimeMs, textStatBefore);
});
function appendRead(f, key, input, result, id = 'retry-read') {
  f.events.splice(-1, 0,
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: names[key], input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) }] } });
}
test('same-query persisted output recovers with smaller pages only after every page is read', () => {
  const f = fixture();
  f.events[0].message.content[0].input.pageSize = 50;
  resultOf(f.events, '__search_threads').content = 'Output too large; persisted to a local file.';
  appendRead(f, 'search_threads', { query: 'fictional scheduling', pageSize: 10 }, { threads: [], nextPageToken: 'next-small-page' });
  assert.equal(verify(f.events, f.report).ok, false, 'incomplete retry cannot recover');
  appendRead(f, 'search_threads', { query: 'fictional scheduling', pageSize: 10, pageToken: 'next-small-page' }, { threads: [] }, 'retry-page2');
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.deepEqual(verified.recovered_reads, [{ id: 'read-0', name: names.search_threads, reason: 'Gmail search response shape is unrecognized', recovered_by: 'retry-read' }]);
  assert.equal(verified.reads.some(x => x.id === 'read-0'), false);
});
test('differently scoped reads never recover a failure; it stays a warning, fatal when sole or cited', () => {
  const f = fixture();
  resultOf(f.events, '__list_events').content = 'Output too large; persisted to a local file.';
  assert.equal(verify(f.events, f.report).ok, false, 'the only calendar read failed');
  appendRead(f, 'list_events', { calendarId: 'different-calendar', pageSize: 10 }, { events: [] });
  const other = verify(f.events, f.report);
  assert.deepEqual(other.recovered_reads, [], 'different calendar does not recover the original');
  assert.deepEqual(other.warnings.map(x => x.id), ['read-2']);
  f.report.coverage.calendar.receipt_ids = ['read-2'];
  assert.equal(verify(f.events, f.report).ok, false, 'citing the unrecovered read is fatal');
  const g = fixture(); resultOf(g.events, '__search_threads').content = 'Service failure';
  appendRead(g, 'search_threads', { query: 'different scheduling query', pageSize: 10 }, { threads: [] });
  const query = verify(g.events, g.report);
  assert.deepEqual(query.recovered_reads, [], 'different query cannot recover');
  assert.deepEqual(query.warnings.map(x => x.id), ['read-0']);
  g.report.episodes[0].facts[0].evidence.push('read-0');
  assert.equal(verify(g.events, g.report).ok, false, 'citing the unrecovered read is fatal');
});
test('an actual tool error can recover through a later successful same read with diagnostics', () => {
  const f = fixture();
  const failed = resultOf(f.events, '__list_events'); failed.is_error = true; failed.content = '{"error":"Temporary provider failure"}';
  appendRead(f, 'list_events', { calendarId: 'primary', pageSize: 10 }, { events: [] });
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.equal(verified.recovered_reads[0].reason, 'Tool read failed');
  assert.deepEqual(verified.report.coverage.calendar.receipt_ids, ['retry-read']);
  f.report.coverage.calendar.receipt_ids = ['read-2'];
  assert.equal(verify(f.events, f.report).ok, false, 'a failed receipt is not usable evidence');
});
test('a smaller Calendar retry recovers the same original query and no others', () => {
  const f = fixture(); f.events[4].message.content[0].input.pageSize = 250;
  resultOf(f.events, '__list_events').content = 'Large response saved to file.';
  appendRead(f, 'list_events', { calendarId: 'primary', pageSize: 20 }, { events: [] });
  assert.equal(verify(f.events, f.report).ok, true);
});
function longThreadFixture() {
  const f = fixture();
  resultOf(f.events, '__get_thread').content = 'Thread too large; persisted output.';
  appendRead(f, 'get_thread', { threadId: 'thread-fictional', format: 'METADATA_ONLY' }, { id: 'thread-fictional', messageCount: 9, messages: Array.from({ length: 9 }, (_, i) => ({ id: `message-${i}`, snippet: 'Only a snippet.' })) }, 'thread-metadata');
  for (let i = 0; i < 9; i++) appendRead(f, 'get_message', { messageId: `message-${i}`, format: 'PLAIN_TEXT' }, { id: `message-${i}`, threadId: 'thread-fictional', textBody: `Fictional full message ${i}.` }, `body-${i}`);
  return f;
}
test('a clipped long thread recovers only when metadata IDs have all matching full bodies', () => {
  const f = longThreadFixture();
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.equal(verified.recovered_reads.find(x => x.id === 'read-1').recovered_by, 'thread-metadata');
  assert.equal(verified.reads.filter(x => x.name === names.get_message).length, 9);
  assert.equal(permitted(names.get_message, { messageId: 'message-0' }), true);
});
test('missing, snippet-only or mismatched individual messages cannot complete a thread', () => {
  for (const kind of ['missing', 'snippet', 'wrong-id', 'wrong-thread']) {
    const f = longThreadFixture();
    const result = f.events.flatMap(x => x.message?.content ?? []).find(x => x.type === 'tool_result' && x.tool_use_id === 'body-8');
    if (kind === 'missing') f.events = f.events.filter(x => !(x.message?.content ?? []).some(b => b.id === 'body-8' || b.tool_use_id === 'body-8'));
    else if (kind === 'snippet') result.content = JSON.stringify({ id: 'message-8', snippet: 'Insufficient.' });
    else if (kind === 'wrong-id') result.content = JSON.stringify({ id: 'another-message', textBody: 'A body from another message.' });
    else result.content = JSON.stringify({ id: 'message-8', threadId: 'another-thread', textBody: 'A body from another thread.' });
    assert.equal(verify(f.events, f.report).ok, false, kind);
  }
});
test('duplicate metadata IDs do not establish thread coverage; a short list with every body does', () => {
  for (const kind of ['short', 'duplicate']) {
    const f = longThreadFixture();
    const result = f.events.flatMap(x => x.message?.content ?? []).find(x => x.type === 'tool_result' && x.tool_use_id === 'thread-metadata');
    const data = JSON.parse(result.content);
    if (kind === 'short') data.messages.pop();
    else data.messages[8].id = data.messages[0].id;
    result.content = JSON.stringify(data);
    const verified = verify(f.events, f.report);
    // messageCount 9 with 8 returned messages: the gap is an unknown for the model to report, not a census failure.
    assert.equal(verified.ok, kind === 'short', `${kind}: ${verified.errors.join('\n')}`);
  }
});
test('a thread whose messageCount exceeds its returned messages is fully read without any drafts census', () => {
  const f = fixture();
  resultOf(f.events, '__get_thread').content = JSON.stringify({ id: 'thread-fictional', messageCount: 2, messages: [{ id: 'sent-message', textBody: 'Fictional received scheduling message.' }] });
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.deepEqual(verified.warnings, []);
  assert.deepEqual(verified.report.coverage.gmail.receipt_ids, ['read-1']);
});
test('actual Slack structured Markdown envelope is recognized; prose or incomplete blocks fail', () => {
  const slack = {
    results: '# Search Results for: \n\n## Messages (1 results)\n### Result 1 of 1\nChannel: #field-engineering-hiring (ID: fictional-channel)\nFrom: Fictional Recruiter (ID: fictional-user)\nTime: 2026-10-14 10:00:00 UTC\nMessage_ts: 1234567890.123456\nPermalink: [link](https://fictional.slack.com/archives/fictional-channel/p1234567890123456)\nText: \nFictional scheduling update.\n',
    pagination_info: 'End of results - No more pages available.\\n',
  };
  const f = fixture(); resultOf(f.events, '__slack_search_public_and_private').content = JSON.stringify(slack);
  assert.equal(verify(f.events, f.report).ok, true);
  slack.results = slack.results.replace('Message_ts:', 'Missing_timestamp:');
  resultOf(f.events, '__slack_search_public_and_private').content = JSON.stringify(slack);
  assert.equal(verify(f.events, f.report).ok, false);
  slack.results = 'I read all messages; nothing changed.';
  resultOf(f.events, '__slack_search_public_and_private').content = JSON.stringify(slack);
  assert.equal(verify(f.events, f.report).ok, false);
});
// Captured live: Slack's empty answer. pagination_info ends in a literal backslash-n.
const LIVE_EMPTY_SLACK = { results: '# Search Results for: \n\nNo results found.\n', pagination_info: 'End of results - No more pages available.\\n' };
test('the live Slack zero-result envelope is a valid quiet scan; the terminal pagination line is required', () => {
  const f = fixture();
  resultOf(f.events, '__slack_search_public_and_private').content = JSON.stringify(LIVE_EMPTY_SLACK);
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.deepEqual(verified.warnings, []);
  resultOf(f.events, '__slack_search_public_and_private').content = JSON.stringify({ ...LIVE_EMPTY_SLACK, pagination_info: 'Partial results.' });
  assert.equal(verify(f.events, f.report).ok, false, 'no terminal pagination line');
  resultOf(f.events, '__slack_search_public_and_private').content = JSON.stringify({ ...LIVE_EMPTY_SLACK, results: 'No results found.\n' });
  assert.equal(verify(f.events, f.report).ok, false, 'no search-results header');
});
test('the live three-level Slack envelope (array, text block, JSON string) verifies', () => {
  const f = fixture();
  const block = resultOf(f.events, '__slack_search_public_and_private');
  block.content = [{ type: 'text', text: JSON.stringify(LIVE_EMPTY_SLACK) }];
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  block.content = JSON.stringify([{ type: 'text', text: JSON.stringify(LIVE_EMPTY_SLACK) }]);
  assert.equal(verify(f.events, f.report).ok, true, 'stringified block array');
});
function threadWithDraft() {
  const f = fixture();
  resultOf(f.events, '__get_thread').content = JSON.stringify({ id: 'thread-fictional', messageCount: 2, messages: [{ id: 'sent-message', textBody: 'Fictional received scheduling message.' }] });
  appendRead(f, 'list_drafts', { pageSize: 10 }, { drafts: [{ id: 'draft-fictional', messageId: 'draft-message', threadId: 'thread-fictional' }], nextPageToken: null }, 'draft-list');
  appendRead(f, 'get_draft', { draftId: 'draft-fictional', messageFormat: 'PLAIN_TEXT' }, { id: 'draft-fictional', messageId: 'draft-message', threadId: 'thread-fictional', plaintextBody: 'Existing unsent draft written by Fictional Sam.' }, 'draft-body');
  return f;
}
test('draft reads stay allowed and need no census, while every draft mutation is denied', () => {
  const f = threadWithDraft();
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.deepEqual(verified.warnings, []);
  assert.equal(permitted(names.list_drafts, {}), true);
  assert.equal(permitted(names.get_draft, { draftId: 'draft-fictional' }), true);
  for (const name of ['create_draft', 'update_draft', 'send_draft', 'delete_draft']) {
    const tool = `mcp__claude_ai_Gmail__${name}`;
    assert.equal(permitted(tool, {}), false);
    assert.ok(DENIED.some(pattern => new RegExp('^' + pattern.split('*').join('.*') + '$').test(tool)));
  }
});
test('a wrong-ID or body-less draft read is a warning when uncited and fatal when cited', () => {
  for (const kind of ['wrong-draft-id', 'no-body']) {
    const f = threadWithDraft();
    const block = f.events.flatMap(e => e.message?.content ?? []).find(b => b.type === 'tool_result' && b.tool_use_id === 'draft-body');
    const data = JSON.parse(block.content);
    if (kind === 'wrong-draft-id') data.id = 'unrequested-draft';
    if (kind === 'no-body') { delete data.plaintextBody; data.snippet = 'Snippet only.'; }
    block.content = JSON.stringify(data);
    const verified = verify(f.events, f.report);
    assert.equal(verified.ok, true, `${kind}: ${verified.errors.join('\n')}`);
    assert.deepEqual(verified.warnings, [{ id: 'draft-body', name: names.get_draft, reason: 'Gmail draft has no matching full-body receipt' }], kind);
    f.report.episodes[0].facts[0].evidence.push('draft-body');
    assert.equal(verify(f.events, f.report).ok, false, kind);
  }
});
test('a MINIMAL message read recovers only through a full-body retry of that same message', () => {
  const f = fixture();
  appendRead(f, 'get_message', { messageId: 'message-fictional', messageFormat: 'MINIMAL' }, { id: 'message-fictional', threadId: 'thread-fictional' }, 'minimal-message');
  appendRead(f, 'get_message', { messageId: 'message-fictional', messageFormat: 'PLAIN_TEXT' }, { id: 'message-fictional', threadId: 'thread-fictional', textBody: 'Full fictional scheduling text.' }, 'full-message');
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.equal(verified.recovered_reads.find(x => x.id === 'minimal-message').recovered_by, 'full-message');
  const call = f.events.flatMap(e => e.message?.content ?? []).find(b => b.type === 'tool_use' && b.id === 'full-message');
  const result = f.events.flatMap(e => e.message?.content ?? []).find(b => b.type === 'tool_result' && b.tool_use_id === 'full-message');
  call.input.messageId = 'different-message'; result.content = JSON.stringify({ id: 'different-message', textBody: 'Unrelated full text.' });
  const unrecovered = verify(f.events, f.report);
  assert.equal(unrecovered.recovered_reads.some(x => x.id === 'minimal-message'), false);
  assert.deepEqual(unrecovered.warnings, [{ id: 'minimal-message', name: names.get_message, reason: 'Gmail message has no matching full-body receipt' }]);
  f.report.episodes[0].facts[0].evidence.push('minimal-message');
  assert.equal(verify(f.events, f.report).ok, false, 'a cited MINIMAL read is fatal');
});

test('an unread later list_drafts page is a warning unless cited', () => {
  const f = threadWithDraft();
  const listing = resultOf(f.events, '__list_drafts');
  const data = JSON.parse(listing.content); data.nextPageToken = 'remaining-drafts'; listing.content = JSON.stringify(data);
  const unread = verify(f.events, f.report);
  assert.equal(unread.ok, true, unread.errors.join('\n'));
  assert.deepEqual(unread.warnings.map(x => x.id), ['draft-list']);
  const cited = structuredClone(f.report); cited.coverage.gmail.receipt_ids.push('draft-list');
  assert.equal(verify(f.events, cited).ok, false);
  appendRead(f, 'list_drafts', { pageToken: 'remaining-drafts', pageSize: 10 }, { drafts: [], nextPageToken: null }, 'last-draft-page');
  const read = verify(f.events, cited);
  assert.equal(read.ok, true, read.errors.join('\n'));
  assert.deepEqual(read.warnings, []);
});
test('the Gmail provider exact empty-object search is a valid zero-result read', () => {
  const f = fixture();
  resultOf(f.events, '__search_threads').content = '{}';
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  for (const content of ['{"unexpected":"value"}', '{"error":"Provider failed"}', 'No matching threads were found.']) {
    resultOf(f.events, '__search_threads').content = content;
    assert.equal(verify(f.events, f.report).ok, false, content);
  }
});

test('draft rendering preserves global questions and distinguishes resolved episodes', () => {
  const f = fixture();
  f.report.unknowns = ['An unmatched fictional interview needs reconciliation.', 'The current interviewer route is uncertain.'];
  f.report.episodes.push({ episode_id: 'closed-fictional', status: 'closed', facts: [], next_actions: [], unknowns: [], resolution: { text: 'Fictional completion verified.', evidence: ['verified-source'] } });
  const reportBefore = JSON.stringify(f.report);
  const text = markdown({ scanned_at: '2026-10-14T12:00:00Z', changes: { new_or_changed: [] }, report: f.report });
  assert.match(text, /Status: open/);
  assert.match(text, /Status: closed/);
  assert.match(text, /Resolution: Fictional completion verified\./);
  assert.match(text, /## Unresolved questions/);
  for (const question of f.report.unknowns) assert.ok(text.includes(question));
  assert.equal(JSON.stringify(f.report), reportBefore, 'rendering must not alter the report');
});

const ODD_SLACK = { results: 'Unexpected provider prose about the channel.', pagination_info: 'End of results - No more pages available.\\n' };
test('an uncited unrecognised Slack read is a warning when a cited Slack read verifies', () => {
  const f = fixture();
  appendRead(f, 'slack_search_public_and_private', { query: 'fictional reschedule in:field-engineering-hiring' }, ODD_SLACK, 'slack-odd');
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.deepEqual(verified.warnings, [{ id: 'slack-odd', name: names.slack_search_public_and_private, reason: 'Slack response shape is unrecognized' }]);
  assert.deepEqual(verified.report.coverage.slack.receipt_ids, ['read-3']);
  const cited = structuredClone(f.report); cited.coverage.slack.receipt_ids.push('slack-odd');
  const failed = verify(f.events, cited);
  assert.equal(failed.ok, false, 'cited in coverage');
  assert.ok(failed.errors.includes(`Slack response shape is unrecognized: ${names.slack_search_public_and_private}`), failed.errors.join('\n'));
  const evidence = structuredClone(f.report); evidence.episodes[0].facts[0].evidence.push('slack-odd');
  assert.equal(verify(f.events, evidence).ok, false, 'cited as episode evidence');
});
test('an unrecognised read that is the only Slack read still fails as a missing actual read', () => {
  const f = fixture();
  resultOf(f.events, '__slack_search_public_and_private').content = JSON.stringify(ODD_SLACK);
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, false);
  assert.ok(verified.errors.includes('Missing actual read: __slack_search_public_and_private'), verified.errors.join('\n'));
});
function partialSlack() {
  const f = fixture();
  resultOf(f.events, '__slack_search_public_and_private').content = JSON.stringify(ODD_SLACK);
  f.report.coverage.slack = { complete: false, receipt_ids: [], notes: 'Fictional Slack search returned an unrecognised envelope.' };
  f.events.at(-1).result = JSON.stringify(f.report);
  return f;
}
test('one incomplete source with notes is a partial scan; notes are required; all four incomplete fails', () => {
  const f = partialSlack();
  const verified = verify(f.events, f.report);
  assert.equal(verified.ok, true, verified.errors.join('\n'));
  assert.deepEqual(verified.partial, ['slack']);
  assert.equal(verified.warnings.length, 1);
  for (const notes of ['', '   ', undefined, 42]) {
    const r = structuredClone(f.report); r.coverage.slack.notes = notes;
    assert.equal(verify(f.events, r).ok, false, `notes=${JSON.stringify(notes)}`);
  }
  const all = structuredClone(f.report);
  for (const s of ['gmail', 'calendar', 'slack', 'greenhouse']) all.coverage[s] = { complete: false, receipt_ids: [], notes: 'Fictional blocker.' };
  assert.equal(verify(f.events, all).ok, false, 'all four incomplete');
  const complete = verify(fixture().events, fixture().report);
  assert.deepEqual(complete.partial, []);
});
test('a partial scan writes a partial checkpoint, renders the partial line, and flags health while drafts stay fresh', async t => {
  const dir = temp(t), f = partialSlack();
  const result = await run({ dataDir: dir, claude: fake(t, f.events) });
  assert.equal(result.success, true);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  assert.deepEqual(checkpoint.partial, ['slack']);
  const verification = JSON.parse(fs.readFileSync(path.join(dir, 'last-verification.json'), 'utf8'));
  assert.deepEqual(verification.partial, ['slack']);
  assert.deepEqual(verification.warnings.map(x => x.reason), ['Slack response shape is unrecognized']);
  const lines = fs.readFileSync(path.join(dir, 'DRAFTS.md'), 'utf8').split('\n');
  const at = lines.indexOf(`Verified scan: ${checkpoint.scanned_at}`);
  assert.equal(lines[at + 1], 'Partial scan: slack not read. Fictional Slack search returned an unrecognised envelope.');
  const checked = health({ dataDir: dir });
  assert.equal(checked.status, 'attention');
  assert.ok(checked.reasons.includes('Last scan was partial: slack.'), checked.reasons.join('\n'));
  assert.equal(checked.last_success, checkpoint.scanned_at);
  await run({ dataDir: dir, claude: fake(t, fixture().events) });
  assert.equal(health({ dataDir: dir }).status, 'healthy', 'a complete scan clears the partial reason');
});
test('markdown and assess surface a partial checkpoint', () => {
  const f = fixture();
  f.report.coverage.slack = { complete: false, receipt_ids: [], notes: 'Fictional Slack outage.' };
  f.report.coverage.calendar = { complete: false, receipt_ids: [], notes: 'Fictional calendar outage.' };
  const text = markdown({ scanned_at: '2026-10-14T12:00:00Z', partial: ['calendar', 'slack'], changes: { new_or_changed: [] }, report: f.report });
  assert.match(text, /^Verified scan: 2026-10-14T12:00:00Z\nPartial scan: calendar, slack not read\. Fictional calendar outage\. Fictional Slack outage\.$/m);
  assert.doesNotMatch(markdown({ scanned_at: '2026-10-14T12:00:00Z', partial: [], changes: { new_or_changed: [] }, report: fixture().report }), /Partial scan/);
  const now = Date.now(), config = { installed_at: new Date(now - 10 * 60_000).toISOString(), interval_minutes: 30 };
  const state = { last_success: new Date(now).toISOString() };
  assert.equal(assess(config, state, null, now).status, 'healthy');
  const flagged = assess(config, state, null, now, { partial: ['slack'] });
  assert.equal(flagged.status, 'attention');
  assert.deepEqual(flagged.reasons, ['Last scan was partial: slack.']);
});

function deadPid() {
  const exited = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
  assert.throws(() => process.kill(exited.pid, 0), { code: 'ESRCH' });
  return exited.pid;
}
test('run removes only regular files under the worker cwd tool-results, then emptied directories', async t => {
  const dir = temp(t), projects = temp(t), outside = temp(t);
  const project = path.join(projects, dir.replace(/[/.]/g, '-'));
  const sessionA = path.join(project, 'fictional-session-a'), sessionB = path.join(project, 'fictional-session-b');
  fs.mkdirSync(path.join(sessionA, 'tool-results', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(sessionA, 'tool-results', 'fictional-result.txt'), 'Fictional persisted tool output.');
  fs.writeFileSync(path.join(sessionA, 'tool-results', 'nested', 'deeper.txt'), 'Fictional nested output.');
  fs.mkdirSync(path.join(sessionB, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(sessionB, 'tool-results', 'kept-link-target.txt'), 'Fictional output.');
  fs.writeFileSync(path.join(sessionB, 'transcript.jsonl'), 'Not a tool result.');
  const target = path.join(outside, 'outside.txt'); fs.writeFileSync(target, 'Outside file.');
  fs.symlinkSync(target, path.join(sessionB, 'tool-results', 'link.txt'));
  const otherProject = path.join(projects, '-another-project', 'session', 'tool-results');
  fs.mkdirSync(otherProject, { recursive: true }); fs.writeFileSync(path.join(otherProject, 'other.txt'), 'Another project.');
  await runPilot({ dataDir: dir, claude: fake(t, fixture().events), claudeProjectsDir: projects });
  assert.equal(fs.existsSync(sessionA), false, 'emptied session directory is removed');
  assert.equal(fs.existsSync(path.join(sessionB, 'tool-results', 'kept-link-target.txt')), false);
  assert.equal(fs.lstatSync(path.join(sessionB, 'tool-results', 'link.txt')).isSymbolicLink(), true, 'symlinks are not regular files');
  assert.equal(fs.readFileSync(target, 'utf8'), 'Outside file.');
  assert.equal(fs.readFileSync(path.join(sessionB, 'transcript.jsonl'), 'utf8'), 'Not a tool result.');
  assert.equal(fs.readFileSync(path.join(otherProject, 'other.txt'), 'utf8'), 'Another project.');
  assert.equal(fs.existsSync(project), true, 'the project directory itself stays');
  fs.mkdirSync(path.join(sessionA, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(sessionA, 'tool-results', 'after-failure.txt'), 'Fictional output.');
  await assert.rejects(runPilot({ dataDir: dir, claude: fake(t, [fixture().events.at(-1)]), claudeProjectsDir: projects }), /verification failed/);
  assert.equal(fs.existsSync(sessionA), false, 'failed runs clean up too');
  await runPilot({ dataDir: temp(t), claude: fake(t, fixture().events), claudeProjectsDir: path.join(projects, 'absent') });
});
test('each run keeps its own stream and verification under runs/, private, pruned to the newest 10 runs', async t => {
  const dir = temp(t); initialize(dir);
  const runs = path.join(dir, 'runs');
  fs.mkdirSync(runs, { mode: 0o700 });
  for (let i = 1; i <= 9; i++) for (const suffix of ['stream.jsonl', 'verification.json']) fs.writeFileSync(path.join(runs, `2020-01-0${i}T00-00-00.000Z-${suffix}`), 'old', { mode: 0o600 });
  fs.writeFileSync(path.join(runs, 'unrelated-note.txt'), 'kept', { mode: 0o600 });
  const id = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).started_at.replaceAll(':', '-');
  await run({ dataDir: dir, claude: fake(t, fixture().events) });
  const first = id();
  assert.equal(fs.readFileSync(path.join(runs, `${first}-stream.jsonl`), 'utf8'), fs.readFileSync(path.join(dir, 'latest-stream.jsonl'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(runs, `${first}-verification.json`), 'utf8'), fs.readFileSync(path.join(dir, 'last-verification.json'), 'utf8'));
  await assert.rejects(run({ dataDir: dir, claude: fake(t, [fixture().events.at(-1)]) }), /verification failed/);
  const second = id();
  assert.notEqual(second, first);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runs, `${second}-verification.json`), 'utf8')).ok, false);
  await assert.rejects(run({ dataDir: dir, claude: fake(t, [], 1) }), /Claude process failed/);
  const third = id();
  assert.equal(fs.existsSync(path.join(runs, `${third}-stream.jsonl`)), true);
  assert.equal(fs.existsSync(path.join(runs, `${third}-verification.json`)), false, 'a run that never verified keeps no stale verification');
  const kept = [...new Set(fs.readdirSync(runs).map(f => f.match(/^(.+)-(stream\.jsonl|verification\.json)$/)?.[1]).filter(Boolean))].sort();
  assert.equal(kept.length, 10);
  assert.deepEqual(kept.slice(-3), [first, second, third]);
  assert.equal(kept.includes('2020-01-01T00-00-00.000Z') || kept.includes('2020-01-02T00-00-00.000Z'), false, 'oldest runs pruned');
  assert.equal(fs.existsSync(path.join(runs, 'unrelated-note.txt')), true);
  assert.equal(fs.statSync(runs).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(runs)) assert.equal(fs.statSync(path.join(runs, file)).mode & 0o777, 0o600, file);
});
test('a dead lock older than the interval is reclaimed and recorded for that run only', async t => {
  const dir = temp(t); initialize(dir);
  const owner = { pid: deadPid(), child_pid: deadPid(), token: 'fictional-dead-owner', started_at: new Date(Date.now() - 31 * 60_000).toISOString() };
  atomic(path.join(dir, 'run.lock'), owner);
  const result = await run({ dataDir: dir, claude: fake(t, fixture().events) });
  assert.equal(result.success, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).reclaimed_lock, owner);
  assert.equal(fs.existsSync(path.join(dir, 'run.lock')), false);
  assert.equal(fs.existsSync(path.join(dir, 'blocked.json')), false);
  await run({ dataDir: dir, claude: fake(t, fixture().events) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).reclaimed_lock, null);
  atomic(path.join(dir, 'run.lock'), owner);
  const release = takeLock(dir, 30);
  assert.deepEqual(release.reclaimed, owner);
  release();
  assert.equal(fs.existsSync(path.join(dir, 'run.lock')), false);
});
test('a live, recent, or unreadable lock blocks the run and records blocked.json without touching state', async t => {
  const now = Date.now();
  const cases = {
    'live owner': { pid: process.pid, token: 'live', started_at: new Date(now - 120 * 60_000).toISOString() },
    'live child': { pid: deadPid(), child_pid: process.pid, token: 'child', started_at: new Date(now - 120 * 60_000).toISOString() },
    'dead but recent': { pid: deadPid(), child_pid: deadPid(), token: 'recent', started_at: new Date(now - 5 * 60_000).toISOString() },
    'no start time': { pid: deadPid(), token: 'undated' },
  };
  for (const [kind, owner] of Object.entries(cases)) {
    const dir = temp(t); initialize(dir);
    atomic(path.join(dir, 'state.json'), { last_success: new Date(now - 60 * 60_000).toISOString(), marker: kind });
    const stateBefore = fs.readFileSync(path.join(dir, 'state.json'), 'utf8');
    atomic(path.join(dir, 'run.lock'), owner);
    await assert.rejects(run({ dataDir: dir, claude: fake(t, fixture().events) }), /Run lock exists/, kind);
    const blocked = JSON.parse(fs.readFileSync(path.join(dir, 'blocked.json'), 'utf8'));
    assert.deepEqual(blocked.owner, owner, kind);
    assert.ok(Date.parse(blocked.at) >= now, kind);
    assert.equal(fs.statSync(path.join(dir, 'blocked.json')).mode & 0o777, 0o600, kind);
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), stateBefore, kind);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'run.lock'), 'utf8')), owner, `${kind}: lock untouched`);
    assert.ok(health({ dataDir: dir }).reasons.includes(`A scheduled run was blocked by a lock at ${blocked.at}.`), kind);
  }
  const dir = temp(t); initialize(dir);
  fs.writeFileSync(path.join(dir, 'run.lock'), 'not json', { mode: 0o600 });
  assert.throws(() => takeLock(dir, 30), /Run lock exists/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'blocked.json'), 'utf8')).owner, null);
  assert.equal(fs.readFileSync(path.join(dir, 'run.lock'), 'utf8'), 'not json');
});
test('assess reports a blocked run only when it is newer than the last success', () => {
  const now = Date.now(), config = { installed_at: new Date(now - 10 * 60_000).toISOString(), interval_minutes: 30 };
  const at = new Date(now - 5 * 60_000).toISOString();
  const reason = `A scheduled run was blocked by a lock at ${at}.`;
  assert.deepEqual(assess(config, { last_success: new Date(now - 20 * 60_000).toISOString() }, null, now, { blocked: { at } }).reasons, [reason]);
  assert.equal(assess(config, { last_success: new Date(now - 60_000).toISOString() }, null, now, { blocked: { at } }).status, 'healthy');
  assert.ok(assess(config, {}, null, now, { blocked: { at } }).reasons.includes(reason));
});
