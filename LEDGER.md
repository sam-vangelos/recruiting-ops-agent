# Shared Scheduling Ledger (`ledger.jsonl`)

The ambient worker (`worker/pilot.mjs`) and the interactive Claude Code harness (`CLAUDE.md`) coordinate through one append-only JSON Lines file:

- **Default path**: `~/.recruiting-agents/scheduling-pilot/ledger.jsonl` (mode `0600` inside a `0700` directory, never committed to Git).
- **Implementation**: [`worker/ledger.mjs`](worker/ledger.mjs) (`append`, `read`, `dedupe`, `summarizeLedger`, `isActionDischarged`).

## Invariants

1. **Persist before dispatch**: Before the interactive session executes any outward step (sending an email, posting to Slack, scheduling or confirming in Greenhouse, modifying a calendar event), it appends an `action` record with `status: "intent"` and a deterministic `idempotency_key`. When the provider call completes, the session appends a second `action` record with the same `idempotency_key`, `status: "dispatched"`, and the returned `provider_id`.
2. **Idempotent deduplication**: `dedupe(records)` folds records by `idempotency_key` so the latest record for a given `idempotency_key` supersedes earlier ones while preserving earlier fields not overwritten.
3. **Never re-propose handled work**: At the start of each scan, `worker/pilot.mjs` reads and deduplicates `ledger.jsonl`, passes the ledger summary in `<scan_context>` to Claude, and strips any `next_actions` whose `action_key` (or `<episode_id>/<action_key>`) has been discharged by an `action` record or declined by an `approval` record before writing `checkpoint.json` and `DRAFTS.md`.
4. **Timer anchoring**: Wait rules (`12h_interviewer_chase`, `24h_candidate_nudge`, `48h_candidate_escalate`) start from `wait.since` in the ledger when present.

## Record kinds

Every line is one JSON object with `kind`, `idempotency_key` (non-empty string), and `at` (ISO-8601 UTC timestamp).

### 1. `action` — Outward step taken as Sam

Discharges `action_key` (and `<episode_id>/<action_key>`) unless `status === "failed"`.

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
- `status`: `"intent"` (written before dispatch) | `"dispatched"` (written after provider confirmation) | `"failed"`.
- `provider_id`: Gmail message ID, Greenhouse interview/application ID, Slack message `ts`, or Google Calendar event ID (`null` while `status === "intent"`).

### 2. `approval` — Sam approved or declined a worker proposal

When `decision === "declined"`, suppresses future worker proposals for `action_key`.

```json
{
  "kind": "approval",
  "idempotency_key": "apr:178089685004:screening-round:interviewer-acceptance-nudge",
  "at": "2026-10-16T22:59:00.000Z",
  "actor": "sam",
  "episode_id": "178089685004:screening-round-14297391004",
  "action_key": "178089685004:screening-round:interviewer-acceptance-nudge",
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
- `rule`: `"12h_interviewer_chase"` | `"24h_candidate_nudge"` | `"48h_candidate_escalate"` | `"custom"`.

### 4. `note` — Context for the next reader

```json
{
  "kind": "note",
  "idempotency_key": "note:177214133004:role-play-panel",
  "at": "2026-10-16T23:05:00.000Z",
  "episode_id": "177214133004:screening-round-14297391004",
  "text": "Await take-home submission around 10/22 before proposing role-play slots."
}
```
