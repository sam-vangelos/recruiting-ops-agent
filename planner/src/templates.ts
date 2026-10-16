/**
 * Loads and renders the message templates in `../templates/` under the contract in `templates/README.md`.
 * The front matter parser is purpose-built: each key is a scalar (`key: value`, optionally double-quoted)
 * or a list of `  - item` lines. Anything else is refused, so a malformed template fails loudly at load.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `agents/scheduling/templates`. */
export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/** The README's field table, in its order. The renderer accepts no other names. */
export const FIELD_VOCABULARY: readonly string[] = [
  'CANDIDATE_FIRST_NAME',
  'CANDIDATE_NAME',
  'CANDIDATE_LOCATION',
  'JOB_NAME',
  'INTERVIEWER_NAME',
  'INTERVIEWER_FIRST_NAME',
  'INTERVIEWER_TITLE',
  'INTERVIEW_TIME_CANDIDATE',
  'INTERVIEW_TIME_INTERVIEWER',
  'INTERVIEW_WINDOW_INTERVIEWER',
  'INTERVIEW_DURATION_MIN',
  'MEET_LINK',
  'INTERVIEW_KIT_LINK',
  'ALTERNATIVE_SLOTS',
  'CANDIDATE_SUMMARY',
  'RULING_LINE',
  'RECRUITER_ADDITIONS',
  'RECRUITER_FIRST_NAME',
  'RECRUITER_FULL_NAME',
  'RECRUITER_TITLE',
  'DISCLOSURE_LINE',
  'NEW_INTERVIEW_TIME_CANDIDATE',
  'OLD_INTERVIEW_TIME_CANDIDATE',
  'DAYS_SILENT',
];

export type TemplateChannel = 'gmail-reply' | 'calendar-description';
export type TemplateAudience = 'candidate' | 'interviewer';

export interface Template {
  id: string;
  channel: TemplateChannel;
  audience: TemplateAudience;
  derivedFrom: string;
  fields: string[];
  optionalFields: string[];
  maxWords: number;
  /** Calendar channel only: the event title, with merge fields. */
  summary?: string;
  /** Text after the closing `---`, without the file's final newline. */
  body: string;
}

/**
 * `summary` is the rendered event title (calendar channel). `subject` is never set by a template: a
 * gmail-reply goes out as `Re: <thread subject>`, which `mail.ts` builds from the thread.
 */
export interface Rendered {
  subject?: string;
  summary?: string;
  body: string;
}

export type Fields = Record<string, string | undefined>;

const SCALAR_KEYS = new Set(['id', 'channel', 'audience', 'derived_from', 'max_words', 'summary']);
const LIST_KEYS = new Set(['fields', 'optional_fields']);
const PLACEHOLDER = /\{\{([A-Z0-9_]+)\}\}/g;

const placeholdersIn = (s: string): string[] => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]!);

function unquote(v: string, where: string): string {
  if (!v.startsWith('"')) return v;
  if (!v.endsWith('"') || v.length < 2) throw new Error(`${where}: unterminated quoted value`);
  return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

function parseFrontMatter(lines: string[], id: string): Map<string, string | string[]> {
  const out = new Map<string, string | string[]>();
  let listKey: string | null = null;
  lines.forEach((line, i) => {
    const where = `template ${id} front matter line ${i + 2}`;
    if (line.trim() === '') return;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item) {
      if (listKey === null) throw new Error(`${where}: a "- item" line with no list key above it`);
      (out.get(listKey) as string[]).push(unquote(item[1]!.trim(), where));
      return;
    }
    const kv = /^([a-z_]+):(?:\s+(.*))?$/.exec(line);
    if (!kv) throw new Error(`${where}: expected "key: value" or "  - item", got ${JSON.stringify(line)}`);
    const key = kv[1]!;
    const value = (kv[2] ?? '').trim();
    if (out.has(key)) throw new Error(`${where}: duplicate key ${key}`);
    if (LIST_KEYS.has(key)) {
      if (value !== '') throw new Error(`${where}: ${key} must be a list of "- item" lines`);
      out.set(key, []);
      listKey = key;
      return;
    }
    if (!SCALAR_KEYS.has(key)) throw new Error(`${where}: unknown front matter key ${key}`);
    if (value === '') throw new Error(`${where}: ${key} needs a value on the same line`);
    out.set(key, unquote(value, where));
    listKey = null;
  });
  return out;
}

/** Parses one template's text and checks it against the contract. `id` is the file name without `.md`. */
export function parseTemplate(text: string, id: string): Template {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') throw new Error(`template ${id}: no front matter (the first line must be "---")`);
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error(`template ${id}: front matter is never closed with "---"`);
  const fm = parseFrontMatter(lines.slice(1, close), id);
  let body = lines.slice(close + 1).join('\n');
  if (body.endsWith('\n')) body = body.slice(0, -1);

  const scalar = (k: string): string | undefined => {
    const v = fm.get(k);
    if (Array.isArray(v)) throw new Error(`template ${id}: ${k} must be a scalar`);
    return v;
  };
  const list = (k: string): string[] => {
    const v = fm.get(k);
    if (v !== undefined && !Array.isArray(v)) throw new Error(`template ${id}: ${k} must be a list`);
    return v ?? [];
  };
  const need = (k: string): string => {
    const v = scalar(k);
    if (v === undefined) throw new Error(`template ${id}: front matter key ${k} is required`);
    return v;
  };

  if (need('id') !== id) throw new Error(`template ${id}: front matter id ${JSON.stringify(scalar('id'))} does not match the file name`);
  const channel = need('channel');
  if (channel !== 'gmail-reply' && channel !== 'calendar-description') throw new Error(`template ${id}: unknown channel ${channel}`);
  const audience = need('audience');
  if (audience !== 'candidate' && audience !== 'interviewer') throw new Error(`template ${id}: unknown audience ${audience}`);
  const maxWordsText = need('max_words');
  if (!/^[1-9]\d*$/.test(maxWordsText)) throw new Error(`template ${id}: max_words must be a positive integer, got ${maxWordsText}`);
  const summary = scalar('summary');
  if ((summary !== undefined) !== (channel === 'calendar-description')) {
    throw new Error(`template ${id}: summary is required on calendar-description templates and refused elsewhere`);
  }
  const fields = list('fields');
  const optionalFields = list('optional_fields');
  if (fields.length === 0) throw new Error(`template ${id}: fields must name at least one field`);

  const declared = [...fields, ...optionalFields];
  const seen = new Set<string>();
  for (const f of declared) {
    if (!FIELD_VOCABULARY.includes(f)) throw new Error(`template ${id}: field ${f} is not in the README vocabulary`);
    if (seen.has(f)) throw new Error(`template ${id}: field ${f} is declared twice`);
    seen.add(f);
  }
  const used = new Set(placeholdersIn(`${summary ?? ''}\n${body}`));
  for (const p of used) if (!seen.has(p)) throw new Error(`template ${id}: {{${p}}} is used but not declared`);
  for (const f of declared) if (!used.has(f)) throw new Error(`template ${id}: field ${f} is declared but never used`);

  const tpl: Template = {
    id,
    channel,
    audience,
    derivedFrom: need('derived_from'),
    fields,
    optionalFields,
    maxWords: Number(maxWordsText),
    body,
  };
  if (summary !== undefined) tpl.summary = summary;
  return tpl;
}

/** Template ids in `dir`, sorted; README.md is the contract, not a template. */
export function listTemplateIds(dir: string = TEMPLATES_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => f.slice(0, -3))
    .sort();
}

export function loadTemplate(id: string, dir: string = TEMPLATES_DIR): Template {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`template id ${JSON.stringify(id)} is not a template file name`);
  return parseTemplate(readFileSync(join(dir, `${id}.md`), 'utf8'), id);
}

function substitute(text: string, values: Map<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => values.get(name) ?? '');
}

/**
 * Renders under the README's rules: every `fields` entry present and non-empty; `optional_fields` may be
 * absent or empty, and a line whose only content was an empty optional field is dropped with one blank
 * line after it; an undeclared placeholder, a supplied key outside the vocabulary, or any `{{` left
 * afterwards is an error. Trailing whitespace is trimmed from every line.
 */
export function renderTemplate(tpl: Template, fields: Fields): Rendered {
  const unknown = Object.keys(fields).filter((k) => !FIELD_VOCABULARY.includes(k));
  if (unknown.length > 0) throw new Error(`template ${tpl.id}: ${unknown.join(', ')} not in the README vocabulary`);

  const declared = new Set([...tpl.fields, ...tpl.optionalFields]);
  const undeclared = [...new Set(placeholdersIn(`${tpl.summary ?? ''}\n${tpl.body}`))].filter((p) => !declared.has(p));
  if (undeclared.length > 0) throw new Error(`template ${tpl.id}: undeclared placeholder(s) ${undeclared.map((p) => `{{${p}}}`).join(', ')}`);

  const missing = tpl.fields.filter((f) => (fields[f] ?? '').trim() === '');
  if (missing.length > 0) throw new Error(`template ${tpl.id}: required field(s) missing or empty: ${missing.join(', ')}`);

  const values = new Map<string, string>();
  for (const f of declared) values.set(f, (fields[f] ?? '').trim() === '' ? '' : fields[f]!);
  const optional = new Set(tpl.optionalFields);
  const isEmptyOptional = (p: string) => optional.has(p) && values.get(p) === '';

  const lines = tpl.body.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ps = placeholdersIn(line);
    const onlyEmptyOptionals = ps.length > 0 && ps.every(isEmptyOptional) && line.replace(PLACEHOLDER, '').trim() === '';
    if (onlyEmptyOptionals) {
      if (lines[i + 1] !== undefined && lines[i + 1]!.trim() === '') i++;
      continue;
    }
    out.push(...substitute(line, values).split('\n').map((l) => l.trimEnd()));
  }
  const body = out.join('\n');
  const rendered: Rendered = { body };
  if (tpl.summary !== undefined) rendered.summary = substitute(tpl.summary, values).trim();

  for (const [what, text] of [['body', body], ['summary', rendered.summary ?? '']] as const) {
    if (text.includes('{{')) throw new Error(`template ${tpl.id}: "{{" remains in the rendered ${what}`);
  }
  return rendered;
}
