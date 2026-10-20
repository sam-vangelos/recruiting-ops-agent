// Tests for the send gate. Every transcript and ledger here is synthetic: no real
// names, addresses, or message bodies. The hook is driven as a child process with
// the same stdin JSON Claude Code sends it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, 'send-gate.mjs');

const GMAIL = 'mcp__ac613b5b-0000-4000-8000-000000000001';
const GMAIL_B = 'mcp__claude_ai_Gmail';
const SLACK = 'mcp__8da37aa4-0000-4000-8000-000000000002';
const CAL = 'mcp__886429e7-0000-4000-8000-000000000003';
const GH = 'mcp__greenhouse-recruiter';
const GH_LEGACY = 'mcp__293a8f50-0000-4000-8000-000000000004';
const GH_LEGACY_B = 'mcp__claude_ai_Greenhouse';

const BODY = 'Hi X, so sorry I missed our call -- could you grab a new slot on my Calendly?';
const BODY_NORMALISED = 'Hi X, so sorry I missed our call \u2014 could you grab a new slot on my Calendly?';
const SHOWN = 'Here is the reply to X:\n\n> *Hi X, so sorry I missed our call \u2014 could you grab a new slot on my Calendly?*\n\nOK to send?';

// ---------- synthetic transcript builders (shapes match real Claude Code JSONL) ----------
let seq = 0;
const base = () => ({ uuid: `u-${++seq}`, sessionId: 's-1', timestamp: new Date().toISOString(), isSidechain: false });
const human = text => ({ ...base(), type: 'user', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: text } });
const humanBlocks = text => ({ ...base(), type: 'user', promptSource: 'sdk', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] } });
const say = text => ({ ...base(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const think = text => ({ ...base(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } });
const toolUse = (name, input) => ({ ...base(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${seq}`, name, input }] } });
const toolResult = text => ({ ...base(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${seq}`, content: text }] } });
const meta = text => ({ ...base(), type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } });
const reminder = () => ({ ...base(), type: 'user', message: { role: 'user', content: '<system-reminder>Context.</system-reminder>' } });
const taskNote = () => ({ ...base(), type: 'user', promptSource: 'system', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } });
const compactSummary = text => ({ ...base(), type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: text } });
const localCmd = () => ({ ...base(), type: 'user', message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } });
const enqueue = content => ({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(), sessionId: 's-1', content });
const dequeue = () => ({ type: 'queue-operation', operation: 'dequeue', timestamp: new Date().toISOString(), sessionId: 's-1' });
const queuedHuman = text => ({ ...base(), type: 'attachment', attachment: { type: 'queued_command', prompt: text, commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true } });
const sidechainSay = text => ({ ...say(text), isSidechain: true });
const noise = () => [
  { type: 'file-history-snapshot', messageId: 'm', snapshot: {}, isSnapshotUpdate: false },
  { type: 'custom-title', customTitle: 'synthetic', sessionId: 's-1' },
  { ...base(), type: 'attachment', attachment: { type: 'total_tokens_reminder', text: 'tokens' } },
  { ...base(), type: 'system', subtype: 'stop_hook_summary' },
];

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'send-gate-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

function writeTranscript(dir, entries) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function writeLedger(dir, records) {
  const file = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
  return file;
}

function runHook(dir, input, { ledger = [] } = {}) {
  const ledgerFile = writeLedger(dir, ledger);
  const logFile = path.join(dir, 'send-gate.log');
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 's-1', cwd: dir, hook_event_name: 'PreToolUse', ...input }),
    env: { ...process.env, SCHEDULING_LEDGER_PATH: ledgerFile, SCHEDULING_SEND_GATE_LOG: logFile },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  const out = res.stdout.trim();
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  if (!out) return { decision: null, reason: null, log, stdout: res.stdout };
  const parsed = JSON.parse(out);
  const h = parsed.hookSpecificOutput;
  assert.equal(h.hookEventName, 'PreToolUse');
  return { decision: h.permissionDecision, reason: h.permissionDecisionReason, log };
}

function gate(t, entries, tool_name, tool_input, opts = {}) {
  const dir = tmpdir(t);
  const transcript_path = entries === null ? path.join(dir, 'missing.jsonl') : writeTranscript(dir, entries);
  return runHook(dir, { transcript_path, tool_name, tool_input, ...(opts.extra ?? {}) }, opts);
}

const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const minutesAgo = m => new Date(Date.now() - m * 60_000).toISOString();
const intent = (exception, extra = {}) => ({
  kind: 'action', status: 'intent', idempotency_key: `act:${exception}:1`, episode_id: 'app-1000000001-step',
  action_key: `app-1000000001:${exception}`, at: minutesAgo(2), exception, provider_id: null, ...extra,
});

// The turn that happened: tool calls, then the turn ends with only a summary-box tool_use
// carrying the ask. No drafts were printed as text.
const replayTurn = () => [
  ...noise(),
  human('Run the morning sweep.'),
  think('Plan the sweep.'),
  toolUse(`${GMAIL}__search_threads`, { query: 'in:inbox' }),
  toolResult('synthetic results'),
  toolUse('mcp__app__summary_box', { title: 'Five proposals', body: BODY, actions: ['Approve all five'] }),
  toolResult('rendered'),
  humanBlocks('Approve all five proposals as drafted.'),
];

// ---------- the gate on message tools ----------

test('replay of the incident: drafts never printed, "approve all" reply, reply call is denied', t => {
  const r = gate(t, replayTurn(), `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /not been shown to Sam verbatim/);
  assert.match(r.reason, /Print the full/);
});

test('body quoted verbatim (italics, quote marker, em dash for --) before the human reply is allowed', t => {
  const r = gate(t, [human('Draft the apology.'), think('Draft it.'), say(SHOWN), human('Yes, send it.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, null, r.reason);
});

test('a passing send produces empty stdout: the gate has no opinion, it never grants', t => {
  const r = gate(t, [human('Draft the apology.'), say(SHOWN), human('Yes, send it.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.stdout, '');
  const exc = gate(t, replayTurn(), `${GH}__apply_application_stage_move`, {}, { ledger: [intent('step1_stage_move')] });
  assert.equal(exc.stdout, '');
  assert.ok(exc.log.includes('step1_stage_move'), 'an exception pass is still logged');
});

test('body shown but no human message since: denied', t => {
  const r = gate(t, [human('Draft the apology.'), say(SHOWN)], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
});

test('body shown two human turns ago, not in the latest window: denied', t => {
  const r = gate(t, [human('Draft the apology.'), say(SHOWN), human('Hold that, check the calendar.'), say('Calendar checked, nothing new.'), human('OK go.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
});

test('body shown with one different word: denied', t => {
  const r = gate(t, [human('Draft.'), say(SHOWN.replace('new slot', 'fresh slot')), human('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
});

test('body only inside a tool_use input: denied', t => {
  const r = gate(t, [human('Draft.'), toolUse('mcp__app__summary_box', { body: BODY }), toolResult('ok'), human('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
});

test('body only inside a thinking block: denied', t => {
  const r = gate(t, [human('Draft.'), think(BODY), say('Ready to send the apology?'), human('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
});

test('body only in sidechain (subagent) text: denied', t => {
  const r = gate(t, [human('Draft.'), sidechainSay(BODY), human('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
});

test('non-human user entries do not count as Sam replying', t => {
  for (const notHuman of [toolResult('ok'), meta('Base directory for this skill'), reminder(), taskNote(), compactSummary('This session is being continued.'), localCmd()]) {
    const r = gate(t, [human('Draft.'), say(SHOWN), notHuman], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
    assert.equal(r.decision, 'deny', `entry counted as human: ${JSON.stringify(notHuman).slice(0, 80)}`);
  }
});

test('a mid-turn human message (queued_command attachment) counts as Sam replying', t => {
  const r = gate(t, [human('Draft.'), say(SHOWN), enqueue('Looks right, send.'), dequeue(), queuedHuman('Looks right, send.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, null, r.reason);
});

test('text printed after Sam submitted a queued message but before it was delivered does not count', t => {
  const r = gate(t, [human('Draft.'), say('Working on it.'), enqueue('Send.'), say(SHOWN), dequeue(), queuedHuman('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
  const r2 = gate(t, [human('Draft.'), say('Working on it.'), enqueue('Send.'), say(SHOWN), dequeue(), { ...human('Send.'), promptSource: 'queued' }], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r2.decision, 'deny');
});

test('empty body: denied', t => {
  const r = gate(t, [human('Draft.'), say(SHOWN), human('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', body: '   ' });
  assert.equal(r.decision, 'deny');
});

test('Gmail send_message: a to address not shown is denied, shown is allowed', t => {
  const input = { to: ['candidate.one@example.com'], cc: 'Panel Two <panel.two@example.org>', subject: 'Next step', body: BODY };
  const shownNoAddr = `Subject: Next step\n\n${SHOWN}\n\ncc panel.two@example.org`;
  const denied = gate(t, [human('Draft.'), say(shownNoAddr), human('Send.')], `${GMAIL}__send_message`, input);
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /recipient/i);
  const shownAll = `To: Candidate.One@example.com\n${shownNoAddr}`;
  const allowed = gate(t, [human('Draft.'), say(shownAll), human('Send.')], `${GMAIL}__send_message`, input);
  assert.equal(allowed.decision, null, allowed.reason);
});

test('Gmail send_message: a subject not shown is denied', t => {
  const input = { to: 'candidate.one@example.com', subject: 'A different subject', body: BODY };
  const r = gate(t, [human('Draft.'), say(`To: candidate.one@example.com\nSubject: Next step\n\n${SHOWN}`), human('Send.')], `${GMAIL}__send_message`, input);
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /subject/i);
});

test('Gmail send_message with draftId: denied with an instruction to send an explicit body', t => {
  const r = gate(t, [human('Draft.'), say(SHOWN), human('Send.')], `${GMAIL}__send_message`, { draftId: 'r-123' });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /draftId/);
});

test('htmlBody: an href not shown is denied; shown as a markdown link is allowed', t => {
  const html = '<p>Hi X, so sorry I missed our call &mdash; could you grab a new slot on my <a href="https://calendly.example/sam">Calendly</a>?</p>';
  const textOnly = 'Draft:\n\nHi X, so sorry I missed our call -- could you grab a new slot on my Calendly?';
  const denied = gate(t, [human('Draft.'), say(textOnly), human('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', htmlBody: html });
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /link/i);
  const withLink = 'Draft:\n\nHi X, so sorry I missed our call -- could you grab a new slot on my [Calendly](https://calendly.example/sam)?';
  const allowed = gate(t, [human('Draft.'), say(withLink), human('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', htmlBody: html });
  assert.equal(allowed.decision, null, allowed.reason);
});

test('Gmail forward: forwardText and to are checked', t => {
  const input = { messageId: 'm-1', to: 'hm.one@example.com', forwardText: 'FYI, see below.' };
  assert.equal(gate(t, [human('Fwd.'), say('Forward to hm.one@example.com with: FYI, see below.'), human('Go.')], `${GMAIL}__forward`, input).decision, null);
  assert.equal(gate(t, [human('Fwd.'), say('Forward with: FYI, see below.'), human('Go.')], `${GMAIL}__forward`, input).decision, 'deny');
});

test('Slack message with a <@U123> mention, shown without the token: allowed', t => {
  const r = gate(t, [human('Draft.'), say('Slack draft: "Can you make Tuesday at 2pm PT?"'), human('Send.')], `${SLACK}__slack_send_message`, { channel_id: 'C000', message: '<@U123> Can you make Tuesday at 2pm PT?' });
  assert.equal(r.decision, null, r.reason);
});

test('Slack schedule_message is gated the same way', t => {
  const r = gate(t, replayTurn(), `${SLACK}__slack_schedule_message`, { channel_id: 'C000', message: 'Reminder: interview at 2pm PT.', post_at: 1 });
  assert.equal(r.decision, 'deny');
});

test('slack_send_message is not treated as Gmail send_message (no recipient rule)', t => {
  const r = gate(t, [human('Draft.'), say('Slack: Can you make Tuesday at 2pm PT?'), human('Send.')], `${SLACK}__slack_send_message`, { channel_id: 'C000', message: 'Can you make Tuesday at 2pm PT?', to: 'nobody@example.com' });
  assert.equal(r.decision, null, r.reason);
});

test('slack_send_message_draft, Gmail create_draft and update_draft pass through', t => {
  for (const [name, input] of [[`${SLACK}__slack_send_message_draft`, { message: BODY }], [`${GMAIL}__create_draft`, { body: BODY }], [`${GMAIL}__update_draft`, { body: BODY }]]) {
    const r = gate(t, replayTurn(), name, input);
    assert.equal(r.decision, null, name);
  }
});

test('a subagent may not send even a shown body', t => {
  const r = gate(t, [human('Draft.'), say(SHOWN), human('Send.')], `${GMAIL}__reply`, { messageId: 'm-1', body: BODY }, { extra: { agent_id: 'a-1', agent_type: 'implementer' } });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /subagent/i);
});

test('missing transcript: denied', t => {
  const r = gate(t, null, `${GMAIL}__reply`, { messageId: 'm-1', body: BODY });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /transcript/i);
});

test('corrupt transcript: denied', t => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, [JSON.stringify(human('Draft.')), JSON.stringify(say(SHOWN)), '{"type":"user", broken', JSON.stringify(human('Send.'))].join('\n') + '\n');
  const r = runHook(dir, { transcript_path: file, tool_name: `${GMAIL}__reply`, tool_input: { messageId: 'm-1', body: BODY } });
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /transcript/i);
});

test('an unterminated final line (write in progress) is ignored, not fatal', t => {
  const dir = tmpdir(t);
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, [human('Draft.'), say(SHOWN), human('Send.')].map(e => JSON.stringify(e)).join('\n') + '\n{"type":"assist');
  const r = runHook(dir, { transcript_path: file, tool_name: `${GMAIL}__reply`, tool_input: { messageId: 'm-1', body: BODY } });
  assert.equal(r.decision, null, r.reason);
});

test('unparseable hook input: denied', t => {
  const dir = tmpdir(t);
  const res = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', env: { ...process.env, SCHEDULING_LEDGER_PATH: path.join(dir, 'l.jsonl') } });
  assert.equal(res.status, 0);
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

// ---------- the ask path ----------

test('calendar create_event and Greenhouse stage move ask Sam', t => {
  assert.equal(gate(t, replayTurn(), `${CAL}__create_event`, { summary: 'Hold' }).decision, 'ask');
  for (const name of ['update_event', 'delete_event', 'respond_to_event']) assert.equal(gate(t, replayTurn(), `${CAL}__${name}`, {}).decision, 'ask', name);
  assert.equal(gate(t, replayTurn(), `${GH}__apply_application_stage_move`, { application_id: 1 }).decision, 'ask');
  for (const name of ['mcp__claude_ai_Notion__notion-calendar-create-events', 'mcp__claude_ai_Calendly__meetings-cancel_event', 'mcp__claude_ai_Calendly__meetings-create_invitee', `${SLACK}__slack_create_canvas`, `${SLACK}__slack_update_canvas`, `${GH}__apply_application_rejection`]) {
    assert.equal(gate(t, replayTurn(), name, {}).decision, 'ask', name);
  }
});

test('the other Greenhouse server: writes ask under any prefix and take no exception; reads pass', t => {
  const writes = ['reject_application', 'unreject_application', 'move_application', 'delete_application', 'create_application', 'create_candidate', 'update_candidate', 'add_candidate_note', 'create_job'];
  const ledger = Object.keys({ step1_stage_move: 1, step6_interviewer_role: 1, step8_standard_confirmation: 1 }).map((e, i) => intent(e, { idempotency_key: `act:${e}:${i}` }));
  for (const prefix of [GH_LEGACY, GH_LEGACY_B]) {
    for (const name of writes) {
      assert.equal(gate(t, replayTurn(), `${prefix}__${name}`, {}).decision, 'ask', `${prefix}__${name}`);
      assert.equal(gate(t, replayTurn(), `${prefix}__${name}`, {}, { ledger }).decision, 'ask', `${prefix}__${name} with exceptions`);
    }
    for (const name of ['list_applications', 'get_job', 'search_candidates']) {
      assert.equal(gate(t, null, `${prefix}__${name}`, {}).decision, null, `${prefix}__${name}`);
    }
  }
});

test('stage move with a fresh step1_stage_move intent passes silently and is logged without a body', t => {
  const r = gate(t, replayTurn(), `${GH}__apply_application_stage_move`, { application_id: 1 }, { ledger: [intent('step1_stage_move')] });
  assert.equal(r.decision, null, r.reason);
  const line = JSON.parse(r.log.trim());
  assert.equal(line.tool, `${GH}__apply_application_stage_move`);
  assert.equal(line.exception, 'step1_stage_move');
  assert.equal(line.action_key, 'app-1000000001:step1_stage_move');
  assert.ok(line.at);
});

test('stale (>15 min), consumed, or future-dated intents fall back to ask', t => {
  const name = `${GH}__apply_application_stage_move`;
  assert.equal(gate(t, replayTurn(), name, {}, { ledger: [intent('step1_stage_move', { at: minutesAgo(16) })] }).decision, 'ask');
  const consumed = [intent('step1_stage_move'), { ...intent('step1_stage_move'), idempotency_key: 'act:other', status: 'dispatched', provider_id: 'gh-1', at: minutesAgo(1) }];
  assert.equal(gate(t, replayTurn(), name, {}, { ledger: consumed }).decision, 'ask');
  assert.equal(gate(t, replayTurn(), name, {}, { ledger: [intent('step1_stage_move', { at: new Date(Date.now() + 60 * 60_000).toISOString() })] }).decision, 'ask');
});

test('a stage-move exception does not cover other Greenhouse apply_* tools', t => {
  const r = gate(t, replayTurn(), `${GH}__apply_application_rejection`, {}, { ledger: [intent('step1_stage_move')] });
  assert.equal(r.decision, 'ask');
});

test('a message exception does not cover ask-path tools', t => {
  const r = gate(t, replayTurn(), `${CAL}__create_event`, {}, { ledger: [intent('step10_live_nudge')] });
  assert.equal(r.decision, 'ask');
});

test('a corrupt ledger grants no exception', t => {
  const dir = tmpdir(t);
  const transcript_path = writeTranscript(dir, replayTurn());
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  fs.writeFileSync(ledgerFile, JSON.stringify(intent('step1_stage_move')) + '\n{broken\n');
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path, tool_name: `${GH}__apply_application_stage_move`, tool_input: {} }),
    env: { ...process.env, SCHEDULING_LEDGER_PATH: ledgerFile, SCHEDULING_SEND_GATE_LOG: path.join(dir, 'g.log') }, encoding: 'utf8',
  });
  assert.equal(JSON.parse(res.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

// ---------- message exceptions ----------

test('message with a step10_live_nudge intent and matching hash is allowed and logged', t => {
  const message = 'The interview has started: https://meet.example/abc-defg-hij';
  const hash = sha(message);
  const r = gate(t, replayTurn(), `${SLACK}__slack_send_message`, { channel_id: 'D000', message }, { ledger: [intent('step10_live_nudge', { draft_sha256: hash })] });
  assert.equal(r.decision, null, r.reason);
  assert.equal(JSON.parse(r.log.trim()).exception, 'step10_live_nudge');
  assert.ok(!r.log.includes('interview has started'), 'log must not carry the body');
});

test('message exception with a hash mismatch is denied', t => {
  const r = gate(t, replayTurn(), `${GMAIL}__reply`, { messageId: 'm-1', body: BODY }, { ledger: [intent('step9_urgent_cancellation', { draft_sha256: sha('something else') })] });
  assert.equal(r.decision, 'deny');
});

test('step1_stage_move exception on a message tool is denied', t => {
  const r = gate(t, replayTurn(), `${GMAIL}__reply`, { messageId: 'm-1', body: BODY }, { ledger: [intent('step1_stage_move', { draft_sha256: sha(BODY_NORMALISED) })] });
  assert.equal(r.decision, 'deny');
});

test('the --hash helper prints the digest the gate expects', t => {
  const res = spawnSync(process.execPath, [HOOK, '--hash', `${GMAIL}__reply`], { input: JSON.stringify({ body: BODY }), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const hash = res.stdout.trim();
  assert.match(hash, /^[0-9a-f]{64}$/);
  const r = gate(t, replayTurn(), `${GMAIL_B}__reply`, { messageId: 'm-1', body: BODY }, { ledger: [intent('step9_urgent_cancellation', { draft_sha256: hash })] });
  assert.equal(r.decision, null, r.reason);
});

test('a subagent may not use a message exception either', t => {
  const message = 'The interview has started.';
  const r = gate(t, replayTurn(), `${SLACK}__slack_send_message`, { message }, { ledger: [intent('step10_live_nudge', { draft_sha256: sha(message) })], extra: { agent_id: 'a-1' } });
  assert.equal(r.decision, 'deny');
});

// ---------- pass-through and prefix independence ----------

test('read tools produce no output', t => {
  for (const name of [`${GMAIL}__get_thread`, `${GMAIL}__search_threads`, `${GH}__preview_application_stage_move`, `${CAL}__list_events`, `${GMAIL}__apply_sensitive_thread_label`, 'mcp__claude_ai_Calendly__meetings-create_invitee_no_show', 'Read']) {
    assert.equal(gate(t, null, name, {}).decision, null, name);
  }
});

test('the same tool names under different server prefixes behave the same', t => {
  const entries = [human('Draft.'), say(SHOWN), human('Send.')];
  for (const prefix of ['mcp__ac613b5b-0000-4000-8000-000000000001', 'mcp__0f0f0f0f-1111-4222-8333-444444444444', 'mcp__claude_ai_Gmail']) {
    assert.equal(gate(t, entries, `${prefix}__reply`, { messageId: 'm-1', body: BODY }).decision, null, prefix);
    assert.equal(gate(t, replayTurn(), `${prefix}__reply`, { messageId: 'm-1', body: BODY }).decision, 'deny', prefix);
    assert.equal(gate(t, replayTurn(), `${prefix}__create_event`, {}).decision, 'ask', prefix);
    assert.equal(gate(t, replayTurn(), `${prefix}__get_thread`, {}).decision, null, prefix);
  }
});
