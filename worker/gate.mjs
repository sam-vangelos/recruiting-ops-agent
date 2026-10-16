#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const JOB_ID = '5149015004';
export const ALLOWED = [
  'ToolSearch',
  'mcp__claude_ai_Gmail__search_threads',
  'mcp__claude_ai_Gmail__get_thread',
  'mcp__claude_ai_Gmail__get_message',
  'mcp__claude_ai_Gmail__list_drafts',
  'mcp__claude_ai_Gmail__get_draft',
  'mcp__claude_ai_Google_Calendar__list_calendars',
  'mcp__claude_ai_Google_Calendar__list_events',
  'mcp__claude_ai_Google_Calendar__get_event',
  'mcp__claude_ai_Slack__slack_search_public_and_private',
  'mcp__greenhouse-recruiter__get_my_job',
  'mcp__greenhouse-recruiter__search_my_interviews',
];

export function permitted(name, input = {}) {
  if (!ALLOWED.includes(name)) return false;
  if (name.endsWith('__get_my_job')) return String(input.id) === JOB_ID;
  if (name.endsWith('__search_my_interviews')) {
    const ids = Array.isArray(input.job_ids) ? input.job_ids : String(input.job_ids ?? '').split(',');
    return ids.length === 1 && String(ids[0]) === JOB_ID;
  }
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
