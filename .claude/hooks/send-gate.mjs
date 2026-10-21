#!/usr/bin/env node
// send-gate: a Claude Code PreToolUse hook that blocks any outward message whose exact
// wording Sam has not seen on screen. See README.md beside this file.
//
// Contract: JSON hook input on stdin; for a deny or ask, JSON on stdout and exit 0.
// Everything else exits 0 with no output: an unclassified tool, a send whose wording Sam
// saw, and a call covered by a ledger exception. The gate never answers "allow", so it
// only ever tightens and a user's own ask/deny permission rules stay in force.
// Plain Node, no dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_DIR = path.join(os.homedir(), '.recruiting-agents/scheduling-pilot');
export const LEDGER_PATH = () => {
  const p = process.env.SCHEDULING_LEDGER_PATH || path.join(DATA_DIR, 'ledger.jsonl');
  return p.endsWith('.jsonl') ? p : path.join(p, 'ledger.jsonl');
};
export const LOG_PATH = () => process.env.SCHEDULING_SEND_GATE_LOG || path.join(DATA_DIR, 'send-gate.log');
export const EXCEPTION_WINDOW_MS = 15 * 60_000;
const CLOCK_SKEW_MS = 60_000;

// ---------------------------------------------------------------------------------------
// Tool classification. Matched by suffix on the tool name, because the MCP server prefix
// is a per-user UUID. First match wins, so narrow pass-through rows sit above broad rows.
//   kind 'message' -> verbatim gate (body, recipients, subject must have been shown)
//   kind 'ask'     -> Claude Code shows Sam the exact tool input in a permission prompt
//   kind 'pass'    -> no decision (explicitly not outward)
// Anything that matches no row passes through.
// ---------------------------------------------------------------------------------------
export const TOOLS = [
  // Gmail. `__send_message$` needs the double underscore, so `__slack_send_message` never matches it.
  { pattern: /__send_message$/, kind: 'message', channel: 'gmail', label: 'email', body: ['body', 'htmlBody'], recipients: ['to', 'cc', 'bcc'], subject: 'subject' },
  { pattern: /__reply$/, kind: 'message', channel: 'gmail', label: 'email reply', body: ['body', 'htmlBody'], recipients: ['to', 'cc', 'bcc'], subject: 'subject' },
  { pattern: /__forward$/, kind: 'message', channel: 'gmail', label: 'forward note', body: ['forwardText', 'htmlBody'], recipients: ['to', 'cc', 'bcc'], subject: 'subject' },
  { pattern: /__(create|update)_draft$/, kind: 'pass' },
  { pattern: /__apply_sensitive_(thread|message)_label$/, kind: 'pass' }, // Gmail labels, not Greenhouse
  // Slack
  { pattern: /__slack_send_message$/, kind: 'message', channel: 'slack', label: 'Slack message', body: ['message'] },
  { pattern: /__slack_schedule_message$/, kind: 'message', channel: 'slack', label: 'scheduled Slack message', body: ['message'] },
  { pattern: /__slack_send_message_draft$/, kind: 'pass' },
  { pattern: /__slack_(create|update)_canvas$/, kind: 'ask' },
  // Calendars and Calendly
  { pattern: /__(create|update|delete)_event$/, kind: 'ask' },
  { pattern: /__respond_to_event$/, kind: 'ask' },
  { pattern: /notion-calendar-(create|update|cancel)-events$/, kind: 'ask' },
  { pattern: /meetings-cancel_event$/, kind: 'ask' },
  { pattern: /meetings-create_invitee$/, kind: 'ask' },
  // Greenhouse recruiter writes (preview_* are read-only and match nothing here)
  { pattern: /__apply_[a-z_]+$/, kind: 'ask' },
  // The other Greenhouse server's writes. No exception names them, so they always ask.
  { pattern: /__(reject_application|unreject_application|move_application|delete_application|create_application|create_candidate|update_candidate|add_candidate_note|create_job)$/, kind: 'ask' },
];

// JOB.md "Which steps wait for Sam's OK". An exception is claimed by a fresh ledger intent
// record carrying `exception`. Message exceptions also need draft_sha256 to match the body.
export const EXCEPTIONS = {
  step1_stage_move: { kind: 'ask', tools: [/__apply_application_stage_move$/] },
  step6_interviewer_role: { kind: 'ask', tools: [/__apply_[a-z_]*(?:permission|role)[a-z_]*$/] },
  step7_interviewer_chase_12h: { kind: 'message', tools: [/__slack_send_message$/] },
  step7_interviewer_chase_24h: { kind: 'message', tools: [/__slack_send_message$/] },
  step8_standard_confirmation: { kind: 'ask', tools: [/__apply_[a-z_]*(?:interview|confirmation|candidate_note)[a-z_]*$/, /__(create|update)_event$/] },
  step8_confirmation_email: { kind: 'message', tools: [/__send_message$/, /__reply$/] },
  step9_urgent_cancellation: { kind: 'message' },
  step10_live_nudge: { kind: 'message' },
  step10_scorecard_chase_24h: { kind: 'message', tools: [/__slack_send_message$/] },
  '12h_rsvp_chase': { kind: 'message', tools: [/__slack_send_message$/] },
  '24h_rsvp_chase': { kind: 'message', tools: [/__slack_send_message$/] },
  '24h_scorecard_chase': { kind: 'message', tools: [/__slack_send_message$/] },
  calendar_hold: { kind: 'ask', tools: [/__(create|update|delete)_event$/] },
  day_before_reminder: { kind: 'message', tools: [/__send_message$/, /__reply$/, /__slack_send_message$/] },
  pre_interview_check: { kind: 'message', tools: [/__slack_send_message$/] },
  '24h_avail_nudge': { kind: 'message', tools: [/__send_message$/, /__reply$/] },
  urgent_cancel_rebook: { kind: 'message' },
  call_waiting_nudge: { kind: 'message' },
};

export function classify(toolName) {
  if (typeof toolName !== 'string') return null;
  const row = TOOLS.find(r => r.pattern.test(toolName));
  return row && row.kind !== 'pass' ? row : null;
}

// ---------------------------------------------------------------------------------------
// Normalisation. Applied identically to what was shown and what is about to be sent.
// ---------------------------------------------------------------------------------------
export function normalize(input) {
  return String(input ?? '')
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, '') // quote markers
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1') // markdown escapes
    .replace(/[*_`]/g, '') // emphasis and code markers
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑]/g, '-') // hyphens stay hyphens
    .replace(/[‒-―−﹘]/g, '—') // figure/en/em dash, bar, minus
    .replace(/-{2,}/g, '—')
    .replace(/\s*—\s*/g, ' — ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html) {
  const links = [];
  for (const m of String(html).matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (href && !href.startsWith('#')) links.push(href.replace(/^mailto:/i, '').split('?')[0]);
  }
  const text = decodeEntities(String(html)
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ''));
  return { text, links };
}

function slackToText(message) {
  const links = [];
  const text = String(message)
    .replace(/<[@!#][^>]*>/g, ' ') // <@U123>, <@U123|name>, <!here>, <#C123|chan>
    .replace(/<((?:https?|mailto):[^|>]+)(?:\|([^>]*))?>/g, (m, url, label) => {
      links.push(url.replace(/^mailto:/i, ''));
      return label ?? url;
    });
  return { text, links };
}

// The outgoing wording of a message tool call: normalised parts, links, recipients, subject.
export function outgoing(row, input = {}) {
  const parts = [];
  const links = [];
  for (const field of row.body) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (field === 'htmlBody') {
      const h = htmlToText(value);
      parts.push(normalize(h.text));
      links.push(...h.links);
    } else if (row.channel === 'slack') {
      const s = slackToText(value);
      parts.push(normalize(s.text));
      links.push(...s.links);
    } else {
      parts.push(normalize(value));
    }
  }
  const recipients = [];
  const unparsedRecipients = [];
  for (const field of row.recipients ?? []) {
    const value = input[field];
    if (value == null || value === '') continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      const found = String(item).match(/[^\s<>,;"'()]+@[^\s<>,;"'()]+/g);
      if (found) recipients.push(...found);
      else if (String(item).trim()) unparsedRecipients.push(String(item));
    }
  }
  const subject = row.subject && typeof input[row.subject] === 'string' && input[row.subject].trim() ? input[row.subject] : null;
  return { parts: parts.filter(Boolean), links, recipients, unparsedRecipients, subject };
}

export function draftHash(parts) {
  return crypto.createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------
// Transcript: what Sam saw before his latest message.
// ---------------------------------------------------------------------------------------
const NON_HUMAN_TAGS = [
  'system-reminder', 'command-name', 'command-message', 'command-args', 'command-contents',
  'local-command-stdout', 'local-command-stderr', 'local-command-caveat',
  'bash-input', 'bash-stdout', 'bash-stderr', 'task-notification', 'side-sessions-event',
  'cross-session-message', 'user-prompt-submit-hook',
];
const NON_HUMAN_RE = new RegExp(`<(${NON_HUMAN_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?(?:</\\1\\s*>|$)`, 'g');

function genuineText(text) {
  const rest = String(text).replace(NON_HUMAN_RE, '').trim();
  if (!rest || /^\[Request interrupted by user/.test(rest)) return null;
  return rest;
}

function blocksText(content) {
  if (typeof content === 'string') return { text: content, other: false, onlyToolResults: false };
  if (!Array.isArray(content) || !content.length) return { text: '', other: false, onlyToolResults: false };
  const texts = [];
  let other = false;
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    else if (b?.type === 'image') other = true;
  }
  return { text: texts.join('\n'), other, onlyToolResults: content.every(b => b?.type === 'tool_result') };
}

// Returns the raw text of a genuine human message, '' for a human message with no text
// (e.g. image only), or null when the entry is not a human message.
export function humanMessage(entry) {
  if (!entry || entry.isSidechain === true || entry.isMeta === true) return null;
  if (entry.type === 'user') {
    if (entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return null;
    if (entry.origin && entry.origin.kind !== 'human') return null;
    const { text, other, onlyToolResults } = blocksText(entry.message?.content);
    if (onlyToolResults) return null;
    if (text) {
      if (genuineText(text) !== null) return typeof entry.message.content === 'string' ? entry.message.content : text;
      return null;
    }
    return other && entry.origin?.kind === 'human' ? '' : null;
  }
  if (entry.type === 'attachment') {
    const a = entry.attachment;
    // Mid-turn messages are delivered as queued_command attachments.
    if (a?.type !== 'queued_command' || a.origin?.kind !== 'human' || a.isMeta === true) return null;
    const { text, other } = blocksText(a.prompt);
    if (text) return genuineText(text) !== null ? (typeof a.prompt === 'string' ? a.prompt : text) : null;
    return other ? '' : null;
  }
  return null;
}

function assistantText(entry) {
  if (entry?.type !== 'assistant' || entry.isSidechain === true) return null;
  const c = entry.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return null;
  const texts = c.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
  return texts.length ? texts.join('\n') : null;
}

// Reads the transcript and returns the assistant text shown between the previous genuine
// human message and the latest one. Throws on any read or parse problem (caller denies).
export function displayedBeforeLatestHuman(transcriptPath) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) throw new Error('the hook input has no transcript_path');
  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n');
  // A final line with no newline may be a write in progress; skip it only if it does not parse.
  const lastComplete = raw.endsWith('\n') ? lines.length : lines.length - 1;
  const texts = []; // [index, text]
  const humans = []; // { index, boundary }
  const enqueues = []; // { index, content, claimed }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (e) {
      if (i >= lastComplete) continue;
      throw new Error(`transcript line ${i + 1} is not valid JSON`);
    }
    if (entry?.type === 'queue-operation') {
      if (entry.operation === 'enqueue' && typeof entry.content === 'string') enqueues.push({ index: i, content: entry.content, claimed: false });
      continue;
    }
    const said = assistantText(entry);
    if (said !== null) {
      texts.push([i, said]);
      continue;
    }
    const human = humanMessage(entry);
    if (human === null) continue;
    // A queued message was submitted at its enqueue, not at its delivery: text printed in
    // between was not on screen when Sam hit enter.
    const floor = humans.length ? humans[humans.length - 1].boundary : -1;
    const match = enqueues.find(q => !q.claimed && q.index > floor && q.content === human);
    if (match) match.claimed = true;
    humans.push({ index: i, boundary: match ? match.index : i });
  }
  if (!humans.length) return { found: false, text: '' };
  const latest = humans[humans.length - 1];
  const start = humans.length > 1 ? humans[humans.length - 2].index : -1;
  const shown = texts.filter(([i]) => i > start && i < latest.boundary).map(([, t]) => t);
  return { found: true, text: shown.join('\n\n') };
}

function haystacks(displayed) {
  const linkless = displayed.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, '$1');
  return { text: normalize(linkless), raw: normalize(displayed) };
}

// ---------------------------------------------------------------------------------------
// Ledger exceptions
// ---------------------------------------------------------------------------------------
function readLedger() {
  let content;
  try {
    content = fs.readFileSync(LEDGER_PATH(), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { records: [], error: null };
    return { records: [], error: `ledger unreadable (${e.code ?? e.message})` };
  }
  const records = [];
  for (const [i, raw] of content.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      return { records: [], error: `ledger line ${i + 1} is not valid JSON` };
    }
  }
  return { records, error: null };
}

// Finds a fresh, unconsumed intent record that grants `kind` for this tool (and, for
// messages, carries the matching draft hash). Returns { record } or { note }.
export function findException({ kind, toolName, hash, now = Date.now() }) {
  const { records, error } = readLedger();
  if (error) return { note: `no exception honoured: ${error}` };
  let nearMiss = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r?.kind !== 'action' || r.status !== 'intent' || typeof r.exception !== 'string') continue;
    const spec = EXCEPTIONS[r.exception];
    if (!spec || spec.kind !== kind) continue;
    if (spec.tools && !spec.tools.some(p => p.test(toolName))) continue;
    const at = Date.parse(r.at);
    if (!Number.isFinite(at) || at < now - EXCEPTION_WINDOW_MS || at > now + CLOCK_SKEW_MS) continue;
    const consumed = records.slice(i + 1).some(d => d?.kind === 'action' && ['dispatched', 'succeeded', 'reconciled'].includes(d.status)
      && ((r.action_key && d.action_key === r.action_key) || (r.idempotency_key && d.idempotency_key === r.idempotency_key)));
    if (consumed) continue;
    if (kind === 'message' && r.draft_sha256 !== hash) {
      nearMiss = `a ${r.exception} intent exists but its draft_sha256 does not match this body`;
      continue;
    }
    return { record: r };
  }
  return { note: nearMiss };
}

function logException(toolName, record, sessionId) {
  try {
    const file = LOG_PATH();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = { at: new Date().toISOString(), tool: toolName, exception: record.exception, action_key: record.action_key ?? null, session_id: sessionId ?? null };
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 });
  } catch { /* logging never changes the decision */ }
}

// ---------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------
const decision = (permissionDecision, permissionDecisionReason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision, permissionDecisionReason } });
const SHOW_HOW = 'Print the full text in your reply as plain chat text (greeting through sign-off, plus every recipient address and the subject for an email, and every link URL), ask Sam, and send only after he answers. Tool inputs, summary boxes and thinking do not count as shown.';

function gateMessage(row, input) {
  const toolName = input.tool_name;
  const args = input.tool_input ?? {};
  const what = row.label;
  if (input.agent_id) return decision('deny', `Blocked: subagents may not send a ${what}. Return the exact draft to the main session, which must show it to Sam verbatim and send it after he answers.`);
  if (row.channel === 'gmail' && args.draftId) return decision('deny', `Blocked: this ${what} sends a saved draft by draftId, so the gate cannot see its wording. Send with an explicit body instead, after printing that exact body for Sam and getting his answer.`);
  const out = outgoing(row, args);
  if (!out.parts.length) return decision('deny', `Blocked: this ${what} has an empty body. Nothing goes out without wording Sam has read.`);

  const exc = findException({ kind: 'message', toolName, hash: draftHash(out.parts) });
  if (exc.record) {
    logException(toolName, exc.record, input.session_id);
    return null;
  }
  const excNote = exc.note ? ` (${exc.note})` : '';

  let shown;
  try {
    shown = displayedBeforeLatestHuman(input.transcript_path);
  } catch (e) {
    return decision('deny', `Blocked: the send gate could not read the session transcript (${e.message}), so it cannot confirm Sam saw this ${what}. Show Sam the exact text and have him send it himself, or retry once the transcript is readable.${excNote}`);
  }
  if (!shown.found) return decision('deny', `Blocked: Sam has not replied since any draft was shown, so this ${what} has not been approved. ${SHOW_HOW}${excNote}`);
  const hay = haystacks(shown.text);
  const inHay = s => hay.text.includes(s) || hay.raw.includes(s);
  const misses = [];
  if (!out.parts.every(inHay)) misses.push('the body');
  if (out.subject && !inHay(normalize(out.subject))) misses.push('the subject line');
  const rawLower = hay.raw.toLowerCase();
  const missingAddrs = out.recipients.filter(a => !rawLower.includes(normalize(a).toLowerCase()));
  if (missingAddrs.length) misses.push(`recipient address(es) ${missingAddrs.join(', ')}`);
  if (out.unparsedRecipients.length) misses.push('a recipient field with no readable address');
  const missingLinks = out.links.filter(u => !hay.raw.includes(normalize(u)));
  if (missingLinks.length) misses.push(`link URL(s) ${missingLinks.join(', ')}`);
  if (!misses.length) return null; // Sam saw this exact wording: no opinion, normal permissions apply
  return decision('deny', `Blocked: this ${what} has not been shown to Sam verbatim before his latest message; missing from what he saw: ${misses.join('; ')}. ${SHOW_HOW}${excNote}`);
}

function gateAsk(row, input) {
  const toolName = input.tool_name;
  if (!input.agent_id) {
    const exc = findException({ kind: 'ask', toolName });
    if (exc.record) {
      logException(toolName, exc.record, input.session_id);
      return null;
    }
  }
  return decision('ask', 'Outward write: Sam must approve this exact tool input.');
}

export function decide(input) {
  const row = classify(input?.tool_name);
  if (!row) return null;
  try {
    return row.kind === 'message' ? gateMessage(row, input) : gateAsk(row, input);
  } catch (e) {
    return row.kind === 'message'
      ? decision('deny', `Blocked: the send gate failed (${e.message}). Show Sam the exact text and ask him how to proceed.`)
      : decision('ask', `Outward write; the send gate failed (${e.message}), so Sam must approve it.`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--hash') {
    // node send-gate.mjs --hash <tool_name> < tool_input.json  -> draft_sha256 for an exception intent
    const row = classify(argv[1]);
    if (row?.kind !== 'message') {
      process.stderr.write(`--hash needs a message tool name (got ${JSON.stringify(argv[1])}).\n`);
      process.exitCode = 2;
      return;
    }
    const out = outgoing(row, JSON.parse(fs.readFileSync(0, 'utf8')));
    process.stdout.write(draftHash(out.parts) + '\n');
    return;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    process.stdout.write(JSON.stringify(decision('deny', `Blocked: the send gate could not parse its hook input (${e.message}).`)));
    return;
  }
  const result = decide(input);
  if (result) process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
