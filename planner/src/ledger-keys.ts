/**
 * Idempotency keys for every outward step (WORKFLOW.md, "Idempotency and the ledger"):
 * `<step>:<application_id>:<job_interview_id>:<attempt>`. The spike's `Ledger` stores them.
 */

export const LEDGER_STEPS = [
  'hold-create',
  'hold-update',
  'candidate-hold-reply',
  'candidate-add',
  'candidate-confirmation',
  'gh-interview-create',
  'gh-note',
  'reminder',
  // Added beyond the brief's list: these are outward too, and every outward step carries a key.
  'candidate-alternative-times',
  'escalation',
] as const;
export type LedgerStep = (typeof LEDGER_STEPS)[number];

const ID = /^[A-Za-z0-9_-]+$/;

export function ledgerKey(step: LedgerStep, applicationId: string, jobInterviewId: string, attempt: number): string {
  if (!LEDGER_STEPS.includes(step)) throw new Error(`unknown ledger step ${JSON.stringify(step)}`);
  if (!ID.test(applicationId)) throw new Error(`applicationId ${JSON.stringify(applicationId)} is not a plain id`);
  if (!ID.test(jobInterviewId)) throw new Error(`jobInterviewId ${JSON.stringify(jobInterviewId)} is not a plain id`);
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`attempt must be a whole number from 1; got ${attempt}`);
  return `${step}:${applicationId}:${jobInterviewId}:${attempt}`;
}
