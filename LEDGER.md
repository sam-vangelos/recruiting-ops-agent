# Shared Scheduling Ledger (`ledger.jsonl`) & Authoritative SQLite Coordinator (`state.sqlite`)

The ambient worker (`worker/pilot.mjs`), the deterministic in-process executor (`worker/executor-tick.mjs` / `src/executor/index.ts`), and the interactive Claude Code harness (`CLAUDE.md`) coordinate through two local stores in `~/.recruiting-agents/scheduling-pilot/` (mode `0700` directory, `0600` files, never committed to Git):

- **Authoritative SQLite Coordinator (`state.sqlite` in WAL mode)**: Implemented in [`src/store/sqlite.ts`](src/store/sqlite.ts). Owns the single-writer execution lock (`BEGIN IMMEDIATE` / `writer_lease`), episode state (`episodes`), multi-step chain state (`chain_steps`), authenticated 16-hex SHA-256 proposal approvals (`approvals`), and local deliberation/reminder timers (`timers`).
- **Backward-Compatible Shared Ledger (`ledger.jsonl`)**: Implemented in [`worker/ledger.mjs`](worker/ledger.mjs) (`append`, `read`, `dedupe`, `dischargedKeys`, `summarizeLedger`, `isActionDischarged`) and consumed by [`.claude/hooks/send-gate.mjs`](.claude/hooks/send-gate.mjs).

## Invariants

1. **Persist before dispatch**: Before the Executor or interactive session executes any outward step (sending an email, posting to Slack, scheduling or confirming in Greenhouse, modifying a calendar event), it appends an `action` record with `status: "intent"` and a deterministic `idempotency_key` to `ledger.jsonl` (and `chain_steps` in `state.sqlite`). When the provider call completes, it appends a second `action` record with the same `idempotency_key`, `status: "dispatched"`, and the returned `provider_id`.
2. **Idempotent monotonic deduplication**: `dedupe(records)` folds records by `idempotency_key` so the latest record for a given `idempotency_key` supersedes earlier ones while preserving earlier fields not overwritten and enforcing monotonic status (`dispatched` / `succeeded` / `reconciled` is never downgraded to `intent`).
3. **Discharged work vs. unresolved intents**: Only `action` records with `status: "dispatched"` (or `"succeeded"` / `"reconciled"`) count as discharged work in `dischargedKeys()` and `summarizeLedger().discharged_action_keys`. An interrupted `status: "intent"` with no matching terminal record surfaces in `summarizeLedger().unresolved_intents` (`reconciliation_status: "unresolved_intent"`) and `unresolved_action_keys` so it is reconciled against live state before any retry.
4. **Never re-propose handled work**: At the start of each scan, `worker/pilot.mjs` reads and deduplicates `ledger.jsonl`, passes the ledger summary in `<scan_context>` to Claude, and strips any `next_actions` whose `action_key` (or `<episode_id>/<action_key>`) has been discharged by a terminal `action` record or declined by an `approval` record before writing `checkpoint.json` and `DRAFTS.md`.
5. **Timer anchoring**: Wait rules (`12h_interviewer_chase`, `24h_interviewer_chase`, `24h_scorecard_chase`, `24h_candidate_nudge`, `48h_candidate_escalate`, `wf4_deliberation`) start from `wait.since` in the ledger and `timers.fire_at` in `state.sqlite`.

## Record kinds

Every line is one JSON object with `kind`, `idempotency_key` (non-empty string), and `at` (ISO-8601 UTC timestamp).

### 1. `action` — Outward step taken as Sam

Discharges `action_key` (and `<episode_id>/<action_key>`) only when `status` is `"dispatched"`, `"succeeded"`, or `"reconciled"`. An un-dispatched `status: "intent"` surfaces as `unresolved_intent` requiring reconciliation before retry.

```json
{
  "kind": "action",
  "idempotency_key": "act:178089685004:screening-round:interviewer-acceptance-nudge:1",
  "at": "2026-10-16T23:00:00.000Z",
  "actor": "sam",
  "episode_id": "178089685004:screening-round-14297391004",
  "action_key": "178089685004:screening-round:interviewer-acceptance-nudge",
  "service": "slack",
  "status": "dispatched",
  "provider_id": "1792191600.000100",
  "summary": "Sent 12-hour interviewer acceptance check on Slack"
}
```

- `actor`: `"sam"` (default).
- `episode_id`: Application ID + interview step when known, else `gmail:<thread_id>` or `slack:<channel>:<ts>`.
- `action_key`: Episode + action kind discharged by this step.
- `service`: `"gmail"` | `"greenhouse"` | `"slack"` | `"calendar"`.
- `status`: `"intent"` (written before dispatch) | `"dispatched"` (written after provider confirmation) | `"succeeded"` | `"reconciled"` | `"failed"`.
- `provider_id`: Gmail message ID, Greenhouse interview/application/note ID, Slack message `ts`, or Google Calendar event ID (`null` while `status === "intent"`).

### 2. `approval` — Sam approved or declined a worker proposal

When `decision === "declined"`, suppresses future worker proposals for `action_key`. When `decision === "approved"`, binds to the 16-hex SHA-256 `proposal_hash` in `state.sqlite`.

```json
{
  "kind": "approval",
  "idempotency_key": "apr:178089685004:screening-round:interviewer-acceptance-nudge",
  "at": "2026-10-16T22:59:00.000Z",
  "actor": "sam",
  "episode_id": "178089685004:screening-round-14297391004",
  "action_key": "178089685004:screening-round:interviewer-acceptance-nudge",
  "proposal_hash": "0123456789abcdef",
  "decision": "approved",
  "reason": "Approved combined Slack nudge"
}
```

### 3. `wait` — Active waiting condition and timer rule

Records what is waiting on whom since when, and the rule that ends the wait. Appending a record with the same `idempotency_key` and `resolved_at` set closes the timer.

```json
{
  "kind": "wait",
  "idempotency_key": "wait:189889263004:12h_interviewer_chase",
  "at": "2026-10-16T15:49:20.000Z",
  "episode_id": "gmail:1a11da1f6900f204",
  "action_key": "gmail:1a11da1f6900f204:interviewer-acceptance-nudge",
  "waiting_on": "interviewer",
  "target": "khiem.doan@turing.com",
  "since": "2026-10-16T15:49:20.000Z",
  "rule": "12h_interviewer_chase",
  "due_at": "2026-10-17T03:49:20.000Z",
  "resolved_at": null
}
```

- `waiting_on`: `"interviewer"` | `"candidate"` | `"hm"` | `"sam"`.
- `rule`: `"12h_interviewer_chase"` | `"24h_interviewer_chase"` | `"24h_scorecard_chase"` | `"24h_candidate_nudge"` | `"48h_candidate_escalate"` | `"wf4_deliberation"` | `"custom"`.

### 4. `note` / `handoff` — Context for the next reader

```json
{
  "kind": "note",
  "idempotency_key": "note:177214133004:role-play-panel",
  "at": "2026-10-16T23:05:00.000Z",
  "episode_id": "177214133004:screening-round-14297391004",
  "text": "Await take-home submission around 10/22 before proposing role-play slots."
}
```
