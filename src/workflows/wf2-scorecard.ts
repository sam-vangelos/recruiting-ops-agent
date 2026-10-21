import { appendLedger, sha256 } from '../../worker/ledger.mjs';
import {
  type ApprovalRow,
  type ChainStepRow,
  type EpisodeRow,
  SqliteCoordinatorStore,
  type TimerRow,
} from '../store/sqlite.ts';
import {
  type ChainStepContext,
  type ChainStepDefinition,
  DeterministicExecutor,
  type ExecuteChainResult,
  type ExpectedFreshState,
  type FreshReadSnapshot,
  SAM_GREENHOUSE_USER_ID,
  verifyFreshState,
} from '../executor/index.ts';
import { addWorkingHours } from '../utils/timezone.ts';
import { evaluateWorkflow4Scorecards } from './wf4-rejection.ts';

export const PILOT_JOB_ID = 5149015004;
export const RECRUITER_PHONE_SCREEN_STAGE_ID = 12579937004;
export const RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID = 14297388004;
export const RECRUITER_PHONE_SCREEN_KIT_ID = 14297348004;
export const HIRING_MANAGER_REVIEW_STAGE_ID = 12579938004;
export const FIELD_ENGINEERING_HIRING_CHANNEL_ID = 'C0C9VEPBAJC';
export const SAM_SLACK_USER_ID = 'U07RJJ6RLN6';

export const MISSING_NOTES_PROMPT_DELAY_MS = 95 * 60_000; // ends_at + 95m
export const MANUAL_NOTES_EXPIRY_WORKING_HOURS = 5 * 24; // 5 business days (120 weekday hours)

export type ScorecardRecommendation =
  | 'strong_yes'
  | 'yes'
  | 'no'
  | 'strong_no'
  | 'definitely_not';

export const ALLOWED_RECOMMENDATIONS: readonly ScorecardRecommendation[] = [
  'strong_yes',
  'yes',
  'no',
  'strong_no',
  'definitely_not',
];

export const POSITIVE_RECOMMENDATIONS = new Set<ScorecardRecommendation>([
  'strong_yes',
  'yes',
]);

export const NEGATIVE_RECOMMENDATIONS = new Set<ScorecardRecommendation>([
  'no',
  'strong_no',
  'definitely_not',
]);

const NEGATION_TOKENS = new Set([
  'not',
  'no',
  'never',
  'dont',
  "don't",
  'doesnt',
  "doesn't",
  'didnt',
  "didn't",
  'isnt',
  "isn't",
  'wasnt',
  "wasn't",
  'arent',
  "aren't",
  'werent',
  "weren't",
  'cannot',
  'cant',
  "can't",
  'wont',
  "won't",
  'wouldnt',
  "wouldn't",
  'shouldnt',
  "shouldn't",
  'hardly',
  'barely',
]);

const NON_RATING_NO_FOLLOW_WORDS = new Set([
  'concerns',
  'concern',
  'issues',
  'issue',
  'doubt',
  'doubts',
  'problem',
  'problems',
  'blockers',
  'blocker',
  'hesitation',
  'red',
  'flags',
  'flag',
  'questions',
  'question',
]);

const INTERVIEWER_SPEAKER_NAMES = new Set([
  'sam vangelos',
  'sam',
  'me',
  'interviewer',
]);

export interface QuoteSupportSpan {
  source_id?: string;
  quote: string;
}

export interface GroundedStatementInput {
  text?: string;
  statement?: string;
  quote?: string;
  verbatim_quote?: string;
  support?: QuoteSupportSpan[];
  evidence?: {
    quote?: string;
    source?: string;
  };
}

export interface DraftAttributeInput {
  id?: number;
  job_candidate_attribute_id?: number;
  name?: string;
  value?: ScorecardRecommendation | string | null;
  rating?: ScorecardRecommendation | string | null;
  note?: string | null;
  sam_quote?: string;
  support?: QuoteSupportSpan[];
  sentences?: GroundedStatementInput[];
}

export interface DraftQuestionInput {
  id?: number;
  scorecard_question_id?: number;
  label?: string;
  text?: string | null;
  answer?: string | null;
  value?: string | null;
  boolean_value?: boolean | null;
  option_ids?: number[];
  quote?: string;
  support?: QuoteSupportSpan[];
  statements?: GroundedStatementInput[];
}

export interface DraftSourceDocument {
  id: string;
  kind: 'transcript' | 'sam_notes' | 'slack_instruction';
  text: string;
}

export interface SystemsAdminScorecardDraft {
  key_takeaways?: Array<string | GroundedStatementInput> | string;
  key_takeaway_statements?: GroundedStatementInput[];
  overall_recommendation?: ScorecardRecommendation | string | null;
  candidate_rating?: ScorecardRecommendation | string | null;
  sam_assessment?: string | null;
  attributes?: DraftAttributeInput[];
  questions?: DraftQuestionInput[];
  sources?: DraftSourceDocument[];
  transcript?: string;
  sam_notes?: string;
  slack_instruction?: string;
}

export interface ScorecardSubmitMappedInput {
  application_id: number;
  job_interview_id: number;
  interview_kit_id: number;
  interviewer_id: number;
  notes: string;
  private_notes: string;
  candidate_rating: ScorecardRecommendation;
  overall_recommendation: ScorecardRecommendation;
  attribute_ratings: Array<{
    job_candidate_attribute_id: number;
    candidate_attribute_rating: ScorecardRecommendation;
    rating: ScorecardRecommendation;
    note?: string | null;
  }>;
  question_answers: Array<{
    scorecard_question_id: number;
    answer?: string | null;
    boolean_value?: boolean | null;
    option_ids?: number[];
  }>;
}

export interface DraftValidationResult {
  ok: boolean;
  errors: string[];
  omitted_attribute_ids: number[];
}

export interface Workflow2EpisodeState {
  application_id: number;
  candidate_id?: number | null;
  candidate_name: string;
  candidate_tz?: string | null;
  job_id: number;
  job_name?: string;
  from_stage_id: number;
  to_stage_id: number;
  job_interview_id: number;
  interview_kit_id: number;
  interview_ended_at: string;
  decision_branch: 'advance' | 'reject';
  overall_recommendation: ScorecardRecommendation;
  scorecard_input: ScorecardSubmitMappedInput;
  slack_channel_id: string;
  slack_presentation_text?: string;
  chain_id: string;
  scorecard_submitted?: boolean;
  scorecard_id?: number | null;
  coupled_step_completed?: boolean;
  rejection_episode_id?: string | null;
  rejection_timer_key?: string | null;
  missing_notes_prompted_at?: string | null;
  closed_manual_reason?: string | null;
}

function normalizeForMatch(input: string): string {
  return input
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .toLowerCase();
}

function tokenizeWords(input: string): string[] {
  const norm = normalizeForMatch(input).replace(/[^a-z0-9']+/g, ' ').trim();
  if (!norm) return [];
  return norm.split(/\s+/).map(t => t.replace(/^'+|'+$/g, '')).filter(Boolean);
}

export function wordCount(input: string): number {
  return tokenizeWords(input).length;
}

export function containsVerbatimQuote(corpus: string, quote: string): boolean {
  const quoteTokens = tokenizeWords(quote);
  if (quoteTokens.length === 0) return false;
  const corpusTokens = tokenizeWords(corpus);
  if (corpusTokens.length < quoteTokens.length) return false;

  for (let i = 0; i <= corpusTokens.length - quoteTokens.length; i++) {
    let matches = true;
    for (let j = 0; j < quoteTokens.length; j++) {
      if (corpusTokens[i + j] !== quoteTokens[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function extractNumbers(input: string): string[] {
  const cleaned = input.replace(/(\d),(\d)/g, '$1$2');
  return cleaned.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
}

function hasUnnegatedAssessmentPhrase(samCorpus: string, phrase: string): boolean {
  const targetTokens = tokenizeWords(phrase);
  if (targetTokens.length === 0) return false;

  const sentences = normalizeForMatch(samCorpus)
    .split(/[.!?\n;]+/)
    .map(s => s.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    const tokens = tokenizeWords(sentence);
    for (let i = 0; i <= tokens.length - targetTokens.length; i++) {
      let match = true;
      for (let j = 0; j < targetTokens.length; j++) {
        if (tokens[i + j] !== targetTokens[j]) {
          match = false;
          break;
        }
      }
      if (!match) continue;

      // For single-word 'yes', ensure it's not part of 'strong yes' when looking specifically for 'yes'
      if (phrase === 'yes' && i > 0 && tokens[i - 1] === 'strong') {
        continue;
      }
      // For single-word 'no', ensure it's not part of 'strong no' or benign phrases like 'no concerns'
      if (phrase === 'no') {
        if (i > 0 && tokens[i - 1] === 'strong') {
          continue;
        }
        const nextTok = tokens[i + 1]?.replace(/'/g, '');
        if (nextTok && NON_RATING_NO_FOLLOW_WORDS.has(nextTok)) {
          continue;
        }
      }

      const lookbackStart = Math.max(0, i - 8);
      let negated = false;
      for (let k = lookbackStart; k < i; k++) {
        const tok = tokens[k];
        if (NEGATION_TOKENS.has(tok) || NEGATION_TOKENS.has(tok.replace(/'/g, ''))) {
          negated = true;
          break;
        }
      }
      if (!negated) return true;
    }
  }
  return false;
}

const RATING_PHRASES: Record<ScorecardRecommendation, string[]> = {
  strong_yes: ['strong yes', 'strong_yes', 'strong hire'],
  yes: ['yes', 'hire', 'thumbs up'],
  no: ['no', 'no hire', 'do not hire'],
  strong_no: ['strong no', 'strong_no', 'hard no'],
  definitely_not: ['definitely not', 'definitely_not'],
};

function verifyRatingInSamCorpus(
  rating: ScorecardRecommendation,
  samCorpus: string,
): boolean {
  const phrases = RATING_PHRASES[rating] ?? [rating.replace(/_/g, ' ')];
  return phrases.some(p => hasUnnegatedAssessmentPhrase(samCorpus, p));
}

interface TranscriptTurn {
  speaker: string | null;
  text: string;
}

function parseTranscriptTurns(text: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([A-Za-z][A-Za-z0-9 .,'()-]{0,50}):\s+(.+)$/.exec(line);
    if (match) {
      turns.push({ speaker: match[1]!.trim(), text: match[2]! });
    } else if (turns.length > 0) {
      turns[turns.length - 1]!.text += ` ${line}`;
    } else {
      turns.push({ speaker: null, text: line });
    }
  }
  return turns;
}

function checkTranscriptQuoteTurn(
  transcriptTexts: string[],
  nonTranscriptTexts: string[],
  quote: string,
): string | null {
  // If the quote comes from Sam's written notes or Slack instruction, speaker-turn rules don't apply
  if (nonTranscriptTexts.some(t => containsVerbatimQuote(t, quote))) {
    return null;
  }

  let matchedAnyTranscript = false;
  let lastTurnError: string | null = null;

  for (const tr of transcriptTexts) {
    if (!containsVerbatimQuote(tr, quote)) continue;
    matchedAnyTranscript = true;
    const turns = parseTranscriptTurns(tr);
    const hasNamedTurns = turns.some(t => t.speaker !== null);
    if (!hasNamedTurns) {
      return null;
    }
    const matchingTurns = turns.filter(t => containsVerbatimQuote(t.text, quote));
    if (matchingTurns.length === 0) {
      lastTurnError = `quote "${quote}" spans across speaker turns or includes a speaker label.`;
      continue;
    }
    const candidateTurn = matchingTurns.find(t => {
      if (!t.speaker) return true;
      return !INTERVIEWER_SPEAKER_NAMES.has(normalizeForMatch(t.speaker));
    });
    if (candidateTurn) {
      return null;
    }
    lastTurnError = `quote "${quote}" was spoken by the interviewer (${matchingTurns[0]?.speaker}), not the candidate.`;
  }

  if (matchedAnyTranscript && lastTurnError) {
    return lastTurnError;
  }
  return null;
}

function collectSources(draft: SystemsAdminScorecardDraft): {
  allText: string;
  samAssessmentText: string;
  transcriptTexts: string[];
  nonTranscriptTexts: string[];
  byId: Map<string, DraftSourceDocument>;
  hasExplicitSources: boolean;
} {
  const byId = new Map<string, DraftSourceDocument>();
  const allParts: string[] = [];
  const samParts: string[] = [];
  const transcriptTexts: string[] = [];
  const nonTranscriptTexts: string[] = [];

  if (Array.isArray(draft.sources)) {
    for (const src of draft.sources) {
      byId.set(src.id, src);
      allParts.push(src.text);
      if (src.kind === 'sam_notes' || src.kind === 'slack_instruction') {
        samParts.push(src.text);
        nonTranscriptTexts.push(src.text);
      } else if (src.kind === 'transcript') {
        transcriptTexts.push(src.text);
        const lines = src.text.split(/\r?\n/);
        for (const line of lines) {
          if (/^\s*(sam(?:\s+vangelos)?|interviewer)\s*:/i.test(line)) {
            samParts.push(line);
          }
        }
      }
    }
  }

  if (typeof draft.transcript === 'string' && draft.transcript.trim()) {
    allParts.push(draft.transcript);
    transcriptTexts.push(draft.transcript);
    const lines = draft.transcript.split(/\r?\n/);
    for (const line of lines) {
      if (/^\s*(sam(?:\s+vangelos)?|interviewer)\s*:/i.test(line)) {
        samParts.push(line);
      }
    }
  }

  if (typeof draft.sam_notes === 'string' && draft.sam_notes.trim()) {
    allParts.push(draft.sam_notes);
    samParts.push(draft.sam_notes);
    nonTranscriptTexts.push(draft.sam_notes);
  }

  if (typeof draft.slack_instruction === 'string' && draft.slack_instruction.trim()) {
    allParts.push(draft.slack_instruction);
    samParts.push(draft.slack_instruction);
    nonTranscriptTexts.push(draft.slack_instruction);
  }

  if (typeof draft.sam_assessment === 'string' && draft.sam_assessment.trim()) {
    allParts.push(draft.sam_assessment);
    samParts.push(draft.sam_assessment);
    nonTranscriptTexts.push(draft.sam_assessment);
  }

  return {
    allText: allParts.join('\n'),
    samAssessmentText: samParts.join('\n'),
    transcriptTexts,
    nonTranscriptTexts,
    byId,
    hasExplicitSources: allParts.length > 0,
  };
}

function extractQuotesFromStatement(item: string | GroundedStatementInput): string[] {
  if (typeof item === 'string') {
    const inlineMatches = [...item.matchAll(/"([^"]{8,})"|\u201C([^\u201D]{8,})\u201D/g)];
    return inlineMatches.map(m => (m[1] ?? m[2] ?? '').trim()).filter(Boolean);
  }
  const quotes: string[] = [];
  if (typeof item.quote === 'string' && item.quote.trim()) {
    quotes.push(item.quote.trim());
  }
  if (typeof item.verbatim_quote === 'string' && item.verbatim_quote.trim()) {
    quotes.push(item.verbatim_quote.trim());
  }
  if (typeof item.evidence?.quote === 'string' && item.evidence.quote.trim()) {
    quotes.push(item.evidence.quote.trim());
  }
  if (Array.isArray(item.support)) {
    for (const s of item.support) {
      if (typeof s?.quote === 'string' && s.quote.trim()) {
        quotes.push(s.quote.trim());
      }
    }
  }
  return quotes;
}

/**
 * Validates a `systems-admin` Granola screen scorecard draft before preview/submission:
 * 1. `overall_recommendation` (`strong_yes | yes | no | strong_no | definitely_not`) must come ONLY
 *    from Sam's explicit assessment (rejecting decision words like "Advance" or negated ratings).
 * 2. Unsupported attributes are omitted rather than guessed; explicitly rated attributes must have
 *    valid ratings (and match Sam's assessment when provided).
 * 3. Every statement in `key_takeaways` (`notes`) and free-text `questions` (`question_answers`)
 *    must carry a verbatim quote (>= 3 words) grounded in the Granola transcript or Sam's notes.
 */
export function validateSystemsAdminScorecardDraft(
  draft: SystemsAdminScorecardDraft,
  options: {
    requireSourceGrounding?: boolean;
    granola_transcript?: string;
    transcript?: string;
    sam_notes?: string;
  } = {},
): DraftValidationResult {
  const errors: string[] = [];
  const omittedAttributeIds: number[] = [];
  const mergedDraft: SystemsAdminScorecardDraft = {
    ...draft,
    ...(options.transcript || options.granola_transcript
      ? { transcript: draft.transcript ?? options.transcript ?? options.granola_transcript }
      : {}),
    ...(options.sam_notes ? { sam_notes: draft.sam_notes ?? options.sam_notes } : {}),
  };
  const {
    allText,
    samAssessmentText,
    transcriptTexts,
    nonTranscriptTexts,
    byId,
    hasExplicitSources,
  } = collectSources(mergedDraft);
  const enforceCorpusMatch = options.requireSourceGrounding ?? hasExplicitSources;

  // 1. Validate overall_recommendation / candidate_rating
  const rawRating = (draft.overall_recommendation ?? draft.candidate_rating ?? '')
    .toString()
    .trim()
    .toLowerCase();

  if (!rawRating) {
    errors.push(
      'Missing overall_recommendation: rating must come explicitly from Sam Vangelos assessment.',
    );
  } else if (!(ALLOWED_RECOMMENDATIONS as readonly string[]).includes(rawRating)) {
    errors.push(
      `Invalid overall_recommendation '${rawRating}': must be one of [${ALLOWED_RECOMMENDATIONS.join(', ')}] ("Advance" is a stage decision, not a rating).`,
    );
  } else if (enforceCorpusMatch && samAssessmentText.trim().length === 0) {
    errors.push(
      `overall_recommendation '${rawRating}' has no Sam Vangelos assessment source (sam_notes, sam_assessment, or slack_instruction).`,
    );
  } else if (samAssessmentText.trim().length > 0) {
    const rating = rawRating as ScorecardRecommendation;
    if (!verifyRatingInSamCorpus(rating, samAssessmentText)) {
      errors.push(
        `overall_recommendation '${rating}' is not supported by Sam's explicit assessment text (or was negated).`,
      );
    }
  }

  // 2. Validate key_takeaways quote-grounding (supports both key_takeaways and key_takeaway_statements)
  const rawTakeaways = draft.key_takeaways ?? draft.key_takeaway_statements;
  const takeawaysList: Array<string | GroundedStatementInput> = Array.isArray(rawTakeaways)
    ? rawTakeaways
    : typeof rawTakeaways === 'string' && rawTakeaways.trim()
      ? [rawTakeaways]
      : [];

  if (takeawaysList.length === 0) {
    errors.push('key_takeaways must contain at least one quote-grounded statement.');
  }

  takeawaysList.forEach((item, idx) => {
    const text = typeof item === 'string' ? item : (item.text ?? item.statement ?? '');
    if (!text || !text.trim()) {
      errors.push(`key_takeaways[${idx}] has empty statement text.`);
      return;
    }
    const quotes = extractQuotesFromStatement(item);
    if (quotes.length === 0) {
      errors.push(
        `key_takeaways[${idx}] ("${text.slice(0, 60)}") is missing a verbatim supporting quote from the transcript or Sam's notes.`,
      );
      return;
    }

    for (const q of quotes) {
      if (wordCount(q) < 3) {
        errors.push(
          `key_takeaways[${idx}] supporting quote "${q}" is too short (< 3 words) to be a verbatim quote.`,
        );
      } else if (enforceCorpusMatch) {
        let matched = containsVerbatimQuote(allText, q);
        if (!matched && typeof item === 'object' && Array.isArray(item.support)) {
          for (const sup of item.support) {
            if (sup.quote === q && sup.source_id && byId.has(sup.source_id)) {
              matched = containsVerbatimQuote(byId.get(sup.source_id)!.text, q);
            }
          }
        }
        if (!matched) {
          errors.push(
            `key_takeaways[${idx}] supporting quote "${q}" was not found verbatim in the Granola transcript or Sam's notes.`,
          );
        } else {
          const turnErr = checkTranscriptQuoteTurn(transcriptTexts, nonTranscriptTexts, q);
          if (turnErr) {
            errors.push(`key_takeaways[${idx}] ${turnErr}`);
          }
        }
      }
    }

    // Check numbers in claim text appear in supporting quotes (both object and string forms)
    const claimNumbers = extractNumbers(text);
    const quoteJoined = quotes.join(' ');
    const quoteNumbers = new Set(extractNumbers(quoteJoined));
    for (const num of claimNumbers) {
      if (!quoteNumbers.has(num)) {
        errors.push(
          `key_takeaways[${idx}] cites number '${num}' which does not appear in its supporting quotes.`,
        );
      }
    }
  });

  // 3. Validate attribute_ratings (omit unsupported attributes rather than guessing)
  if (Array.isArray(draft.attributes)) {
    for (const attr of draft.attributes) {
      const attrId = Number(attr.id ?? attr.job_candidate_attribute_id);
      const rawAttrVal = attr.value ?? attr.rating;
      if (rawAttrVal === undefined || rawAttrVal === null || String(rawAttrVal).trim() === '') {
        omittedAttributeIds.push(attrId);
        continue;
      }
      const val = String(rawAttrVal).trim().toLowerCase();
      if (!(ALLOWED_RECOMMENDATIONS as readonly string[]).includes(val)) {
        errors.push(
          `Attribute ${attrId} has invalid rating '${rawAttrVal}'; must be one of [${ALLOWED_RECOMMENDATIONS.join(', ')}] or omitted.`,
        );
        continue;
      }
      const rating = val as ScorecardRecommendation;
      const explicitQuotes: string[] = [];
      if (typeof attr.sam_quote === 'string' && attr.sam_quote.trim()) {
        explicitQuotes.push(attr.sam_quote.trim());
      }
      if (Array.isArray(attr.support)) {
        for (const s of attr.support) {
          if (typeof s?.quote === 'string' && s.quote.trim()) {
            explicitQuotes.push(s.quote.trim());
          }
        }
      }
      if (Array.isArray(attr.sentences)) {
        for (const sent of attr.sentences) {
          const sentQuotes = extractQuotesFromStatement(sent);
          for (const sq of sentQuotes) {
            if (enforceCorpusMatch && !containsVerbatimQuote(allText, sq)) {
              errors.push(
                `Attribute ${attrId} sentence quote "${sq}" was not found verbatim in the Granola transcript or Sam's notes.`,
              );
            } else if (enforceCorpusMatch) {
              const turnErr = checkTranscriptQuoteTurn(transcriptTexts, nonTranscriptTexts, sq);
              if (turnErr) {
                errors.push(`Attribute ${attrId} ${turnErr}`);
              }
            }
          }
        }
      }

      if (explicitQuotes.length > 0) {
        const primaryQuote = explicitQuotes[0]!;
        if (
          samAssessmentText.trim().length > 0 &&
          !containsVerbatimQuote(samAssessmentText, primaryQuote)
        ) {
          errors.push(
            `Attribute ${attrId} quote "${primaryQuote}" is not found in Sam's assessment.`,
          );
        }
        if (!verifyRatingInSamCorpus(rating, explicitQuotes.join(' '))) {
          errors.push(
            `Attribute ${attrId} rating '${rating}' is not supported by its Sam assessment quote "${primaryQuote}".`,
          );
        }
      } else if (enforceCorpusMatch) {
        if (samAssessmentText.trim().length === 0 || !verifyRatingInSamCorpus(rating, samAssessmentText)) {
          errors.push(
            `Attribute ${attrId} rating '${rating}' is not grounded in Sam's explicit assessment.`,
          );
        }
      }
    }
  }

  // 4. Validate question_answers quote-grounding and number-grounding
  if (Array.isArray(draft.questions)) {
    draft.questions.forEach((q, idx) => {
      const qId = Number(q.id ?? q.scorecard_question_id);
      const stmtText = Array.isArray(q.statements)
        ? q.statements.map(s => s.text ?? s.statement ?? '').join(' ')
        : '';
      const freeText = (q.text ?? q.answer ?? q.value ?? stmtText ?? '').toString().trim();
      const hasBool = typeof q.boolean_value === 'boolean';
      const hasOptions = Array.isArray(q.option_ids) && q.option_ids.length > 0;

      if (!freeText && !hasBool && !hasOptions) {
        return;
      }

      if (freeText) {
        const quotes: string[] = [];
        if (typeof q.quote === 'string' && q.quote.trim()) {
          quotes.push(q.quote.trim());
        }
        if (Array.isArray(q.support)) {
          for (const s of q.support) {
            if (typeof s?.quote === 'string' && s.quote.trim()) {
              quotes.push(s.quote.trim());
            }
          }
        }
        if (Array.isArray(q.statements)) {
          for (const st of q.statements) {
            quotes.push(...extractQuotesFromStatement(st));
          }
        }
        if (quotes.length === 0) {
          const inlineQuotes = extractQuotesFromStatement(freeText);
          quotes.push(...inlineQuotes);
        }

        if (quotes.length === 0) {
          errors.push(
            `questions[${idx}] (id=${qId}) free-text answer is missing a verbatim quote from the Granola transcript or Sam's notes.`,
          );
        } else {
          for (const quote of quotes) {
            if (wordCount(quote) < 3) {
              errors.push(
                `questions[${idx}] (id=${qId}) supporting quote "${quote}" is too short (< 3 words).`,
              );
            } else if (enforceCorpusMatch) {
              if (!containsVerbatimQuote(allText, quote)) {
                errors.push(
                  `questions[${idx}] (id=${qId}) supporting quote "${quote}" was not found verbatim in the Granola transcript or Sam's notes.`,
                );
              } else {
                const turnErr = checkTranscriptQuoteTurn(
                  transcriptTexts,
                  nonTranscriptTexts,
                  quote,
                );
                if (turnErr) {
                  errors.push(`questions[${idx}] (id=${qId}) ${turnErr}`);
                }
              }
            }
          }

          const qClaimNumbers = extractNumbers(freeText);
          const qQuoteNumbers = new Set(extractNumbers(quotes.join(' ')));
          for (const num of qClaimNumbers) {
            if (!qQuoteNumbers.has(num)) {
              errors.push(
                `questions[${idx}] (id=${qId}) cites number '${num}' which does not appear in its supporting quotes.`,
              );
            }
          }
        }
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    omitted_attribute_ids: omittedAttributeIds,
  };
}

function formatStatementWithQuote(item: string | GroundedStatementInput): string {
  if (typeof item === 'string') {
    return item.trim();
  }
  const text = (item.text ?? item.statement ?? '').trim();
  const primaryQuote =
    item.quote?.trim() ??
    item.verbatim_quote?.trim() ??
    item.evidence?.quote?.trim() ??
    item.support?.find(s => typeof s.quote === 'string' && s.quote.trim())?.quote.trim();
  if (!primaryQuote || text.includes(primaryQuote)) {
    return text;
  }
  return `${text} ("${primaryQuote}")`;
}

/**
 * Field Mapping Adapter (`systems-admin` draft -> `scorecard_submit` schema):
 * - `draft.key_takeaways` -> `scorecard_submit.notes` (and `private_notes`)
 * - `draft.overall_recommendation` -> `scorecard_submit.candidate_rating` (and `overall_recommendation`)
 * - `draft.attributes[]` (`{ id, value, note }`) -> `scorecard_submit.attribute_ratings[]` (`{ job_candidate_attribute_id, candidate_attribute_rating, rating, note }`)
 * - `draft.questions[]` (`{ id, text, boolean_value, option_ids }`) -> `scorecard_submit.question_answers[]`
 */
export function adaptSystemsAdminDraftToScorecardSubmit(
  draft: SystemsAdminScorecardDraft,
  context: {
    application_id: number;
    job_id?: number;
    job_interview_id?: number;
    interview_kit_id?: number;
    interviewer_id?: number;
    requireSourceGrounding?: boolean;
  },
): ScorecardSubmitMappedInput {
  const validation = validateSystemsAdminScorecardDraft(draft, {
    requireSourceGrounding: context.requireSourceGrounding,
  });
  if (!validation.ok) {
    const err = new Error(
      `Scorecard draft failed quote-grounding/rating validation: ${validation.errors.join('; ')}`,
    ) as Error & { code?: string; validationErrors?: string[] };
    err.code = 'UNGROUNDED_SCORECARD_CLAIM';
    err.validationErrors = validation.errors;
    throw err;
  }

  const rating = (draft.overall_recommendation ?? draft.candidate_rating)!
    .toString()
    .trim()
    .toLowerCase() as ScorecardRecommendation;

  const rawTakeaways = draft.key_takeaways ?? draft.key_takeaway_statements ?? [];
  const takeawaysList = Array.isArray(rawTakeaways)
    ? rawTakeaways
    : [rawTakeaways];
  const notes = takeawaysList
    .map(item => `- ${formatStatementWithQuote(item)}`)
    .join('\n');

  const attributeRatings = (draft.attributes ?? [])
    .filter(attr => {
      const val = attr.value ?? attr.rating;
      return val !== undefined && val !== null && String(val).trim() !== '';
    })
    .map(attr => {
      const rawVal = attr.value ?? attr.rating;
      const attrRating = String(rawVal).trim().toLowerCase() as ScorecardRecommendation;
      const noteText =
        attr.note !== undefined && attr.note !== null
          ? attr.note
          : Array.isArray(attr.sentences) && attr.sentences.length > 0
            ? attr.sentences.map(s => formatStatementWithQuote(s)).join(' ')
            : undefined;
      return {
        job_candidate_attribute_id: Number(attr.id ?? attr.job_candidate_attribute_id),
        candidate_attribute_rating: attrRating,
        rating: attrRating,
        ...(noteText !== undefined ? { note: noteText } : {}),
      };
    });

  const questionAnswers = (draft.questions ?? [])
    .filter(q => {
      const stmtText = Array.isArray(q.statements)
        ? q.statements.map(s => formatStatementWithQuote(s)).join(' ')
        : '';
      const text = (q.text ?? q.answer ?? q.value ?? stmtText ?? '').toString().trim();
      const hasBool = typeof q.boolean_value === 'boolean';
      const hasOptions = Array.isArray(q.option_ids) && q.option_ids.length > 0;
      return Boolean(text || hasBool || hasOptions);
    })
    .map(q => {
      const stmtText = Array.isArray(q.statements)
        ? q.statements.map(s => formatStatementWithQuote(s)).join(' ')
        : '';
      const rawText = (q.text ?? q.answer ?? q.value ?? stmtText ?? '').toString().trim();
      const primaryQuote =
        q.quote?.trim() ??
        q.support?.find(s => typeof s.quote === 'string' && s.quote.trim())?.quote.trim();
      const formattedAnswer =
        rawText && primaryQuote && !rawText.includes(primaryQuote)
          ? `${rawText} ("${primaryQuote}")`
          : rawText;

      return {
        scorecard_question_id: Number(q.id ?? q.scorecard_question_id),
        ...(formattedAnswer ? { answer: formattedAnswer } : {}),
        ...(typeof q.boolean_value === 'boolean' ? { boolean_value: q.boolean_value } : {}),
        ...(Array.isArray(q.option_ids) && q.option_ids.length > 0
          ? { option_ids: q.option_ids.map(Number) }
          : {}),
      };
    });

  const jobInterviewId =
    context.job_interview_id ?? RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID;
  const interviewKitId =
    context.interview_kit_id ?? RECRUITER_PHONE_SCREEN_KIT_ID;

  return {
    application_id: context.application_id,
    job_interview_id: jobInterviewId,
    interview_kit_id: interviewKitId,
    interviewer_id: context.interviewer_id ?? SAM_GREENHOUSE_USER_ID,
    notes,
    private_notes: notes,
    candidate_rating: rating,
    overall_recommendation: rating,
    attribute_ratings: attributeRatings,
    question_answers: questionAnswers,
  };
}

export function buildCandidateHiringChannelPost(input: {
  candidate_name: string;
  application_id: number;
  job_id: number;
  job_name?: string;
  recommendation: ScorecardRecommendation;
  notes: string;
}): string {
  const roleLabel = input.job_name ?? `Job ${input.job_id}`;
  return [
    `*Candidate Ready for Hiring Manager Review:* ${input.candidate_name} (App \`${input.application_id}\` — ${roleLabel})`,
    `*Recruiter Screen Recommendation:* \`${input.recommendation}\` (Sam Vangelos)`,
    `*Key Takeaways:*`,
    input.notes,
    `React with :thumbsup: to advance (or reply in thread to specify *Turing Assessment* vs *Manager / Tech Screen*).`,
  ].join('\n');
}

export interface PrepareWorkflow2Input {
  episode_id?: string;
  application_id: number;
  candidate_id?: number | null;
  candidate_name: string;
  candidate_tz?: string | null;
  job_id?: number;
  job_name?: string;
  from_stage_id?: number;
  to_stage_id?: number;
  job_interview_id?: number;
  interview_kit_id?: number;
  interview_ended_at?: string;
  draft: SystemsAdminScorecardDraft;
  sources?: {
    granola_transcript?: string;
    transcript?: string;
    sam_notes?: string;
  };
  slack_channel_id?: string;
  now?: string;
}

/**
 * Validates the quote-grounded Granola screen draft, maps it onto `scorecard_submit`,
 * pre-seeds Chain D's linked steps (`submit_recruiter_scorecard` + coupled Step 2) in `state.sqlite`,
 * and registers the proposal for Sam's approval.
 */
export function prepareWorkflow2ScorecardProposal(
  store: SqliteCoordinatorStore,
  input: PrepareWorkflow2Input,
): {
  episode: EpisodeRow<Workflow2EpisodeState>;
  approval: ApprovalRow;
  chain_id: string;
  mapped_scorecard: ScorecardSubmitMappedInput;
  scorecard_input: ScorecardSubmitMappedInput;
  decision_branch: 'advance' | 'reject';
} {
  const now = input.now ?? new Date().toISOString();
  const jobId = input.job_id ?? PILOT_JOB_ID;
  const fromStageId = input.from_stage_id ?? RECRUITER_PHONE_SCREEN_STAGE_ID;
  const toStageId = input.to_stage_id ?? HIRING_MANAGER_REVIEW_STAGE_ID;
  const jobInterviewId = input.job_interview_id ?? RECRUITER_PHONE_SCREEN_JOB_INTERVIEW_ID;
  const interviewKitId = input.interview_kit_id ?? RECRUITER_PHONE_SCREEN_KIT_ID;
  const slackChannelId = input.slack_channel_id ?? FIELD_ENGINEERING_HIRING_CHANNEL_ID;
  const interviewEndedAt = input.interview_ended_at ?? now;

  const mergedDraft: SystemsAdminScorecardDraft = {
    ...input.draft,
    ...(input.sources?.transcript || input.sources?.granola_transcript
      ? {
          transcript:
            input.draft.transcript ??
            input.sources.transcript ??
            input.sources.granola_transcript,
        }
      : {}),
    ...(input.sources?.sam_notes
      ? { sam_notes: input.draft.sam_notes ?? input.sources.sam_notes }
      : {}),
  };

  const mapped = adaptSystemsAdminDraftToScorecardSubmit(mergedDraft, {
    application_id: input.application_id,
    job_id: jobId,
    job_interview_id: jobInterviewId,
    interview_kit_id: interviewKitId,
    interviewer_id: SAM_GREENHOUSE_USER_ID,
  });

  const decisionBranch: 'advance' | 'reject' = POSITIVE_RECOMMENDATIONS.has(
    mapped.candidate_rating,
  )
    ? 'advance'
    : 'reject';

  const episodeId = input.episode_id ?? `wf2:${input.application_id}:${fromStageId}`;
  const chainId = `wf2_chain_d:${input.application_id}:${fromStageId}`;

  const presentationText =
    decisionBranch === 'advance'
      ? buildCandidateHiringChannelPost({
          candidate_name: input.candidate_name,
          application_id: input.application_id,
          job_id: jobId,
          job_name: input.job_name,
          recommendation: mapped.candidate_rating,
          notes: mapped.notes,
        })
      : undefined;

  const state: Workflow2EpisodeState = {
    application_id: input.application_id,
    candidate_id: input.candidate_id ?? null,
    candidate_name: input.candidate_name,
    candidate_tz: input.candidate_tz ?? null,
    job_id: jobId,
    job_name: input.job_name,
    from_stage_id: fromStageId,
    to_stage_id: toStageId,
    job_interview_id: jobInterviewId,
    interview_kit_id: interviewKitId,
    interview_ended_at: interviewEndedAt,
    decision_branch: decisionBranch,
    coupled_decision: decisionBranch,
    overall_recommendation: mapped.candidate_rating,
    scorecard_input: mapped,
    slack_channel_id: slackChannelId,
    slack_presentation_text: presentationText,
    chain_id: chainId,
    scorecard_submitted: false,
    scorecard_id: null,
    coupled_step_completed: false,
  };

  const episode = store.upsertEpisode<Workflow2EpisodeState>({
    episode_id: episodeId,
    workflow: 'wf2_scorecard',
    application_id: input.application_id,
    candidate_id: input.candidate_id ?? null,
    job_id: jobId,
    stage_id: fromStageId,
    status: 'PENDING_APPROVAL',
    state,
    now,
  });

  // Cancel any pending missing-notes prompt/expiry timers for this episode now that draft is ready
  store.cancelTimersByPrefix(`wf2_missing_notes_prompt:${episodeId}`, 'Granola draft arrived', now);
  store.cancelTimersByPrefix(`wf2_manual_notes_expiry:${episodeId}`, 'Granola draft arrived', now);

  // Pre-seed linked steps in `chain_steps` so Step 1 and Coupled Step 2 are durably bound
  // on the same chain in `state.sqlite` before execution begins.
  // If Step 1 has not yet executed (`!existingStep1` or `existingStep1.status === 'pending'`),
  // clear any stale pending branch steps first so draft edits cleanly replace pending steps.
  const existingStep1 = store.getChainStep(chainId, 'submit_recruiter_scorecard');
  if (!existingStep1 || existingStep1.status === 'pending') {
    store.clearPendingChainSteps(chainId);
    store.upsertChainStep({
      chain_id: chainId,
      step_index: 10,
      step_key: 'submit_recruiter_scorecard',
      episode_id: episodeId,
      action_key: `wf2_submit_scorecard:${input.application_id}:${fromStageId}`,
      idempotency_key: sha256(`${episodeId}:submit_recruiter_scorecard`),
      service: 'greenhouse',
      operation: 'scorecard_submit',
      input: mapped as unknown as Record<string, unknown>,
      status: 'pending',
      now,
    });
  }

  if (decisionBranch === 'advance') {
    const existingMove = store.getChainStep(chainId, 'advance_to_hm_review');
    if (!existingMove) {
      store.upsertChainStep({
        chain_id: chainId,
        step_index: 20,
        step_key: 'advance_to_hm_review',
        episode_id: episodeId,
        action_key: `wf2_advance_hm_review:${input.application_id}:${toStageId}`,
        idempotency_key: sha256(`${episodeId}:advance_to_hm_review`),
        service: 'greenhouse',
        operation: 'application_stage_move',
        input: {
          application_id: input.application_id,
          to_stage_id: toStageId,
          email_from_user_id: SAM_GREENHOUSE_USER_ID,
        },
        status: 'pending',
        now,
      });
    }

    const existingSlack = store.getChainStep(chainId, 'post_candidate_to_hiring_channel');
    if (!existingSlack) {
      store.upsertChainStep({
        chain_id: chainId,
        step_index: 30,
        step_key: 'post_candidate_to_hiring_channel',
        episode_id: episodeId,
        action_key: `wf2_post_hiring_channel:${input.application_id}:${toStageId}`,
        idempotency_key: sha256(`${episodeId}:post_candidate_to_hiring_channel`),
        service: 'slack',
        operation: 'chat.postMessage',
        input: {
          channel: slackChannelId,
          text: presentationText,
        },
        status: 'pending',
        now,
      });
    }
  } else {
    const existingReject = store.getChainStep(chainId, 'enqueue_deliberated_rejection');
    if (!existingReject) {
      store.upsertChainStep({
        chain_id: chainId,
        step_index: 20,
        step_key: 'enqueue_deliberated_rejection',
        episode_id: episodeId,
        action_key: `wf2_enqueue_rejection:${input.application_id}:${fromStageId}`,
        idempotency_key: sha256(`${episodeId}:enqueue_deliberated_rejection`),
        service: 'greenhouse',
        operation: 'schedule_deliberated_rejection',
        input: {
          application_id: input.application_id,
          stage_id: fromStageId,
          overall_recommendation: mapped.candidate_rating,
          interview_ended_at: input.interview_ended_at,
        },
        status: 'pending',
        now,
      });
    }
  }

  const approval = store.registerProposal({
    episode_id: episodeId,
    action_key: chainId,
    chain_id: chainId,
    workflow: 'wf2_scorecard',
    params: {
      application_id: input.application_id,
      job_id: jobId,
      from_stage_id: fromStageId,
      to_stage_id: decisionBranch === 'advance' ? toStageId : fromStageId,
      decision_branch: decisionBranch,
      overall_recommendation: mapped.candidate_rating,
      scorecard_input: mapped,
    },
    expected_state: {
      application_id: input.application_id,
      application_status: ['active', 'in_process'],
      stage_id: fromStageId,
    },
    draft_sha256: presentationText ? sha256(presentationText) : null,
    now,
  });

  store.supersedeApprovalsForEpisode(episodeId, 'Superseded by revised WF2 scorecard proposal', {
    keepProposalHash: approval.proposal_hash,
    now,
  });

  return {
    episode,
    approval,
    chain_id: chainId,
    mapped_scorecard: mapped,
    scorecard_input: mapped,
    decision_branch: decisionBranch,
  };
}

/**
 * Builds the 2-part Chain D steps (`submit_recruiter_scorecard` + coupled Step 2)
 * for `DeterministicExecutor.executeChain`.
 */
export function buildWorkflow2ChainDSteps(
  state: Workflow2EpisodeState,
  executor: DeterministicExecutor,
): ChainStepDefinition[] {
  const steps: ChainStepDefinition[] = [
    {
      step_index: 10,
      step_key: 'submit_recruiter_scorecard',
      action_key: `wf2_submit_scorecard:${state.application_id}:${state.from_stage_id}`,
      service: 'greenhouse',
      operation: 'scorecard_submit',
      buildInput: () => state.scorecard_input as unknown as Record<string, unknown>,
    },
  ];

  if (state.decision_branch === 'advance') {
    steps.push(
      {
        step_index: 20,
        step_key: 'advance_to_hm_review',
        action_key: `wf2_advance_hm_review:${state.application_id}:${state.to_stage_id}`,
        service: 'greenhouse',
        operation: 'application_stage_move',
        buildInput: () => ({
          application_id: state.application_id,
          to_stage_id: state.to_stage_id,
          email_from_user_id: SAM_GREENHOUSE_USER_ID,
        }),
      },
      {
        step_index: 30,
        step_key: 'post_candidate_to_hiring_channel',
        action_key: `wf2_post_hiring_channel:${state.application_id}:${state.to_stage_id}`,
        service: 'slack',
        operation: 'chat.postMessage',
        outboundBody: (_ctx, input) => String(input.text ?? ''),
        buildInput: () => ({
          channel: state.slack_channel_id,
          text:
            state.slack_presentation_text ??
            buildCandidateHiringChannelPost({
              candidate_name: state.candidate_name,
              application_id: state.application_id,
              job_id: state.job_id,
              job_name: state.job_name,
              recommendation: state.overall_recommendation,
              notes: state.scorecard_input.notes,
            }),
        }),
        execute: async (_ctx, input) => {
          if (!executor.slack) {
            throw new Error('No SlackProvider configured for post_candidate_to_hiring_channel.');
          }
          const res = await executor.slack.sendMessage({
            channel: String(input.channel),
            text: String(input.text),
          });
          return {
            provider_id: res.ts,
            output: { ts: res.ts, channel: res.channel },
          };
        },
        reconcile: async (_ctx: ChainStepContext, stepRow: ChainStepRow) => {
          if (stepRow.provider_id) {
            return {
              reconciled: true,
              provider_id: stepRow.provider_id,
              output: stepRow.output,
            };
          }
          return { reconciled: false };
        },
      },
    );
  } else {
    steps.push({
      step_index: 20,
      step_key: 'enqueue_deliberated_rejection',
      action_key: `wf2_enqueue_rejection:${state.application_id}:${state.from_stage_id}`,
      service: 'greenhouse',
      operation: 'schedule_deliberated_rejection',
      buildInput: ctx => {
        const scorecardStepId = ctx.priorProviderIds.submit_recruiter_scorecard;
        const parsedScorecardId = Number(scorecardStepId);
        return {
          application_id: state.application_id,
          stage_id: state.from_stage_id,
          scorecard_id: Number.isFinite(parsedScorecardId) && parsedScorecardId > 0
            ? parsedScorecardId
            : state.application_id * 10 + 1,
          overall_recommendation: state.overall_recommendation,
          interview_ended_at: state.interview_ended_at,
          candidate_tz: state.candidate_tz ?? null,
        };
      },
      execute: async (ctx, input) => {
        const scorecardId = Number(input.scorecard_id);
        const rejectionEpisodeId = `wf4:${state.application_id}:${state.from_stage_id}:${scorecardId}`;
        const evalRes = evaluateWorkflow4Scorecards(ctx.store, {
          episode_id: rejectionEpisodeId,
          application_id: state.application_id,
          candidate_id: state.candidate_id ?? undefined,
          job_id: state.job_id,
          current_stage_id: state.from_stage_id,
          interview_ends_at: state.interview_ended_at,
          candidate_tz: state.candidate_tz ?? null,
          scorecards: [
            {
              id: scorecardId,
              application_id: state.application_id,
              stage_id: state.from_stage_id,
              status: 'complete',
              overall_recommendation: state.overall_recommendation,
              submitted_at: ctx.nowIso(),
            },
          ],
          now: ctx.nowIso(),
        });

        if (evalRes.outcome !== 'deliberation_timer_scheduled') {
          throw new Error(
            `Expected WF4 deliberation timer to be scheduled, got '${evalRes.outcome}'.`,
          );
        }

        // Pre-authorize the coupled WF4 rejection proposal under Sam's Chain D approval
        ctx.store.grantApproval({
          proposal_hash: evalRes.proposal.proposal_hash,
          decision: 'approved',
          actor: 'sam',
          now: ctx.nowIso(),
        });

        return {
          provider_id: evalRes.timer.timer_key,
          output: {
            timer_key: evalRes.timer.timer_key,
            fire_at: evalRes.timer.fire_at,
            rejection_episode_id: rejectionEpisodeId,
            rejection_proposal_hash: evalRes.proposal.proposal_hash,
          },
        };
      },
      reconcile: async (ctx, stepRow) => {
        const scorecardStepId = ctx.priorProviderIds.submit_recruiter_scorecard;
        const parsedScorecardId = Number(scorecardStepId);
        const scorecardId =
          Number.isFinite(parsedScorecardId) && parsedScorecardId > 0
            ? parsedScorecardId
            : Number((stepRow.input as any)?.scorecard_id ?? state.application_id * 10 + 1);
        const rejectionEpisodeId = `wf4:${state.application_id}:${state.from_stage_id}:${scorecardId}`;
        const timerKey = `wf4_reject:${state.application_id}:${state.from_stage_id}:${scorecardId}`;
        const existingTimer = ctx.store.getTimer(timerKey);
        if (existingTimer) {
          const timerPayload = (existingTimer.payload ?? {}) as Record<string, any>;
          const rejHash = timerPayload.proposal_hash as string | undefined;
          if (rejHash) {
            const rejApproval = ctx.store.getApproval(rejHash);
            if (rejApproval && rejApproval.decision === 'pending') {
              ctx.store.grantApproval({
                proposal_hash: rejHash,
                decision: 'approved',
                actor: 'sam',
                now: ctx.nowIso(),
              });
            }
          }
          return {
            reconciled: true,
            provider_id: existingTimer.timer_key,
            output: {
              timer_key: existingTimer.timer_key,
              fire_at: existingTimer.fire_at,
              rejection_episode_id: existingTimer.episode_id ?? rejectionEpisodeId,
              ...(rejHash ? { rejection_proposal_hash: rejHash } : {}),
            },
          };
        }
        return { reconciled: false, allowSafeRetry: true };
      },
    });
  }

  return steps;
}

/**
 * Executes or resumes Chain D (`submit_recruiter_scorecard` + coupled Step 2).
 * Once Step 1 (`submit_recruiter_scorecard`) succeeds, Step 2 remains resumable even when
 * a fresh scan of Greenhouse sees the completed scorecard!
 */
export async function executeWorkflow2ChainD(
  executor: DeterministicExecutor,
  input: {
    episode_id: string;
    approval?: ApprovalRow | null;
    fresh_snapshot?: FreshReadSnapshot | null | (() => Promise<FreshReadSnapshot>);
  },
): Promise<ExecuteChainResult> {
  const episode = executor.store.getEpisode<Workflow2EpisodeState>(input.episode_id);
  if (!episode) {
    throw new Error(`Unknown WF2 episode '${input.episode_id}'.`);
  }
  const state = episode.state;
  const step1Row = executor.store.getChainStep(state.chain_id, 'submit_recruiter_scorecard');
  const step1AlreadyDone =
    step1Row != null &&
    (step1Row.status === 'succeeded' ||
      step1Row.status === 'dispatched' ||
      step1Row.status === 'reconciled');
  const step1WasAttempted =
    step1AlreadyDone ||
    (step1Row != null && (step1Row.status === 'intent' || step1Row.status === 'failed'));

  const moveRow = executor.store.getChainStep(state.chain_id, 'advance_to_hm_review');
  const moveAlreadyDone =
    moveRow != null &&
    (moveRow.status === 'succeeded' ||
      moveRow.status === 'dispatched' ||
      moveRow.status === 'reconciled');

  // If Step 1 already completed or was in-flight ('intent'/'failed') on a previous run,
  // do NOT require an incomplete scorecard on the pre-chain gate so Step 1 can reconcile
  // via SCORECARD_ALREADY_COMPLETE -> no_change and Coupled Step 2 can complete!
  const expectedState: ExpectedFreshState = {
    application_id: state.application_id,
    application_status: ['active', 'in_process'],
    stage_id: moveAlreadyDone ? state.to_stage_id : state.from_stage_id,
    ...(step1WasAttempted
      ? {}
      : { require_scorecard_incomplete_for_user_id: SAM_GREENHOUSE_USER_ID }),
  };

  // Mark episode in progress once execution starts
  executor.store.upsertEpisode<Workflow2EpisodeState>({
    episode_id: episode.episode_id,
    workflow: 'wf2_scorecard',
    application_id: state.application_id,
    candidate_id: state.candidate_id ?? null,
    job_id: state.job_id,
    stage_id: moveAlreadyDone ? state.to_stage_id : state.from_stage_id,
    status: 'CHAIN_D_IN_PROGRESS',
    state: {
      ...state,
      scorecard_submitted: step1AlreadyDone,
    },
    now: executor.nowIso(),
  });

  // Ensure linked approval has no conflicting draft_sha256 when executing multi-step chain
  const approval = input.approval ?? null;
  const steps = buildWorkflow2ChainDSteps(state, executor);

  const result = await executor.executeChain({
    chain_id: state.chain_id,
    episode_id: episode.episode_id,
    workflow: 'wf2_scorecard',
    approval,
    expected_state: expectedState,
    fresh_snapshot: input.fresh_snapshot,
    steps,
  });

  const updatedStep1 = executor.store.getChainStep(state.chain_id, 'submit_recruiter_scorecard');
  const step1SucceededNow =
    updatedStep1 != null &&
    (updatedStep1.status === 'succeeded' ||
      updatedStep1.status === 'dispatched' ||
      updatedStep1.status === 'reconciled');
  const scorecardIdNum = Number(updatedStep1?.provider_id);

  if (result.ok) {
    const rejectStepOut = result.step_results.enqueue_deliberated_rejection?.output as
      | Record<string, any>
      | undefined;

    executor.store.upsertEpisode<Workflow2EpisodeState>({
      episode_id: episode.episode_id,
      workflow: 'wf2_scorecard',
      application_id: state.application_id,
      candidate_id: state.candidate_id ?? null,
      job_id: state.job_id,
      stage_id: state.decision_branch === 'advance' ? state.to_stage_id : state.from_stage_id,
      status:
        state.decision_branch === 'advance'
          ? 'COMPLETED_ADVANCED_TO_HM_REVIEW'
          : 'COMPLETED_REJECTION_DELIBERATION_SCHEDULED',
      state: {
        ...state,
        scorecard_submitted: true,
        scorecard_id: Number.isFinite(scorecardIdNum) ? scorecardIdNum : null,
        coupled_step_completed: true,
        rejection_episode_id: rejectStepOut?.rejection_episode_id ?? null,
        rejection_timer_key: rejectStepOut?.timer_key ?? null,
      },
      now: executor.nowIso(),
    });
  } else {
    executor.store.upsertEpisode<Workflow2EpisodeState>({
      episode_id: episode.episode_id,
      workflow: 'wf2_scorecard',
      application_id: state.application_id,
      candidate_id: state.candidate_id ?? null,
      job_id: state.job_id,
      stage_id: state.from_stage_id,
      status: step1SucceededNow ? 'PARTIAL_STEP1_COMPLETE_STEP2_PENDING' : `FAILED_${result.status.toUpperCase()}`,
      state: {
        ...state,
        scorecard_submitted: step1SucceededNow,
        scorecard_id: Number.isFinite(scorecardIdNum) ? scorecardIdNum : null,
        coupled_step_completed: false,
      },
      now: executor.nowIso(),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Hold Exit Transitions: `AWAITING_MANUAL_NOTES` (ends_at + 95m -> 5 business days)
// ---------------------------------------------------------------------------

export interface ScheduleMissingNotesWatchInput {
  episode_id?: string;
  application_id: number;
  candidate_id?: number | null;
  candidate_name: string;
  job_id?: number;
  stage_id?: number;
  interview_ends_at: string;
  now?: string;
}

/**
 * Schedules the `ends_at + 95m` check for Granola screen notes (`wf2_missing_notes_prompt:{episode_id}`).
 */
export function scheduleMissingNotesWatch(
  store: SqliteCoordinatorStore,
  input: ScheduleMissingNotesWatchInput,
): { episode: EpisodeRow; timer: TimerRow } {
  const now = input.now ?? new Date().toISOString();
  const stageId = input.stage_id ?? RECRUITER_PHONE_SCREEN_STAGE_ID;
  const jobId = input.job_id ?? PILOT_JOB_ID;
  const episodeId = input.episode_id ?? `wf2:${input.application_id}:${stageId}`;
  const endsMs = Date.parse(input.interview_ends_at);
  if (!Number.isFinite(endsMs)) {
    throw new Error(`Invalid interview_ends_at timestamp: ${input.interview_ends_at}`);
  }
  const promptFireAt = new Date(endsMs + MISSING_NOTES_PROMPT_DELAY_MS).toISOString();

  const existing = store.getEpisode<Record<string, any>>(episodeId);
  const episode = store.upsertEpisode({
    episode_id: episodeId,
    workflow: 'wf2_scorecard',
    application_id: input.application_id,
    candidate_id: input.candidate_id ?? null,
    job_id: jobId,
    stage_id: stageId,
    status: existing?.status ?? 'AWAITING_GRANOLA_NOTES',
    state: {
      ...(existing?.state ?? {}),
      application_id: input.application_id,
      candidate_id: input.candidate_id ?? null,
      candidate_name: input.candidate_name,
      job_id: jobId,
      from_stage_id: stageId,
      interview_ended_at: input.interview_ends_at,
    },
    now,
  });

  const timerKey = `wf2_missing_notes_prompt:${episodeId}`;
  const timer = store.scheduleTimer({
    timer_key: timerKey,
    episode_id: episodeId,
    kind: 'wf2_missing_notes_prompt',
    fire_at: promptFireAt,
    payload: {
      episode_id: episodeId,
      application_id: input.application_id,
      candidate_name: input.candidate_name,
      job_id: jobId,
      stage_id: stageId,
      interview_ends_at: input.interview_ends_at,
    },
    now,
  });

  return { episode, timer };
}

/**
 * Fires at `ends_at + 95m` if no Granola transcript has arrived:
 * - If a scorecard is already complete in Greenhouse, transitions immediately to `CLOSED_MANUAL`.
 * - Otherwise transitions to `AWAITING_MANUAL_NOTES`, prompts Sam once via Slack DM,
 *   and schedules the 5-business-day expiration timer (`wf2_manual_notes_expiry:{episode_id}`).
 */
export async function handleMissingNotesPromptTimer(
  timer: TimerRow,
  executor: DeterministicExecutor,
  options: {
    fresh_snapshot?: FreshReadSnapshot | null;
    has_granola_transcript?: boolean;
  } = {},
): Promise<{
  outcome: 'prompted_sam' | 'closed_manual' | 'skipped_transcript_arrived';
  expiry_timer?: TimerRow;
}> {
  const nowIso = executor.nowIso();
  const payload = timer.payload as Record<string, any>;
  const episodeId = timer.episode_id;
  const applicationId = Number(payload.application_id);
  const candidateName = String(payload.candidate_name ?? `Application ${applicationId}`);
  const episode = executor.store.getEpisode<Record<string, any>>(episodeId);

  if (
    options.has_granola_transcript ||
    (episode &&
      (episode.status !== 'AWAITING_GRANOLA_NOTES' ||
        Boolean(episode.state?.missing_notes_prompted_at)))
  ) {
    executor.store.updateTimerStatus(timer.timer_key, 'cancelled', {
      reason: 'Granola transcript or scorecard draft already arrived (or Sam already prompted).',
      now: nowIso,
    });
    return { outcome: 'skipped_transcript_arrived' };
  }

  const snapshot =
    options.fresh_snapshot !== undefined
      ? options.fresh_snapshot
      : executor.freshReadFetcher
        ? await executor.freshReadFetcher(episodeId, { application_id: applicationId })
        : null;

  const manualCompleted = snapshot?.scorecards?.find(sc => {
    if (sc.status !== 'complete') return false;
    const uid =
      sc.interviewer_id ??
      sc.interviewer?.id ??
      sc.submitter_id ??
      sc.submitted_by?.id;
    return uid === SAM_GREENHOUSE_USER_ID || (uid == null && sc.application_id === applicationId);
  });

  if (manualCompleted) {
    executor.store.upsertEpisode({
      episode_id: episodeId,
      workflow: 'wf2_scorecard',
      application_id: applicationId,
      status: 'CLOSED_MANUAL',
      state: {
        ...(episode?.state ?? {}),
        closed_manual_reason: `Scorecard ${manualCompleted.id} submitted manually in Greenhouse.`,
      },
      now: nowIso,
    });
    executor.store.updateTimerStatus(timer.timer_key, 'cancelled', {
      reason: 'Scorecard already submitted manually in Greenhouse.',
      now: nowIso,
    });
    return { outcome: 'closed_manual' };
  }

  // Enforce <= 120s fresh-read gate before sending outward Slack prompt (fail closed if missing/stale)
  const freshCheck = verifyFreshState(
    snapshot,
    { application_id: applicationId },
    { nowMs: executor.nowMs() },
  );
  if (!freshCheck.ok) {
    throw new Error(
      `Cannot fire wf2_missing_notes_prompt without fresh Greenhouse snapshot (${freshCheck.code}: ${freshCheck.reason})`,
    );
  }

  // Send single prompt to Sam via Slack DM if SlackProvider is configured, journaling to ledger.jsonl
  if (executor.slack) {
    const dmText = `No Granola transcript found 95m after Recruiter Phone Screen with *${candidateName}* (App \`${applicationId}\`). Reply with your notes + rating or submit the scorecard manually in Greenhouse.`;
    const actionKey = `wf2_missing_notes_dm:${episodeId}`;
    const idempotencyKey = sha256(`${episodeId}:${actionKey}`);
    const draftSha = sha256(dmText);
    appendLedger(executor.dataDir, {
      kind: 'action',
      status: 'intent',
      service: 'slack',
      action_key: actionKey,
      episode_id: episodeId,
      idempotency_key: idempotencyKey,
      draft_sha256: draftSha,
      at: nowIso,
    });
    const sent = await executor.slack.sendMessage({
      channel: SAM_SLACK_USER_ID,
      text: dmText,
    });
    appendLedger(executor.dataDir, {
      kind: 'action',
      status: 'dispatched',
      service: 'slack',
      action_key: actionKey,
      episode_id: episodeId,
      idempotency_key: idempotencyKey,
      draft_sha256: draftSha,
      provider_id: sent.ts,
      at: nowIso,
    });
  }

  const expiryFireAt = addWorkingHours(
    nowIso,
    MANUAL_NOTES_EXPIRY_WORKING_HOURS,
    'America/Los_Angeles',
  );

  const expiryTimer = executor.store.scheduleTimer({
    timer_key: `wf2_manual_notes_expiry:${episodeId}`,
    episode_id: episodeId,
    kind: 'wf2_manual_notes_expiry',
    fire_at: expiryFireAt,
    payload: {
      episode_id: episodeId,
      application_id: applicationId,
      candidate_name: candidateName,
    },
    now: nowIso,
  });

  executor.store.upsertEpisode({
    episode_id: episodeId,
    workflow: 'wf2_scorecard',
    application_id: applicationId,
    status: 'AWAITING_MANUAL_NOTES',
    state: {
      ...(episode?.state ?? {}),
      missing_notes_prompted_at: nowIso,
      manual_notes_expiry_fire_at: expiryFireAt,
    },
    now: nowIso,
  });

  executor.store.updateTimerStatus(timer.timer_key, 'fired', { now: nowIso });

  return {
    outcome: 'prompted_sam',
    expiry_timer: expiryTimer,
  };
}

/**
 * Handles the 5-business-day expiration or manual scorecard submission check for `AWAITING_MANUAL_NOTES`,
 * transitioning the episode to `CLOSED_MANUAL`.
 */
export async function handleManualNotesExpiryOrCompletion(
  store: SqliteCoordinatorStore,
  input: {
    episode_id: string;
    timer_key?: string;
    manual_scorecard_id?: number | null;
    now?: string;
  },
): Promise<EpisodeRow> {
  const now = input.now ?? new Date().toISOString();
  const existing = store.getEpisode<Record<string, any>>(input.episode_id);
  const reason = input.manual_scorecard_id
    ? `Scorecard ${input.manual_scorecard_id} submitted manually in Greenhouse.`
    : 'Expired after 5 business days in AWAITING_MANUAL_NOTES without Granola transcript.';

  const updated = store.upsertEpisode({
    episode_id: input.episode_id,
    workflow: existing?.workflow ?? 'wf2_scorecard',
    application_id: existing?.application_id ?? null,
    candidate_id: existing?.candidate_id ?? null,
    job_id: existing?.job_id ?? null,
    stage_id: existing?.stage_id ?? null,
    status: 'CLOSED_MANUAL',
    state: {
      ...(existing?.state ?? {}),
      closed_manual_reason: reason,
    },
    now,
  });

  if (input.timer_key) {
    store.updateTimerStatus(input.timer_key, 'fired', { reason, now });
  }
  store.cancelTimersByPrefix(`wf2_missing_notes_prompt:${input.episode_id}`, reason, now);
  store.cancelTimersByPrefix(`wf2_manual_notes_expiry:${input.episode_id}`, reason, now);

  return updated;
}
