/**
 * The pre-dispatch guard (WORKFLOW.md, "Rules every template obeys"). Plain code, no model: it reads the
 * exact text that would leave and refuses it on any rule. Every failing rule is reported, so a person
 * fixing the input sees the whole list at once.
 */

export type GuardChannel = 'gmail-reply' | 'calendar-description' | 'slack';

export interface OutgoingMessage {
  to: string[];
  subject: string;
  body: string;
  channel: GuardChannel;
}

export interface GuardFacts {
  allowedRecipients: string[];
  /** Times exactly as rendered from calendar-confirmed instants, e.g. "Friday, October 9 at 4:30 pm Eastern Time". */
  confirmedTimeStrings: string[];
  otherCandidateNames: string[];
  maxWords: number;
}

export type GuardResult = { ok: true } | { ok: false; reasons: string[] };

export const GUARD_RULES = ['recipients', 'no-zoom', 'links', 'confirmed-times', 'other-candidates', 'placeholders', 'word-cap'] as const;
export type GuardRule = (typeof GUARD_RULES)[number];

export interface GuardCheck {
  rule: GuardRule;
  ok: boolean;
  reasons: string[];
}

const ALLOWED_EXACT_HOSTS = new Set(['meet.google.com', 'app4.greenhouse.io', 'turing.com']);

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return ALLOWED_EXACT_HOSTS.has(h) || h.endsWith('.turing.com');
}

/** Anything that looks like a link: a scheme URL, or a bare `www.` host. Trailing sentence punctuation is not part of it. */
const URL_LIKE = /\b(?:https?:\/\/|www\.)[^\s<>"'\]]+/gi;

/**
 * Clock times. The brief's `\d{1,2}:\d{2}\s?(am|pm)` plus the hour-only and dotted forms ("5 pm",
 * "5 p.m."), because "Every time in an outgoing message must equal a time the calendar confirmed".
 */
const CLOCK_TIME = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/gi;

/** `[Job Title]`, `[CANDIDATE NAME]`, `[first_name]`: a template-tool placeholder somebody forgot. */
const BRACKET_PLACEHOLDER = /\[[A-Za-z][A-Za-z0-9 _-]*\]/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** The spans of `text` covered by any occurrence of any confirmed string. */
function confirmedSpans(text: string, confirmed: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const c of confirmed) {
    if (c.trim() === '') continue;
    let from = 0;
    for (;;) {
      const i = text.indexOf(c, from);
      if (i < 0) break;
      spans.push([i, i + c.length]);
      from = i + 1;
    }
  }
  return spans;
}

function checkRecipients(msg: OutgoingMessage, facts: GuardFacts): string[] {
  const allowed = new Set(facts.allowedRecipients.map((e) => e.trim().toLowerCase()));
  return msg.to.filter((t) => !allowed.has(t.trim().toLowerCase())).map((t) => `recipient ${t} is not allowed for this message`);
}

function checkZoom(texts: string[]): string[] {
  return texts.some((t) => /\bzoom\b/i.test(t)) ? ['the word "Zoom" appears; the meeting is always Google Meet'] : [];
}

function checkLinks(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    for (const m of t.matchAll(URL_LIKE)) {
      const raw = m[0].replace(/[.,;:!?)]+$/, '');
      let host: string | null = null;
      try {
        host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname;
      } catch {
        host = null;
      }
      if (host === null || !hostAllowed(host)) out.push(`link ${raw} points outside Google Meet, app4.greenhouse.io and turing.com`);
    }
  }
  return out;
}

function checkTimes(texts: string[], facts: GuardFacts): string[] {
  const out: string[] = [];
  for (const t of texts) {
    const spans = confirmedSpans(t, facts.confirmedTimeStrings);
    for (const m of t.matchAll(CLOCK_TIME)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!spans.some(([s, e]) => s <= start && end <= e)) {
        out.push(`time "${m[0]}" is not part of a calendar-confirmed time for this interview`);
      }
    }
  }
  return out;
}

function checkOtherCandidates(texts: string[], facts: GuardFacts): string[] {
  const out: string[] = [];
  for (const name of facts.otherCandidateNames) {
    if (name.trim() === '') continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(name.trim())}(?![\\p{L}\\p{N}])`, 'iu');
    if (texts.some((t) => re.test(t))) out.push(`other candidate ${name} is named`);
  }
  return out;
}

function checkPlaceholders(texts: string[]): string[] {
  const out: string[] = [];
  for (const t of texts) {
    if (t.includes('{{')) out.push('unresolved placeholder "{{" remains');
    for (const m of t.matchAll(BRACKET_PLACEHOLDER)) out.push(`unresolved placeholder ${m[0]} remains`);
  }
  return out;
}

function checkWords(msg: OutgoingMessage, facts: GuardFacts): string[] {
  const n = countWords(msg.body);
  return n > facts.maxWords ? [`body is ${n} words; the cap is ${facts.maxWords}`] : [];
}

/** Every rule, each with its own result. `checkOutgoing` is the pass/fail view of this. */
export function runChecks(msg: OutgoingMessage, facts: GuardFacts): GuardCheck[] {
  const texts = [msg.subject, msg.body];
  const results: Record<GuardRule, string[]> = {
    recipients: checkRecipients(msg, facts),
    'no-zoom': checkZoom(texts),
    links: checkLinks(texts),
    'confirmed-times': checkTimes(texts, facts),
    'other-candidates': checkOtherCandidates(texts, facts),
    placeholders: checkPlaceholders(texts),
    'word-cap': checkWords(msg, facts),
  };
  return GUARD_RULES.map((rule) => ({ rule, ok: results[rule].length === 0, reasons: results[rule] }));
}

export function checkOutgoing(msg: OutgoingMessage, facts: GuardFacts): GuardResult {
  const reasons = runChecks(msg, facts).flatMap((c) => c.reasons);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
