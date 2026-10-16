#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.recruiting-agents/scheduling-pilot');
export const LEDGER_FILE = 'ledger.jsonl';
export const LEDGER_KINDS = ['action', 'approval', 'wait', 'note'];

export function ledgerPath(target = DEFAULT_DATA_DIR) {
  const resolved = path.resolve(target);
  return resolved.endsWith('.jsonl') ? resolved : path.join(resolved, LEDGER_FILE);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(dir).isSymbolicLink()) {
    throw new Error('Ledger directory must not be a symbolic link.');
  }
  fs.chmodSync(dir, 0o700);
}

export function validateRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Ledger record must be a JSON object.');
  }
  const { kind, idempotency_key: idempotencyKey } = input;
  if (!LEDGER_KINDS.includes(kind)) {
    throw new Error(`Invalid ledger record kind: ${JSON.stringify(kind)}. Expected one of ${LEDGER_KINDS.join(', ')}.`);
  }
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
    throw new Error('Ledger record requires a non-empty string idempotency_key.');
  }
  const at = input.at ?? new Date().toISOString();
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) {
    throw new Error(`Invalid ledger timestamp at: ${JSON.stringify(input.at)}.`);
  }
  const base = { ...input, kind, idempotency_key: idempotencyKey.trim(), at };

  if (kind === 'action') {
    if (typeof base.episode_id !== 'string' || !base.episode_id.trim()) {
      throw new Error('action record requires a non-empty episode_id.');
    }
    if (typeof base.action_key !== 'string' || !base.action_key.trim()) {
      throw new Error('action record requires a non-empty action_key.');
    }
    base.actor ??= 'sam';
    base.status ??= base.provider_id ? 'dispatched' : 'intent';
    if (!['intent', 'dispatched', 'failed'].includes(base.status)) {
      throw new Error(`Invalid action status: ${JSON.stringify(base.status)}.`);
    }
    base.provider_id ??= null;
    if (base.status === 'dispatched' && (typeof base.provider_id !== 'string' || !base.provider_id.trim())) {
      throw new Error('dispatched action record requires a non-empty string provider_id.');
    }
    return base;
  }

  if (kind === 'approval') {
    if (typeof base.action_key !== 'string' || !base.action_key.trim()) {
      throw new Error('approval record requires a non-empty action_key.');
    }
    if (!['approved', 'declined'].includes(base.decision)) {
      throw new Error(`approval record decision must be "approved" or "declined"; got ${JSON.stringify(base.decision)}.`);
    }
    base.actor ??= 'sam';
    return base;
  }

  if (kind === 'wait') {
    if (typeof base.episode_id !== 'string' || !base.episode_id.trim()) {
      throw new Error('wait record requires a non-empty episode_id.');
    }
    if (typeof base.waiting_on !== 'string' || !base.waiting_on.trim()) {
      throw new Error('wait record requires waiting_on.');
    }
    if (typeof base.since !== 'string' || !Number.isFinite(Date.parse(base.since))) {
      throw new Error('wait record requires a valid ISO timestamp in since.');
    }
    if (typeof base.rule !== 'string' || !base.rule.trim()) {
      throw new Error('wait record requires a non-empty rule.');
    }
    base.resolved_at ??= null;
    return base;
  }

  if (kind === 'note') {
    if (typeof base.text !== 'string' || !base.text.trim()) {
      throw new Error('note record requires non-empty text.');
    }
    return base;
  }

  return base;
}

export function append(target, record) {
  const file = ledgerPath(target);
  ensurePrivateDir(path.dirname(file));
  const normalized = validateRecord(record);
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(normalized) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return normalized;
}

export function read(target = DEFAULT_DATA_DIR) {
  const file = ledgerPath(target);
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const records = [];
  for (const [index, raw] of content.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      throw new Error(`Malformed JSON in ${file} at line ${index + 1}: ${e.message}`);
    }
    records.push(validateRecord(parsed));
  }
  return records;
}

export function dedupe(recordsOrTarget = DEFAULT_DATA_DIR) {
  const records = Array.isArray(recordsOrTarget) ? recordsOrTarget : read(recordsOrTarget);
  const byKey = new Map();
  for (const raw of records) {
    const record = validateRecord(raw);
    const prior = byKey.get(record.idempotency_key);
    byKey.set(record.idempotency_key, prior ? { ...prior, ...record } : record);
  }
  return [...byKey.values()];
}

function keyVariants(episodeId, actionKey) {
  const keys = [];
  if (typeof actionKey === 'string' && actionKey.trim()) {
    const trimmed = actionKey.trim();
    keys.push(trimmed);
    if (typeof episodeId === 'string' && episodeId.trim()) {
      const ep = episodeId.trim();
      if (!trimmed.startsWith(`${ep}/`)) keys.push(`${ep}/${trimmed}`);
    }
  }
  return keys;
}

export function summarizeLedger(recordsOrTarget = DEFAULT_DATA_DIR) {
  const entries = dedupe(recordsOrTarget);
  const discharged = new Set();
  const declined = new Set();
  const approved = new Set();
  const activeWaits = [];
  const notes = [];

  for (const entry of entries) {
    if (entry.kind === 'action' && entry.status !== 'failed') {
      for (const k of keyVariants(entry.episode_id, entry.action_key)) discharged.add(k);
    } else if (entry.kind === 'approval') {
      const targetSet = entry.decision === 'declined' ? declined : approved;
      for (const k of keyVariants(entry.episode_id, entry.action_key)) targetSet.add(k);
    } else if (entry.kind === 'wait' && !entry.resolved_at) {
      activeWaits.push(entry);
    } else if (entry.kind === 'note') {
      notes.push(entry);
    }
  }

  return {
    entries,
    discharged_action_keys: [...discharged],
    declined_action_keys: [...declined],
    approved_action_keys: [...approved],
    active_waits: activeWaits,
    notes,
  };
}

export function isActionDischarged(summary, episodeId, actionKey) {
  if (!summary) return false;
  const suppressed = new Set([
    ...(summary.discharged_action_keys ?? []),
    ...(summary.declined_action_keys ?? []),
  ]);
  return keyVariants(episodeId, actionKey).some(k => suppressed.has(k));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  let dataDir = DEFAULT_DATA_DIR;
  let recordJson = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--data-dir') dataDir = path.resolve(args[++i]);
    else if (args[i] === '--record') recordJson = args[++i];
    else throw new Error(`Unknown argument: ${args[i]}. Commands: read, dedupe, summary, append.`);
  }
  if (command === 'read') console.log(JSON.stringify(read(dataDir), null, 2));
  else if (command === 'dedupe') console.log(JSON.stringify(dedupe(dataDir), null, 2));
  else if (command === 'summary') console.log(JSON.stringify(summarizeLedger(dataDir), null, 2));
  else if (command === 'append') {
    if (!recordJson) throw new Error('append requires --record <json>.');
    console.log(JSON.stringify(append(dataDir, JSON.parse(recordJson)), null, 2));
  } else {
    throw new Error('Commands: read, dedupe, summary, append.');
  }
}
