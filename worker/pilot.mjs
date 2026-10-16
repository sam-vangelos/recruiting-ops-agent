#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ALLOWED, JOB_ID, permitted } from './gate.mjs';
import { isActionDischarged, summarizeLedger } from './ledger.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICES = ['gmail', 'calendar', 'slack', 'greenhouse'];
// Pinned so the pilot never inherits whatever model the last terminal session set in ~/.claude/settings.json (it drifted between opus and sonnet overnight on 2026-10-15).
export const MODEL = process.env.PILOT_MODEL || 'claude-sonnet-5-5';
const REQUIRED_READS = {
  gmail: ['__search_threads'],
  calendar: ['__list_events'],
  slack: ['__slack_search_public_and_private'],
  greenhouse: ['__get_my_job', '__search_my_interviews'],
};
const MINUTE = 60_000;
export const DENIED = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Agent', 'Task', 'TaskStop', 'Skill',
  'WebFetch', 'WebSearch', 'Computer', 'PowerShell', 'NotebookEdit',
  'CronCreate', 'CronDelete', 'CronList', 'TaskCreate', 'TaskUpdate', 'Workflow',
  ...['send', 'reply', 'create', 'update', 'delete', 'apply', 'preview', 'mark',
    'respond', 'move', 'reject', 'unreject', 'cancel', 'archive', 'accept',
    'upload', 'remove', 'modify', 'add', 'set', 'trash', 'spam', 'post',
    'schedule', 'reschedule', 'invite', 'confirm', 'insert', 'patch', 'write',
    'forward', 'unarchive', 'untrash', 'decline', 'publish', 'share', 'save',
  ].flatMap(verb => [`mcp__*__${verb}*`, `mcp__*__*_${verb}*`]),
];
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.recruiting-agents/scheduling-pilot');
const iso = (n = Date.now()) => new Date(n).toISOString();
const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
export function atomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Data directory must not be a symbolic link.');
  fs.chmodSync(dir, 0o700);
}
export function initialize(dir, intervalMinutes = 30) {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes < 1) throw new Error('interval-minutes must be positive.');
  privateDir(dir);
  const file = path.join(dir, 'config.json');
  const config = read(file);
  if (config) return config;
  const value = { installed_at: iso(), interval_minutes: intervalMinutes, job_id: JOB_ID };
  atomic(file, value);
  return value;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
export function takeLock(dir, intervalMinutes = 30) {
  const file = path.join(dir, 'run.lock');
  const owner = { pid: process.pid, token: crypto.randomUUID(), started_at: iso() };
  const claim = () => fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  const blocked = existing => {
    // Record the blocked attempt for health without touching state.json.
    atomic(path.join(dir, 'blocked.json'), { at: iso(), owner: existing });
    return new Error('Run lock exists. Check status; use recover-lock only after its owner has stopped.');
  };
  let reclaimed = null;
  try { claim(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let existing = null;
    try { existing = read(file); } catch { /* An unreadable lock is never reclaimed. */ }
    // Reclaim only a lock whose owner and child are both gone and which is older than one interval.
    const stale = existing && typeof existing === 'object' && !alive(existing.pid) && !alive(existing.child_pid) &&
      Date.now() - Date.parse(existing.started_at) > intervalMinutes * MINUTE;
    if (!stale) throw blocked(existing);
    let current = null;
    try { current = read(file); } catch { /* Changed into something unreadable. */ }
    if (current?.token !== existing.token) throw blocked(current);
    fs.unlinkSync(file);
    try { claim(); } catch (e2) { if (e2.code !== 'EEXIST') throw e2; throw blocked(null); }
    reclaimed = existing;
  }
  const release = () => { if (read(file)?.token === owner.token) fs.unlinkSync(file); };
  release.reclaimed = reclaimed;
  return release;
}
export function recoverLock(dir) {
  const file = path.join(dir, 'run.lock');
  const owner = read(file);
  if (!owner) return false;
  if (!Number.isInteger(owner.pid) || alive(owner.pid) || alive(owner.child_pid)) throw new Error('Cannot recover a live or unidentifiable lock owner.');
  // Recovery is an explicit operator command, never a competing scheduled run.
  if (read(file)?.token !== owner.token) throw new Error('Lock owner changed; leave it untouched.');
  fs.unlinkSync(file);
  return true;
}
function service(name) {
  if (name.includes('__Gmail__') || name.includes('_Gmail__')) return 'gmail';
  if (name.includes('_Google_Calendar__')) return 'calendar';
  if (name.includes('_Slack__')) return 'slack';
  if (name.includes('greenhouse-recruiter')) return 'greenhouse';
  return null;
}
function decode(content) {
  if (typeof content === 'string') { try { return decode(JSON.parse(content)); } catch { return { text: content }; } }
  if (Array.isArray(content)) {
    const text = content.filter(x => x.type === 'text').map(x => x.text).join('\n');
    return text ? decode(text) : content;
  }
  return content;
}
function walk(value, fn) {
  if (!value || typeof value !== 'object') return;
  fn(value);
  for (const x of Object.values(value)) if (x && typeof x === 'object') walk(x, fn);
}
const serialized = x => JSON.stringify(x);
function hasBody(value) {
  let found = false;
  walk(value, obj => { for (const [key, v] of Object.entries(obj)) if (/^(htmlBody|textBody|plaintextBody|body|plainBody|text_body|bodyText)$/.test(key) && typeof v === 'string' && v.trim()) found = true; });
  return found;
}
function resultFailed(data) {
  let failed = false;
  walk(data, obj => {
    if (obj.isError === true || obj.is_error === true || obj.ok === false || obj.success === false || (obj.error && !Array.isArray(obj.error))) failed = true;
  });
  return failed;
}
function pageState(data) {
  const tokens = [];
  let more = false;
  let truncated = false;
  let pages = null;
  walk(data, obj => {
    for (const key of ['nextPageToken', 'next_page_token', 'next_cursor', 'nextCursor', 'next_page', 'next_offset']) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '' && obj[key] !== false) tokens.push(String(obj[key]));
    }
    if (obj.has_more === true || obj.hasMore === true) more = true;
    if (obj.truncated === true || obj.is_truncated === true || obj.pagination_truncated === true) truncated = true;
    if (typeof obj.pagination_info === 'string') {
      const cursor = obj.pagination_info.match(/cursor\s+`([^`]+)`/i);
      if (cursor) tokens.push(cursor[1]);
      else if (/next page/i.test(obj.pagination_info)) more = true;
    }
    if (obj.complete === false || obj.incompleteProjection === true) truncated = true;
    if (Number.isFinite(obj.page) && Number.isFinite(obj.pages)) pages = { page: obj.page, pages: obj.pages };
  });
  return { tokens, more, truncated, pages };
}
function slackResultsRecognized(data) {
  if (Array.isArray(data?.results)) return true;
  if (typeof data?.results !== 'string' || typeof data?.pagination_info !== 'string') return false;
  const text = data.results;
  if (!/^# Search Results for:/m.test(text)) return false;
  // Slack's live empty answer: a bare "No results found." body with the terminal pagination line.
  if (/^No results found\.$/m.test(text) && !/^### Result /m.test(text)) return /End of results - No more pages available/i.test(data.pagination_info);
  const header = text.match(/^## Messages \((\d+) results?\)/m);
  if (!header) return false;
  const count = Number(header[1]);
  const blocks = text.split(/^### Result (\d+) of (\d+)\s*$/m).slice(1);
  if (blocks.length !== count * 3) return false;
  for (let i = 0; i < blocks.length; i += 3) {
    if (Number(blocks[i]) !== i / 3 + 1 || Number(blocks[i + 1]) !== count) return false;
    const body = blocks[i + 2];
    if (!['Channel', 'From', 'Time', 'Message_ts', 'Permalink', 'Text'].every(label => new RegExp('^' + label + ':', 'm').test(body))) return false;
    if (!/^Message_ts: \d+\.\d+/m.test(body) || !/^Permalink:.*https:\/\/[^\s)]+\/archives\//m.test(body)) return false;
  }
  return /End of results - No more pages available|cursor\s+`[^`]+`/i.test(data.pagination_info);
}
function messageValue(data) { return data?.message ?? data; }
function fullMessage(receipt) {
  const data = messageValue(receipt.data);
  const id = receipt.input?.messageId ?? receipt.input?.message_id ?? receipt.input?.id;
  return !receipt.failed && String(data?.id) === String(id) && id !== undefined && hasBody(data) && !pageState(data).truncated;
}
function draftValue(data) {
  return { id: data?.id, message: { id: data?.messageId, threadId: data?.threadId, htmlBody: data?.htmlBody, plaintextBody: data?.plaintextBody } };
}
function fullDraft(receipt) {
  const data = draftValue(receipt.data);
  const id = receipt.input?.draftId ?? receipt.input?.draft_id ?? receipt.input?.id;
  return !receipt.failed && id !== undefined && String(data?.id) === String(id) &&
    typeof data?.message?.id === 'string' && data.message.id.length > 0 &&
    typeof data?.message?.threadId === 'string' && data.message.threadId.length > 0 &&
    hasBody(data.message) && !pageState(receipt.data).truncated;
}
function fullThread(receipt, all) {
  const messages = receipt.data?.messages;
  if (!Array.isArray(messages)) return false;
  const threadId = receipt.input?.threadId ?? receipt.input?.thread_id ?? receipt.input?.id;
  if (receipt.data?.id !== undefined && String(receipt.data.id) !== String(threadId)) return false;
  const ids = messages.map(x => x.id).filter(Boolean);
  if (!messages.length || new Set(ids).size !== ids.length) return false;
  // messageCount may include unsent drafts; the gap is reported as an unknown, not reconciled here.
  return messages.every(message => hasBody(message) || (message.id && all.some(x =>
    x.name.endsWith('__get_message') && fullMessage(x) &&
    String(messageValue(x.data).id) === String(message.id) &&
    (!messageValue(x.data).threadId || String(messageValue(x.data).threadId) === String(threadId)))));
}
function queryIdentity(receipt) {
  const input = withoutPage(receipt.input);
  // Message format changes representation, not the requested conversation or message.
  if (['__get_thread', '__get_message', '__get_draft'].some(suffix => receipt.name.endsWith(suffix))) for (const key of ['format', 'messageFormat', 'message_format']) delete input[key];
  return serialized(input);
}
function readProblem(receipt, all = []) {
  const d = receipt.data;
  if (receipt.failed) return 'Tool read failed';
  if (receipt.name.endsWith('__list_events') && !Array.isArray(d?.events)) return 'Calendar response shape is unrecognized';
  if (receipt.name.endsWith('__slack_search_public_and_private') && !slackResultsRecognized(d)) return 'Slack response shape is unrecognized';
  if (receipt.name.endsWith('__get_my_job') && String(d?.data?.id) !== JOB_ID) return 'Greenhouse job did not return the pilot job';
  if (receipt.name.endsWith('__search_my_interviews') && (!Array.isArray(d?.data) || d?.ok !== true)) return 'Greenhouse interview response shape is unrecognized';
  if (receipt.name.endsWith('__search_threads') && !Array.isArray(d?.threads ?? d?.data?.threads) &&
    !(d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 0)) return 'Gmail search response shape is unrecognized';
  if (receipt.name.endsWith('__get_thread') && !fullThread(receipt, all)) return 'Gmail thread lacks full bodies for every message';
  if (receipt.name.endsWith('__get_message') && !fullMessage(receipt)) return 'Gmail message has no matching full-body receipt';
  if (receipt.name.endsWith('__list_drafts') && !Array.isArray(d?.drafts)) return 'Gmail draft listing shape is unrecognized';
  if (receipt.name.endsWith('__get_draft') && !fullDraft(receipt)) return 'Gmail draft has no matching full-body receipt';
  if (pageState(d).truncated) return 'Truncated read';
  return null;
}
function pageInput(input = {}) { return Object.fromEntries(Object.entries(input).filter(([k]) => /cursor|page.?token|^page$|^offset$/i.test(k)).sort(([a], [b]) => a.localeCompare(b))); }
function firstPage(input) { return Object.entries(pageInput(input)).every(([k, v]) => v === '' || v === null || (/^page$/i.test(k) ? Number(v) === 1 : /^offset$/i.test(k) && Number(v) === 0)); }
export function verify(events, report) {
  report = structuredClone(report);
  const calls = new Map();
  const results = new Map();
  const errors = [];
  const warnings = [];
  const unverified = [];
  const recoveredReads = [];
  const final = events.filter(e => e.type === 'result').at(-1);
  if (!final || final.is_error || final.subtype !== 'success' || final.permission_denials?.length) errors.push('Claude did not complete cleanly.');
  for (const event of events) {
    for (const b of event.message?.content ?? []) {
      if (b.type === 'tool_use') {
        if (calls.has(b.id)) continue;
        calls.set(b.id, b);
        if (!permitted(b.name, b.input)) errors.push(`Forbidden or out-of-scope tool: ${b.name}`);
      }
      if (b.type === 'tool_result') {
        const call = calls.get(b.tool_use_id);
        if (!call) { errors.push('Unmatched tool receipt.'); continue; }
        const data = decode(b.content);
        results.set(b.tool_use_id, { ...call, data, service: service(call.name), failed: Boolean(b.is_error || resultFailed(data)), order: results.size });
      }
    }
  }
  for (const [id, call] of calls) if (!results.has(id)) errors.push(`Missing receipt: ${call.name}`);
  const all = [...results.values()];
  const sameQuery = (a, b) => a.name === b.name && queryIdentity(a) === queryIdentity(b);
  function fullyRead(receipt, visited = new Set()) {
    if (readProblem(receipt, all) || visited.has(receipt.id)) return false;
    const seen = new Set([...visited, receipt.id]);
    const p = pageState(receipt.data);
    const siblings = all.filter(x => sameQuery(x, receipt));
    if (p.more && !p.tokens.length && !p.pages) return false;
    if (!p.tokens.every(token => siblings.some(x => Object.values(pageInput(x.input)).some(v => String(v) === token) && fullyRead(x, seen)))) return false;
    if (p.pages && p.pages.page < p.pages.pages && !siblings.some(x => Number(x.input?.page) === p.pages.page + 1 && fullyRead(x, seen))) return false;
    return true;
  }
  const receipts = new Map();
  for (const receipt of all) {
    if (fullyRead(receipt)) { receipts.set(receipt.id, receipt); continue; }
    const recovery = receipt.service && permitted(receipt.name, receipt.input) && all.find(x =>
      x.order > receipt.order && sameQuery(x, receipt) && fullyRead(x) &&
      (serialized(pageInput(x.input)) === serialized(pageInput(receipt.input)) || firstPage(x.input)));
    const reason = readProblem(receipt, all) ?? 'Unread or unresolved pagination';
    if (recovery) recoveredReads.push({ id: receipt.id, name: receipt.name, reason, recovered_by: recovery.id });
    else unverified.push({ id: receipt.id, name: receipt.name, reason });
  }
  const values = [...receipts.values()];
  // Only verified good receipts are eligible evidence; failed reads remain diagnostics.
  const resolveRefs = refs => Array.isArray(refs) ? [...new Set(refs.flatMap(ref => receipts.has(ref) ? [ref] : values.filter(x => x.name === ref && x.service).map(x => x.id).length ? values.filter(x => x.name === ref && x.service).map(x => x.id) : [ref]))] : refs;
  for (const s of SERVICES) if (report?.coverage?.[s]) report.coverage[s].receipt_ids = resolveRefs(report.coverage[s].receipt_ids);
  for (const ep of report?.episodes ?? []) for (const item of [...(ep.facts ?? []), ...(ep.next_actions ?? []), ...(ep.resolution ? [ep.resolution] : [])]) item.evidence = resolveRefs(item.evidence);
  // An explicitly incomplete source with notes is a partial scan, not a failed one.
  const partial = SERVICES.filter(s => report?.coverage?.[s]?.complete === false);
  for (const s of SERVICES) {
    const coverage = report?.coverage?.[s];
    if (partial.includes(s)) {
      if (typeof coverage.notes !== 'string' || !coverage.notes.trim()) errors.push(`Incomplete ${s} coverage needs notes.`);
    } else if (!coverage || coverage.complete !== true || !Array.isArray(coverage.receipt_ids) || !coverage.receipt_ids.length) errors.push(`Incomplete ${s} coverage.`);
    else if (!coverage.receipt_ids.every(id => receipts.get(id)?.service === s)) errors.push(`Ungrounded ${s} coverage.`);
  }
  if (partial.length === SERVICES.length) errors.push('Every source is incomplete; nothing was verified.');
  for (const s of SERVICES) if (!partial.includes(s)) for (const suffix of REQUIRED_READS[s]) if (!values.some(x => x.name.endsWith(suffix))) errors.push(`Missing actual read: ${suffix}`);
  // A receipt that is neither fully read nor recovered is fatal only when the report relies on it.
  const cited = new Set([
    ...SERVICES.filter(s => !partial.includes(s)).flatMap(s => Array.isArray(report?.coverage?.[s]?.receipt_ids) ? report.coverage[s].receipt_ids : []),
    ...(report?.episodes ?? []).flatMap(ep => [...(ep.facts ?? []), ...(ep.next_actions ?? []), ...(ep.resolution ? [ep.resolution] : [])]).flatMap(item => Array.isArray(item?.evidence) ? item.evidence : []),
  ]);
  for (const bad of unverified) {
    if (cited.has(bad.id)) errors.push(`${bad.reason}: ${bad.name}`);
    else warnings.push(bad);
  }
  for (const receipt of partial.includes('gmail') ? [] : values.filter(x => x.name.endsWith('__search_threads'))) {
    for (const thread of receipt.data?.threads ?? receipt.data?.data?.threads ?? []) {
      if (!values.some(x => x.name.endsWith('__get_thread') && String(x.input?.threadId ?? x.input?.thread_id ?? x.input?.id) === String(thread.id))) errors.push('A Gmail search result has no successful full-body read.');
    }
  }
  if (!Array.isArray(report?.episodes) || !Array.isArray(report?.unknowns)) errors.push('Invalid report structure.');
  const seen = new Set();
  for (const ep of report?.episodes ?? []) {
    if (!['open', 'closed'].includes(ep.status) || !ep.episode_id || seen.has(ep.episode_id) || !Array.isArray(ep.facts) || !Array.isArray(ep.next_actions) || !Array.isArray(ep.unknowns)) { errors.push('Invalid or duplicate episode.'); continue; }
    seen.add(ep.episode_id);
    if (ep.status === 'closed' && (!ep.resolution || ep.next_actions.length)) errors.push('Closed episode needs current evidence of resolution and no pending actions.');
    for (const item of [...ep.facts, ...ep.next_actions, ...(ep.resolution ? [ep.resolution] : [])]) {
      if (typeof item.text !== 'string' || !Array.isArray(item.evidence) || !item.evidence.length || !item.evidence.every(id => receipts.get(id)?.service)) errors.push('Ungrounded episode fact or action.');
    }
    const keys = new Set();
    for (const action of ep.next_actions) {
      if (typeof action.action_key !== 'string' || !action.action_key || keys.has(action.action_key) || typeof action.draft !== 'string') errors.push('Invalid or duplicate next action.');
      keys.add(action.action_key);
    }
  }
  return { report, ok: errors.length === 0, errors: [...new Set(errors)], warnings, partial, recovered_reads: recoveredReads, reads: values.filter(x => x.service).map(x => ({ id: x.id, name: x.name, service: x.service })) };
}
function withoutPage(input = {}) { return Object.fromEntries(Object.entries(input).filter(([k]) => !/cursor|page.?token|^page$|^offset$|^page_?size$|^per_?page$|^limit$|^max_?results$/i.test(k)).sort(([a], [b]) => a.localeCompare(b))); }
export function changes(previous, current) {
  const fingerprint = action => serialized({ text: action.text.trim(), draft: action.draft.trim() });
  const old = new Map((previous?.episodes ?? []).flatMap(ep => ep.next_actions.map(a => [`${ep.episode_id}/${a.action_key}`, fingerprint(a)])));
  const fresh = (current.episodes ?? []).flatMap(ep => ep.next_actions.map(a => ({ key: `${ep.episode_id}/${a.action_key}`, fingerprint: fingerprint(a) })));
  return { new_or_changed: fresh.filter(a => old.get(a.key) !== a.fingerprint).map(a => a.key), removed: [...old.keys()].filter(key => !fresh.some(a => a.key === key)) };
}
export function markdown(checkpoint) {
  const partial = checkpoint.partial ?? [];
  const notes = partial.map(s => String(checkpoint.report.coverage?.[s]?.notes ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lines = ['# Scheduling proposals — local drafts only', '', `Verified scan: ${checkpoint.scanned_at}`,
    ...(partial.length ? [`Partial scan: ${partial.join(', ')} not read. ${notes.join(' ')}`.trimEnd()] : []),
    `New or changed proposals: ${checkpoint.changes.new_or_changed.length}`, '', 'These proposals have not been sent or executed. Sources and verified receipts are in checkpoint.json.', ''];
  for (const ep of checkpoint.report.episodes) {
    lines.push(`## ${ep.episode_id}`, '', `Status: ${ep.status}`, '', ...ep.facts.map(f => `- ${f.text}`), '');
    if (ep.resolution) lines.push(`Resolution: ${ep.resolution.text}`, '', `Evidence: ${ep.resolution.evidence.join(', ')}`, '');
    for (const a of ep.next_actions) lines.push(`### ${a.text}`, '', a.draft || '(No message draft.)', '', `Evidence: ${a.evidence.join(', ')}`, '');
    if (ep.unknowns.length) lines.push('Unresolved:', ...ep.unknowns.map(x => `- ${x}`), '');
  }
  if (!checkpoint.report.episodes.length) lines.push('No relevant scheduling episodes found in the completed scan.');
  if (checkpoint.report.unknowns.length) lines.push('', '## Unresolved questions', '', ...checkpoint.report.unknowns.map(x => `- ${x}`), '');
  return lines.join('\n') + '\n';
}
const RUN_HISTORY = 10;
function keepHistory(dataDir, startedAt, files) {
  const runs = path.join(dataDir, 'runs');
  privateDir(runs);
  const id = startedAt.replaceAll(':', '-');
  for (const [source, suffix] of files) atomic(path.join(runs, `${id}-${suffix}`), fs.readFileSync(path.join(dataDir, source), 'utf8'));
  const ids = [...new Set(fs.readdirSync(runs).map(f => f.match(/^(.+)-(stream\.jsonl|verification\.json)$/)?.[1]).filter(Boolean))].sort();
  for (const old of ids.slice(0, -RUN_HISTORY)) for (const suffix of ['stream.jsonl', 'verification.json']) fs.rmSync(path.join(runs, `${old}-${suffix}`), { force: true });
}
function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return []; throw e; }
}
function realDir(dir) {
  try { return fs.lstatSync(dir).isDirectory(); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return false; throw e; }
}
function removeIfEmpty(dir) {
  try { fs.rmdirSync(dir); } catch (e) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(e.code)) throw e; }
}
function removeRegularFiles(dir) {
  for (const entry of entries(dir)) {
    const target = path.join(dir, entry.name);
    if (entry.isFile()) fs.rmSync(target, { force: true });
    else if (entry.isDirectory()) { removeRegularFiles(target); removeIfEmpty(target); }
  }
}
// Claude Code persists oversized tool results under ~/.claude/projects/<cwd with / and . as ->/<session>/tool-results/.
// They can hold candidate content, so each run removes its own and nothing else.
function removePersistedToolResults(projectsDir, cwd) {
  const cwds = new Set([cwd]);
  try { cwds.add(fs.realpathSync(cwd)); } catch { /* The data directory exists during a run. */ }
  for (const dir of cwds) {
    const project = path.join(projectsDir, dir.replace(/[/.]/g, '-'));
    if (!realDir(project)) continue;
    for (const session of entries(project)) {
      if (!session.isDirectory()) continue;
      const results = path.join(project, session.name, 'tool-results');
      if (!realDir(results)) continue;
      removeRegularFiles(results);
      removeIfEmpty(results);
      removeIfEmpty(path.join(project, session.name));
    }
  }
}
function shellQuote(s) { return `'${s.replaceAll("'", "'\\''")}'`; }
function settings() {
  const user = read(path.join(os.homedir(), '.claude/settings.json'), {});
  return { autoMemoryEnabled: false, enabledPlugins: Object.fromEntries(Object.keys(user.enabledPlugins ?? {}).map(k => [k, false])), permissions: { defaultMode: 'dontAsk', allow: ALLOWED, deny: DENIED }, hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(path.join(HERE, 'gate.mjs'))}`, onFailure: 'block' }] }] } };
}
export async function run({ dataDir = DEFAULT_DATA_DIR, intervalMinutes = 30, claude = path.join(os.homedir(), '.local/bin/claude'), claudeProjectsDir = path.join(os.homedir(), '.claude/projects') } = {}) {
  const config = initialize(dataDir, intervalMinutes);
  const release = takeLock(dataDir, config.interval_minutes);
  const stateFile = path.join(dataDir, 'state.json');
  const previousState = read(stateFile, {});
  const previous = read(path.join(dataDir, 'checkpoint.json'));
  const state = { ...previousState, started_at: iso(), last_progress: iso(), running: true, last_error: previousState.last_error ?? null, pid: process.pid, reclaimed_lock: release.reclaimed ?? null };
  atomic(stateFile, state);
  const events = [];
  let child;
  let timer;
  let streamFd;
  let stderrFd;
  let shutdownTimer;
  let stoppedBySignal = null;
  let verificationWritten = false;
  const stopChild = signal => {
    stoppedBySignal = signal;
    state.last_error = `Worker stopped by ${signal}.`;
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
      shutdownTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
      }, 5000);
      shutdownTimer.unref();
    }
  };
  const onTerm = () => stopChild('SIGTERM');
  const onInt = () => stopChild('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    atomic(path.join(dataDir, 'settings.json'), settings());
    const now = Date.now();
    const scanSince = previous ? Date.parse(previous.scanned_at) - 2 * 60 * MINUTE : now - 7 * 24 * 60 * MINUTE;
    const day = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(scanSince)).map(p => [p.type, p.value]));
    const ledger = summarizeLedger(dataDir);
    const context = { allowed_tools: ALLOWED, now: iso(now), timezone: 'America/Los_Angeles', scan_since: iso(scanSince), scan_since_date_pacific: `${day.year}/${day.month}/${day.day}`, upcoming_until: iso(now + 14 * 24 * 60 * MINUTE), previous_episodes: (previous?.report.episodes ?? []).filter(ep => ep.status !== 'closed'), ledger };
    const prompt = fs.readFileSync(path.join(HERE, 'prompt.md'), 'utf8') + '\n\n<scan_context>\n' + JSON.stringify(context) + '\n</scan_context>';
    streamFd = fs.openSync(path.join(dataDir, 'latest-stream.jsonl'), 'w', 0o600);
    stderrFd = fs.openSync(path.join(dataDir, 'latest-stderr.txt'), 'w', 0o600);
    const env = { ...process.env };
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete env[key];
    child = spawn(claude, ['--print', '--model', MODEL, '--setting-sources', 'user', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--no-chrome', '--disable-slash-commands', '--tools', 'ToolSearch', '--allowedTools', ALLOWED.join(','), '--disallowedTools', DENIED.join(','), '--settings', path.join(dataDir, 'settings.json'), '--system-prompt-file', path.join(HERE, 'prompt.md'), '--output-format', 'stream-json', '--verbose'], { cwd: dataDir, env, stdio: ['pipe', 'pipe', stderrFd], detached: true });
    const lock = read(path.join(dataDir, 'run.lock'));
    atomic(path.join(dataDir, 'run.lock'), { ...lock, child_pid: child.pid });
    const stopped = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
    // Attach immediately: a missing executable must not create an unhandled rejection.
    stopped.catch(() => {});
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    timer = setInterval(() => {
      if (Date.now() - Date.parse(state.last_progress) > 15 * MINUTE) {
        state.last_error = 'Worker made no progress for 15 minutes.';
        try { process.kill(-child.pid, Date.now() - Date.parse(state.last_progress) > 16 * MINUTE ? 'SIGKILL' : 'SIGTERM'); } catch { /* Already stopped. */ }
      }
    }, 30_000);
    timer.unref();
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      fs.writeSync(streamFd, line + '\n');
      state.last_progress = iso();
      atomic(stateFile, state);
      try { events.push(JSON.parse(line)); } catch { /* Stream diagnostics remain private. */ }
    }
    const code = await stopped;
    if (stoppedBySignal) throw new Error(`Worker stopped by ${stoppedBySignal}.`);
    if (code !== 0) throw new Error('Claude process failed; see private latest-stderr.txt.');
    const result = events.filter(e => e.type === 'result').at(-1);
    let report;
    try { report = result?.structured_output ?? JSON.parse(result?.result ?? ''); } catch { throw new Error('Claude did not return the expected JSON report.'); }
    const verification = verify(events, report);
    const missing = (previous?.report.episodes ?? []).filter(ep => ep.status !== 'closed' && !report.episodes?.some(x => x.episode_id === ep.episode_id));
    if (missing.length) { verification.ok = false; verification.errors.push('Previously open episodes were omitted; last good checkpoint retained.'); }
    report = verification.report;
    if (verification.ok) {
      for (const ep of report.episodes ?? []) {
        ep.next_actions = (ep.next_actions ?? []).filter(a => !isActionDischarged(ledger, ep.episode_id, a.action_key));
      }
    }
    atomic(path.join(dataDir, 'last-verification.json'), verification);
    verificationWritten = true;
    if (!verification.ok) throw new Error('Read verification failed: ' + verification.errors.join(' '));
    const checkpoint = { scanned_at: iso(), partial: verification.partial, report, receipts: verification.reads, changes: changes(previous?.report, report) };
    // checkpoint.json is authoritative; state and Markdown are derived views.
    atomic(path.join(dataDir, 'last-good-stream.jsonl'), fs.readFileSync(path.join(dataDir, 'latest-stream.jsonl'), 'utf8'));
    atomic(path.join(dataDir, 'checkpoint.json'), checkpoint);
    atomic(path.join(dataDir, 'DRAFTS.md'), markdown(checkpoint));
    state.last_success = checkpoint.scanned_at;
    state.last_error = null;
    return { success: true, new_or_changed: checkpoint.changes.new_or_changed.length, checkpoint: path.join(dataDir, 'checkpoint.json'), drafts: path.join(dataDir, 'DRAFTS.md') };
  } catch (e) {
    state.last_error = e.message;
    throw e;
  } finally {
    clearInterval(timer);
    clearTimeout(shutdownTimer);
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ } }
    if (streamFd !== undefined) fs.closeSync(streamFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    const housekeeping = [];
    try {
      keepHistory(dataDir, state.started_at, [
        ...(streamFd !== undefined ? [['latest-stream.jsonl', 'stream.jsonl']] : []),
        ...(verificationWritten ? [['last-verification.json', 'verification.json']] : []),
      ]);
    } catch (e) { housekeeping.push(`Run history: ${e.message}`); }
    try { removePersistedToolResults(claudeProjectsDir, dataDir); } catch (e) { housekeeping.push(`Tool-result cleanup: ${e.message}`); }
    state.housekeeping_error = housekeeping.length ? housekeeping.join(' ') : null;
    state.running = false;
    state.finished_at = iso();
    atomic(stateFile, state);
    release();
  }
}
export function assess(config, state = {}, lock = null, now = Date.now(), { partial = [], blocked = null } = {}) {
  const reasons = [];
  const overdue = (2 * config.interval_minutes + 10) * MINUTE;
  const base = Date.parse(state.last_success ?? config.installed_at);
  if (lock && !alive(lock.pid)) reasons.push('Stopped worker left a lock. Run recover-lock after checking its process.');
  if (state.running && now - Date.parse(state.last_progress ?? state.started_at) > 15 * MINUTE) reasons.push('Worker has made no progress for 15 minutes.');
  if (state.last_error) reasons.push('Last run failed. Inspect private state.json and last-verification.json.');
  if (now - base > overdue) reasons.push(state.last_success ? 'Successful scan is overdue.' : 'No successful scan since installation.');
  if (partial?.length) reasons.push(`Last scan was partial: ${partial.join(', ')}.`);
  if (blocked?.at && !(Date.parse(blocked.at) <= Date.parse(state.last_success))) reasons.push(`A scheduled run was blocked by a lock at ${blocked.at}.`);
  return { checked_at: iso(now), status: reasons.length ? 'attention' : state.last_success ? 'healthy' : 'waiting_for_first_scan', reasons, last_success: state.last_success ?? null, last_started: state.started_at ?? null, interval_minutes: config.interval_minutes };
}
export function health({ dataDir = DEFAULT_DATA_DIR, notify = false, now = Date.now() } = {}) {
  const config = read(path.join(dataDir, 'config.json'));
  if (!config) throw new Error('Pilot is not initialized; schedule is not established.');
  const state = read(path.join(dataDir, 'state.json'), {});
  const checkpoint = read(path.join(dataDir, 'checkpoint.json'));
  if (checkpoint?.scanned_at) state.last_success = checkpoint.scanned_at;
  const result = assess(config, state, read(path.join(dataDir, 'run.lock')), now, { partial: checkpoint?.partial ?? [], blocked: read(path.join(dataDir, 'blocked.json')) });
  const prior = read(path.join(dataDir, 'health.json'));
  const alertKey = result.status === 'attention' ? result.reasons.join('|') : null;
  result.alert_key = alertKey;
  result.notified_key = prior?.notified_key ?? null;
  if (!alertKey) result.notified_key = null;
  if (notify && alertKey && alertKey !== result.notified_key) {
    const sent = spawnSync('/usr/bin/osascript', ['-e', 'display notification "Scheduling checks need attention. Open the pilot HEALTH.md for details." with title "Scheduling pilot stopped or incomplete"'], { stdio: 'ignore' });
    result.notification_requested = sent.status === 0;
    if (sent.status === 0) result.notified_key = alertKey;
  }
  atomic(path.join(dataDir, 'health.json'), result);
  atomic(path.join(dataDir, 'HEALTH.md'), `# Scheduling pilot: ${result.status}\n\nChecked: ${result.checked_at}\n\nLast verified scan: ${result.last_success ?? 'Never'}\n\n${result.reasons.map(x => '- ' + x).join('\n') || 'No overdue or failed checks detected.'}\n\nThis local monitor cannot run while the Mac is asleep or off. A stale checked time means monitoring itself has stopped.\n\nRecovery: node ${path.join(HERE, 'pilot.mjs')} recover-lock --data-dir ${JSON.stringify(dataDir)}\n`);
  return { ...result, health_file: path.join(dataDir, 'HEALTH.md'), drafts_file: path.join(dataDir, 'DRAFTS.md') };
}
export function status({ dataDir = DEFAULT_DATA_DIR, now = Date.now() } = {}) {
  const config = read(path.join(dataDir, 'config.json'));
  if (!config) throw new Error('Pilot is not initialized; schedule is not established.');
  const state = read(path.join(dataDir, 'state.json'), {});
  const checkpoint = read(path.join(dataDir, 'checkpoint.json'));
  if (checkpoint?.scanned_at) state.last_success = checkpoint.scanned_at;
  const monitor = read(path.join(dataDir, 'health.json'));
  return {
    ...assess(config, state, read(path.join(dataDir, 'run.lock')), now, { partial: checkpoint?.partial ?? [], blocked: read(path.join(dataDir, 'blocked.json')) }),
    monitor_checked_at: monitor?.checked_at ?? null,
    health_file: path.join(dataDir, 'HEALTH.md'),
    drafts_file: path.join(dataDir, 'DRAFTS.md'),
  };
}
export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const options = { dataDir: DEFAULT_DATA_DIR, intervalMinutes: 30 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir') options.dataDir = path.resolve(args[++i]);
    else if (args[i] === '--interval-minutes') options.intervalMinutes = Number(args[++i]);
    else if (args[i] === '--claude') options.claude = path.resolve(args[++i]);
    else if (args[i] === '--notify') options.notify = true;
    else throw new Error('Unknown argument. Commands: init, run, health, status, recover-lock.');
  }
  if (command === 'init') return initialize(options.dataDir, options.intervalMinutes);
  if (command === 'run') return run(options);
  if (command === 'health') return health(options);
  if (command === 'status') return status(options);
  if (command === 'recover-lock') return { recovered: recoverLock(options.dataDir) };
  throw new Error('Commands: init, run, health, status, recover-lock.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
