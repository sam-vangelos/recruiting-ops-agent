#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const JOB_ID = '5149015004';
export const ALLOWED = [
  'ToolSearch',
  'mcp__claude_ai_Gmail__search_threads',
  'mcp__claude_ai_Gmail__get_thread',
  'mcp__claude_ai_Gmail__get_message',
  'mcp__claude_ai_Google_Calendar__list_calendars',
  'mcp__claude_ai_Google_Calendar__list_events',
  'mcp__claude_ai_Google_Calendar__get_event',
  'mcp__claude_ai_Slack__slack_search_public_and_private',
  'mcp__greenhouse-recruiter__get_my_job',
  'mcp__greenhouse-recruiter__search_my_applications',
  'mcp__greenhouse-recruiter__search_my_candidates',
  'mcp__greenhouse-recruiter__search_my_interviews',
  'mcp__greenhouse-recruiter__search_my_attachments',
];
const idList = raw => (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map(x => String(x ?? '').trim());
// A non-empty list of non-empty ids; an absent, empty or blank list is no scope at all.
const someIds = raw => raw !== undefined && raw !== null && idList(raw).length > 0 && idList(raw).every(Boolean);
const pilotJobOnly = raw => { const ids = idList(raw); return ids.length === 1 && ids[0] === JOB_ID; };

export function permitted(name, input = {}) {
  if (!ALLOWED.includes(name)) return false;
  if (!input || typeof input !== 'object') return false;
  if (name.includes('greenhouse-recruiter') && input.scope_handle !== undefined) return false;
  if (name.endsWith('__get_my_job')) return String(input.id) === JOB_ID;
  if (name.endsWith('__search_my_interviews') || name.endsWith('__search_my_applications')) {
    const ids = Array.isArray(input.job_ids) ? input.job_ids : String(input.job_ids ?? '').split(',');
    return ids.length === 1 && String(ids[0]) === JOB_ID;
  }
  // Unscoped candidate or attachment searches are org-wide reads.
  if (name.endsWith('__search_my_candidates')) {
    const job = input.job_ids ?? input.job_id;
    return job !== undefined && job !== null ? pilotJobOnly(job) : someIds(input.candidate_ids);
  }
  if (name.endsWith('__search_my_attachments')) return someIds(input.application_ids) || someIds(input.candidate_ids);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let allow = false;
  try {
    const request = JSON.parse(readFileSync(0, 'utf8'));
    allow = permitted(request.tool_name, request.tool_input);
  } catch { /* Malformed hook requests are denied. */ }
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: allow ? 'allow' : 'deny',
    permissionDecisionReason: allow ? 'Exact read-only pilot allowlist.' : 'Outside the read-only scheduling pilot scope.',
  } }));
}
