#!/usr/bin/env node
// Shadow model tests for the scheduling pilot: run the same read-only scan with a second model in its own data
// directory, then score each shadow run against the live run nearest before it. Never writes to the live data dir.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const SERVICES = ['gmail', 'calendar', 'slack', 'greenhouse'];
const MINUTE = 60_000;
const DEFAULT_WINDOW_MINUTES = 45;
const USAGE = 'Commands: cycle --model <id> --shadow-dir <dir> --live-dir <dir> --claude <path> [--out <dir>] [--window-minutes <n>]; pair --shadow-dir <dir> --live-dir <dir> [--out <dir>] [--window-minutes <n>].';

const read = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } };
function atomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`Output directory must not be a symbolic link: ${dir}`);
  fs.chmodSync(dir, 0o700);
}
// Resolves symlinks through the deepest existing ancestor, so not-yet-created directories still compare correctly.
function real(p) {
  const rest = [];
  let current = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...rest.reverse()); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
function checkDirs(shadowDir, liveDir, out) {
  if (!shadowDir || !liveDir) throw new Error('--shadow-dir and --live-dir are required.');
  const shadow = real(shadowDir), live = real(liveDir), output = real(out);
  if (within(shadow, live) || within(live, shadow)) throw new Error('--shadow-dir and --live-dir must be separate directories, neither inside the other.');
  if (within(output, live)) throw new Error('--out must not be inside --live-dir.');
  const runs = path.join(liveDir, 'runs');
  try { if (!fs.statSync(runs).isDirectory()) throw new Error('not a directory'); fs.readdirSync(runs); }
  catch (e) { throw new Error(`Live runs directory is unreadable: ${runs} (${e.code ?? e.message})`); }
}

// Run ids are pilot.mjs's started_at with ':' replaced by '-'; a run exists once its stream is kept under runs/.
function runIds(dataDir) {
  let files;
  try { files = fs.readdirSync(path.join(dataDir, 'runs')); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return []; throw e; }
  return files.map(f => f.match(/^(.+)-stream\.jsonl$/)?.[1]).filter(id => id && Number.isFinite(startOf(id))).sort();
}
const startOf = id => Date.parse(id.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3'));
const finite = x => (Number.isFinite(x) ? x : null);
// Only these fields leave the stream; the stream itself carries candidate content and is never copied.
function resultRecord(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let init = null, result = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'system' && event.subtype === 'init' && !init) init = event;
    if (event?.type === 'result') result = event;
  }
  const model = typeof init?.model === 'string' ? init.model : Object.keys(result?.modelUsage ?? {})[0] ?? null;
  return {
    model,
    subtype: typeof result?.subtype === 'string' ? result.subtype : null,
    is_error: typeof result?.is_error === 'boolean' ? result.is_error : null,
    total_cost_usd: finite(result?.total_cost_usd),
    duration_ms: finite(result?.duration_ms),
    num_turns: finite(result?.num_turns),
  };
}
function loadRun(dataDir, id) {
  const runs = path.join(dataDir, 'runs');
  return { id, verification: read(path.join(runs, `${id}-verification.json`)), result: resultRecord(path.join(runs, `${id}-stream.jsonl`)) };
}
function nearest(ids, start, windowMinutes) {
  const span = windowMinutes * MINUTE;
  const timed = ids.map(id => [id, startOf(id)]).filter(([, t]) => Number.isFinite(t));
  const before = timed.filter(([, t]) => t <= start && start - t <= span).sort((a, b) => b[1] - a[1])[0];
  if (before) return before[0];
  return timed.filter(([, t]) => t > start && t - start <= span).sort((a, b) => a[1] - b[1])[0]?.[0] ?? null;
}

// Episode ids are model-chosen, so two models name the same work differently. The subject is what the episode tracks:
// a Greenhouse application id (10+ digits standing as their own token, so neither the seconds of a Slack ts nor a digit
// run inside a hex thread id counts), else a 16-hex Gmail thread id, else a Slack channel plus message ts, else the raw id.
const APPLICATION = /(?<![0-9A-Za-z.])\d{10,}(?![0-9A-Za-z.])/;
const THREAD = /(?<![0-9A-Za-z])[0-9A-Fa-f]{16}(?![0-9A-Za-z])/;
const SLACK = /(?<![0-9A-Za-z])(C[0-9A-Z]{8,})(?![0-9A-Za-z]).*?(?<![\d.])(\d+\.\d+)(?![\d.])/;
export function subjectKey(episodeId) {
  const id = String(episodeId ?? '');
  const application = id.match(APPLICATION);
  if (application) return `app:${application[0]}`;
  const thread = id.match(THREAD);
  if (thread) return `thread:${thread[0].toLowerCase()}`;
  const slack = id.match(SLACK);
  if (slack) return `slack:${slack[1]}:${slack[2]}`;
  return id.toLowerCase();
}
const list = x => (Array.isArray(x) ? x : []);
const words = s => { const t = String(s ?? '').trim(); return t ? t.split(/\s+/).length : 0; };
const round = (x, places) => Math.round(x * 10 ** places) / 10 ** places;
const ratio = (s, l) => (Number.isFinite(s) && Number.isFinite(l) && l !== 0 ? round(s / l, 3) : null);
function episodesOf(v) {
  const map = new Map();
  for (const ep of list(v?.report?.episodes)) if (ep?.episode_id && !map.has(ep.episode_id)) map.set(ep.episode_id, ep);
  return map;
}
function actionsOf(v) {
  const map = new Map();
  for (const [id, ep] of episodesOf(v)) for (const a of list(ep.next_actions)) {
    const key = `${id}/${a?.action_key}`;
    if (a?.action_key && !map.has(key)) map.set(key, a);
  }
  return map;
}
// Several episodes can share a subject; its status is their distinct statuses, sorted and joined with '+'.
function subjectsOf(v) {
  const map = new Map();
  for (const [id, ep] of episodesOf(v)) {
    const subject = subjectKey(id);
    const entry = map.get(subject) ?? { statuses: new Set(), actions: 0, words: 0 };
    entry.statuses.add(typeof ep.status === 'string' ? ep.status : 'unknown');
    const keys = new Set();
    for (const a of list(ep.next_actions)) {
      if (!a?.action_key || keys.has(a.action_key)) continue;
      keys.add(a.action_key);
      entry.actions++;
      entry.words += words(a.draft);
    }
    map.set(subject, entry);
  }
  for (const entry of map.values()) entry.status = [...entry.statuses].sort().join('+');
  return map;
}
// Action keys are model-chosen too, so by subject only action counts and draft lengths are compared.
function compareSubjects(shadow, live) {
  const ss = subjectsOf(shadow), ls = subjectsOf(live);
  const acting = (map, subject) => (map.get(subject)?.actions ?? 0) > 0;
  return {
    episodes_by_subject: {
      only_live: [...ls.keys()].filter(k => !ss.has(k)),
      only_shadow: [...ss.keys()].filter(k => !ls.has(k)),
      both: [...ls.keys()].filter(k => ss.has(k)),
      status_diff: [...ls.keys()].filter(k => ss.has(k) && ss.get(k).status !== ls.get(k).status).map(k => ({ subject: k, shadow: ss.get(k).status, live: ls.get(k).status })),
    },
    actions_by_subject: {
      subjects_with_actions_only_live: [...ls.keys()].filter(k => acting(ls, k) && !acting(ss, k)),
      subjects_with_actions_only_shadow: [...ss.keys()].filter(k => acting(ss, k) && !acting(ls, k)),
      subjects_with_actions_both: [...ls.keys()].filter(k => acting(ls, k) && acting(ss, k)).map(k => ({ subject: k, shadow_action_count: ss.get(k).actions, live_action_count: ls.get(k).actions, shadow_draft_words: ss.get(k).words, live_draft_words: ls.get(k).words })),
    },
  };
}
// Ids and counts only: draft text, facts and notes stay in the private verification snapshots.
function compare(shadow, live) {
  if (!shadow || !live) return { episodes: null, actions: null, episodes_by_subject: null, actions_by_subject: null };
  const se = episodesOf(shadow), le = episodesOf(live);
  const sa = actionsOf(shadow), la = actionsOf(live);
  return {
    episodes: {
      only_live: [...le.keys()].filter(id => !se.has(id)),
      only_shadow: [...se.keys()].filter(id => !le.has(id)),
      both: [...le.keys()].filter(id => se.has(id)),
      status_diff: [...le.keys()].filter(id => se.has(id) && se.get(id).status !== le.get(id).status).map(id => ({ episode_id: id, shadow: se.get(id).status ?? null, live: le.get(id).status ?? null })),
    },
    actions: {
      only_live: [...la.keys()].filter(k => !sa.has(k)),
      only_shadow: [...sa.keys()].filter(k => !la.has(k)),
      shared: [...la.keys()].filter(k => sa.has(k)).map(k => ({ key: k, draft_differs: String(sa.get(k).draft ?? '').trim() !== String(la.get(k).draft ?? '').trim(), shadow_words: words(sa.get(k).draft), live_words: words(la.get(k).draft) })),
    },
    ...compareSubjects(shadow, live),
  };
}
const unknownsOf = v => (v ? { report: list(v.report?.unknowns).length, episodes: [...episodesOf(v).values()].reduce((n, ep) => n + list(ep.unknowns).length, 0) } : null);
const coverageOf = v => (v ? Object.fromEntries(SERVICES.map(s => [s, v.report?.coverage?.[s]?.complete === true])) : null);

export function pair({ shadowDir, liveDir, out, windowMinutes = DEFAULT_WINDOW_MINUTES, shadowModel = null, runError = null, shadowRunId = null } = {}) {
  if (!shadowDir || !liveDir) throw new Error('--shadow-dir and --live-dir are required.');
  out ??= path.join(shadowDir, 'shadow');
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error('--window-minutes must be a positive number.');
  checkDirs(shadowDir, liveDir, out);
  const shadowIds = runIds(shadowDir);
  const id = shadowRunId ?? shadowIds.at(-1);
  if (!id || !shadowIds.includes(id)) throw new Error(`No shadow run to pair under ${path.join(shadowDir, 'runs')}.`);
  const shadowStart = startOf(id);
  const pairDir = path.join(out, 'pairs', id);
  // pilot.mjs prunes runs/ to 10: a live run already snapshotted for this pair stays a candidate after it is pruned.
  const prior = read(path.join(pairDir, 'meta.json'));
  const live = new Map(runIds(liveDir).map(liveId => [liveId, () => loadRun(liveDir, liveId)]));
  if (prior?.live?.run_id && !live.has(prior.live.run_id)) {
    const snapshot = read(path.join(pairDir, 'live-verification.json'));
    live.set(prior.live.run_id, () => ({ id: prior.live.run_id, verification: snapshot, result: prior.live.result ?? null }));
  }
  const liveId = nearest([...live.keys()], shadowStart, windowMinutes);
  const liveRun = liveId ? live.get(liveId)() : null;
  const shadowRun = loadRun(shadowDir, id);
  const sv = shadowRun.verification, lv = liveRun?.verification ?? null;
  const shadowOk = sv?.ok === true;
  const state = read(path.join(shadowDir, 'state.json'), {});
  const stateMatches = typeof state?.started_at === 'string' && state.started_at.replaceAll(':', '-') === id && !state.running;
  const reason = shadowOk ? null
    : (stateMatches && state.last_error) || runError || (list(sv?.errors).length ? sv.errors.join(' ') : null) || prior?.shadow?.failed_reason || 'No verification was written.';
  const configured = shadowModel ?? prior?.shadow?.model_configured ?? null;
  const shadowCoverage = coverageOf(sv), liveCoverage = liveRun ? coverageOf(lv) : null;
  const { episodes, actions, episodes_by_subject, actions_by_subject } = compare(sv, lv);
  const sr = shadowRun.result, lr = liveRun?.result ?? null;
  const score = {
    shadow_run_id: id,
    live_run_id: liveRun?.id ?? null,
    gap_minutes: liveRun ? round((shadowStart - startOf(liveRun.id)) / MINUTE, 1) : null,
    window_minutes: windowMinutes,
    models: { shadow: sr?.model ?? configured, live: lr?.model ?? null },
    shadow_ok: shadowOk,
    shadow_failed_reason: reason,
    live_ok: liveRun ? lv?.ok === true : null,
    coverage: Object.fromEntries(SERVICES.map(s => [s, { shadow: shadowCoverage?.[s] ?? null, live: liveCoverage?.[s] ?? null }])),
    coverage_complete_all: { shadow: shadowCoverage ? SERVICES.every(s => shadowCoverage[s]) : null, live: liveCoverage ? SERVICES.every(s => liveCoverage[s]) : null },
    episodes,
    actions,
    episodes_by_subject,
    actions_by_subject,
    unknowns: { shadow: unknownsOf(sv), live: unknownsOf(lv) },
    cost_usd: { shadow: sr?.total_cost_usd ?? null, live: lr?.total_cost_usd ?? null, ratio: ratio(sr?.total_cost_usd, lr?.total_cost_usd) },
    duration_ms: { shadow: sr?.duration_ms ?? null, live: lr?.duration_ms ?? null, ratio: ratio(sr?.duration_ms, lr?.duration_ms) },
    num_turns: { shadow: sr?.num_turns ?? null, live: lr?.num_turns ?? null, ratio: ratio(sr?.num_turns, lr?.num_turns) },
    scored_at: new Date().toISOString(),
  };
  const meta = {
    shadow_run_id: id,
    window_minutes: windowMinutes,
    shadow: { run_id: id, started_at: new Date(shadowStart).toISOString(), model_configured: configured, result: sr, verification: Boolean(sv), failed_reason: reason },
    live: liveRun ? { run_id: liveRun.id, started_at: new Date(startOf(liveRun.id)).toISOString(), result: lr, verification: Boolean(lv) } : null,
    paired_at: score.scored_at,
  };
  privateDir(out);
  privateDir(path.join(out, 'pairs'));
  privateDir(pairDir);
  for (const [file, value] of [['shadow-verification.json', sv], ['live-verification.json', lv]]) {
    if (value) atomic(path.join(pairDir, file), value);
    else fs.rmSync(path.join(pairDir, file), { force: true });
  }
  atomic(path.join(pairDir, 'meta.json'), meta);
  atomic(path.join(pairDir, 'score.json'), score);
  const ledger = path.join(out, 'pairs.jsonl');
  let lines = [];
  try { lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line)); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`pairs.jsonl is unreadable: ${e.message}`); }
  lines = [...lines.filter(x => x.shadow_run_id !== id), score].sort((a, b) => a.shadow_run_id.localeCompare(b.shadow_run_id));
  atomic(ledger, lines.map(x => JSON.stringify(x)).join('\n') + '\n');
  atomic(path.join(out, 'SHADOW.md'), summary(lines));
  return score;
}

function pacific(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
const DASH = '–';
const yesNo = v => (v === true ? 'yes' : v === false ? 'no' : DASH);
const dollars = v => (Number.isFinite(v) ? `$${v.toFixed(2)}` : DASH);
const minutes = v => (Number.isFinite(v) ? (v / MINUTE).toFixed(1) : DASH);
const fixed1 = v => (Number.isFinite(v) ? v.toFixed(1) : DASH);
const mean = xs => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const sum = xs => xs.reduce((a, b) => a + b, 0);
const rate = (n, d) => (d ? `${n} of ${d} (${Math.round((100 * n) / d)}%)` : 'none');
const triple = (o, keys) => (o ? keys.map(k => (Array.isArray(o[k]) ? o[k].length : o[k])).join(' / ') : DASH);
const actionTriple = a => (a ? [a.only_live.length, a.only_shadow.length, a.shared.filter(x => x.draft_differs).length] : null);
// Counts and opaque run ids only; Sam reads this file.
function summary(scores) {
  const names = xs => [...new Set(xs.filter(Boolean))].join(', ') || 'unknown';
  const live = scores.filter(s => s.live_run_id);
  const episodeTotals = ['only_live', 'only_shadow', 'status_diff'].map(k => sum(scores.map(s => s.episodes?.[k]?.length ?? 0)));
  const subjectTotals = ['only_live', 'only_shadow', 'status_diff'].map(k => sum(scores.map(s => s.episodes_by_subject?.[k]?.length ?? 0)));
  const actionTotals = [0, 1, 2].map(i => sum(scores.map(s => actionTriple(s.actions)?.[i] ?? 0)));
  const lines = [
    `# Shadow model test: ${names(scores.map(s => s.models?.shadow))} against ${names(live.map(s => s.models?.live))}`,
    '',
    `Updated ${pacific(Date.now())} Pacific. Each row pairs one shadow run with the live run that started nearest before it, within the pair window (${DEFAULT_WINDOW_MINUTES} minutes unless set), falling back to the nearest live run after it. Gap is minutes from the live start to the shadow start, negative when the live run started later. Episode and action comparisons count only pairs where both runs wrote a verification. Subject counts group episodes by what they track (a Greenhouse application, a Gmail thread or a Slack message), because the two models name the same episode differently. Per-pair detail is in pairs/<shadow run>/score.json; this file holds counts only, never draft text or candidate details.`,
    '',
    `- Pairs: ${scores.length}, of which ${live.length} matched a live run`,
    `- Shadow failures: ${scores.filter(s => !s.shadow_ok).length}`,
    `- All four sources complete: shadow ${rate(scores.filter(s => s.coverage_complete_all?.shadow === true).length, scores.length)}, live ${rate(live.filter(s => s.coverage_complete_all?.live === true).length, live.length)}`,
    `- Mean cost per run: shadow ${dollars(mean(scores.map(s => s.cost_usd?.shadow)))}, live ${dollars(mean(live.map(s => s.cost_usd?.live)))}`,
    `- Mean minutes per run: shadow ${minutes(mean(scores.map(s => s.duration_ms?.shadow)))}, live ${minutes(mean(live.map(s => s.duration_ms?.live)))}`,
    `- Mean turns per run: shadow ${fixed1(mean(scores.map(s => s.num_turns?.shadow)))}, live ${fixed1(mean(live.map(s => s.num_turns?.live)))}`,
    `- Episode mismatches: ${sum(episodeTotals)} (only in live ${episodeTotals[0]}, only in shadow ${episodeTotals[1]}, status differs ${episodeTotals[2]})`,
    `- Subject mismatches: ${sum(subjectTotals)} (only in live ${subjectTotals[0]}, only in shadow ${subjectTotals[1]}, status differs ${subjectTotals[2]})`,
    `- Action mismatches: ${sum(actionTotals)} (only in live ${actionTotals[0]}, only in shadow ${actionTotals[1]}, drafts differ ${actionTotals[2]})`,
    '',
    '| Shadow start (Pacific) | Gap (min) | OK S/L | All sources S/L | Episodes only L / only S / status | Subjects only L / only S / status | Actions only L / only S / drafts differ | Cost S/L | Minutes S/L |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const s of [...scores].sort((a, b) => b.shadow_run_id.localeCompare(a.shadow_run_id))) {
    lines.push(`| ${[
      pacific(startOf(s.shadow_run_id)),
      s.live_run_id ? String(s.gap_minutes) : 'no live run',
      `${yesNo(s.shadow_ok)}/${yesNo(s.live_ok)}`,
      `${yesNo(s.coverage_complete_all?.shadow)}/${yesNo(s.coverage_complete_all?.live)}`,
      triple(s.episodes, ['only_live', 'only_shadow', 'status_diff']),
      triple(s.episodes_by_subject, ['only_live', 'only_shadow', 'status_diff']),
      actionTriple(s.actions)?.join(' / ') ?? DASH,
      `${dollars(s.cost_usd?.shadow)}/${dollars(s.cost_usd?.live)}`,
      `${minutes(s.duration_ms?.shadow)}/${minutes(s.duration_ms?.live)}`,
    ].join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}

export async function cycle({ model, shadowDir, liveDir, claude, out, windowMinutes = DEFAULT_WINDOW_MINUTES, claudeProjectsDir } = {}) {
  if (!model) throw new Error('cycle needs --model.');
  if (!claude) throw new Error('cycle needs --claude.');
  if (!shadowDir || !liveDir) throw new Error('--shadow-dir and --live-dir are required.');
  out ??= path.join(shadowDir, 'shadow');
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) throw new Error('--window-minutes must be a positive number.');
  checkDirs(shadowDir, liveDir, out);
  const before = new Set(runIds(shadowDir));
  // pilot.mjs reads PILOT_MODEL once, at module load, so it must be set before the first import in this process.
  process.env.PILOT_MODEL = model;
  const pilot = await import('./pilot.mjs');
  if (pilot.MODEL !== model) throw new Error(`pilot.mjs was already loaded with model ${pilot.MODEL}; run cycle in a fresh process.`);
  let runError = null;
  try { await pilot.run({ dataDir: shadowDir, claude, ...(claudeProjectsDir ? { claudeProjectsDir } : {}) }); }
  catch (e) { runError = e.message; }
  const fresh = runIds(shadowDir).filter(id => !before.has(id)).at(-1);
  if (!fresh) throw new Error(`The shadow run left no run record to score${runError ? `: ${runError}` : '.'}`);
  const score = pair({ shadowDir, liveDir, out, windowMinutes, shadowModel: model, runError, shadowRunId: fresh });
  return { shadow_run_id: fresh, run_error: runError, shadow_ok: score.shadow_ok, live_run_id: score.live_run_id, score_file: path.join(out, 'pairs', fresh, 'score.json'), summary_file: path.join(out, 'SHADOW.md') };
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = () => { const v = args[++i]; if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value.`); return v; };
    if (flag === '--model') options.model = value();
    else if (flag === '--shadow-dir') options.shadowDir = path.resolve(value());
    else if (flag === '--live-dir') options.liveDir = path.resolve(value());
    else if (flag === '--claude') options.claude = path.resolve(value());
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--window-minutes') options.windowMinutes = Number(value());
    else throw new Error(`Unknown argument ${flag}. ${USAGE}`);
  }
  if (command === 'cycle') return cycle(options);
  if (command === 'pair') {
    const out = options.out ?? (options.shadowDir && path.join(options.shadowDir, 'shadow'));
    const score = pair(options);
    return { shadow_run_id: score.shadow_run_id, live_run_id: score.live_run_id, shadow_ok: score.shadow_ok, score_file: path.join(out, 'pairs', score.shadow_run_id, 'score.json'), summary_file: path.join(out, 'SHADOW.md') };
  }
  throw new Error(USAGE);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
