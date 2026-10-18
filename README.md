# scheduling-agent

Home of Sam Vangelos's interview scheduling agent at Turing (`sam-vangelos/scheduling-agent`, Linear project `P-CLO-10`, issue `CLO-555`). The plan of record is the Linear project document "Roadmap — scheduling agent (reconciled 2026-10-18)" and the project milestones M1–M5: https://linear.app/turing-recruitment/document/roadmap-scheduling-agent-reconciled-2026-10-18-c99894cbf50e

This repository holds two operating modes that share one rule set ([`JOB.md`](JOB.md)) and one append-only ledger (`~/.recruiting-agents/scheduling-pilot/ledger.jsonl`, specified in [`LEDGER.md`](LEDGER.md)):

1. **Ambient worker ([`worker/`](worker/))**: Runs every 30 minutes via `launchd` using Sam's Claude Code login, sweeps Gmail, Google Calendar, Slack, and `greenhouse-recruiter`, and writes verified local proposals to `~/.recruiting-agents/scheduling-pilot/checkpoint.json` and `DRAFTS.md`. The worker is read-only by construction across three layers: an explicit `--allowedTools` read allowlist, `--disallowedTools` write deny patterns, and the `PreToolUse` gate hook ([`worker/gate.mjs`](worker/gate.mjs)) with `"onFailure": "block"`.
2. **Interactive harness ([`CLAUDE.md`](CLAUDE.md))**: Starting a Claude Code session in this directory boots straight into scheduling mode. On startup it reads `ledger.jsonl`, `checkpoint.json`, and `DRAFTS.md`, reports every candidate in play with their current step from [`JOB.md`](JOB.md) and what is waiting on whom since when, surfaces any worker proposal Sam has not yet accepted or declined, and then drives scheduling as Sam with his approval.

Nothing the interactive session does is invisible to the next ambient scan, and nothing the worker proposes is stale relative to what the session already did.

## Repository layout

- [`JOB.md`](JOB.md) — Single source of truth for the ten scheduling steps, scope boundaries, and approval rules.
- [`LEDGER.md`](LEDGER.md) — Schema and idempotency contract for `~/.recruiting-agents/scheduling-pilot/ledger.jsonl`.
- [`CLAUDE.md`](CLAUDE.md) — Interactive Claude Code session harness (operating section generated from `JOB.md`).
- [`tools/render.mjs`](tools/render.mjs) — Renders both [`worker/prompt.md`](worker/prompt.md) and the operating section of [`CLAUDE.md`](CLAUDE.md) from [`JOB.md`](JOB.md).
- [`worker/`](worker/) — Ambient read-only runner (`pilot.mjs`), `PreToolUse` gate (`gate.mjs`), Greenhouse + Calendar roster builder (`roster.mjs`), shared ledger module (`ledger.mjs`), second-model shadow runner (`shadow.mjs`), generated prompt (`prompt.md`), and test suite (`*.test.mjs`).
- [`planner/`](planner/) — Pure TypeScript slot/payload planner moved from `recruiting-agents/agents/scheduling` (being rebuilt to match `JOB.md`; where they disagree, `JOB.md` wins).
- [`launchd/`](launchd/) — LaunchAgent templates for `.worker` (every 30m), `.health` (every 5m), and `.shadow-haiku` (8x/day through 2026-10-23, `CLO-550`).

## Where recruiting playbooks and reference files live

Playbooks and reference documents stay in `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents` and are referenced by absolute path so copies never drift:

- `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/CLAUDE.md`
- `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/playbooks/candidate-comms.md`
- `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/playbooks/greenhouse.md`
- `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/playbooks/working-with-sam.md`
- `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/reference/people-and-ids.md`
- `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/reference/greenhouse.md`

Runtime candidate data and ledgers live in `~/.recruiting-agents/scheduling-pilot/` (`0700` directory, `0600` files) and are never committed to Git or pasted into Linear.

## Commands and verification gate

Render prompts from `JOB.md` (or verify freshness with `--check`):

```sh
node tools/render.mjs
node tools/render.mjs --check
```

Install planner devDependencies and run the full test and typecheck gate:

```sh
npm --prefix planner install
node --test worker/*.test.mjs && npm --prefix planner test && npm --prefix planner run typecheck
```

## Install and cutover (`~/.recruiting-agents/scheduling-pilot/app/`)

The three `launchd` jobs (`com.recruiting-agents.scheduling-pilot.worker`, `.health`, `.shadow-haiku`) execute the frozen copy in `~/.recruiting-agents/scheduling-pilot/app/`. The Haiku shadow (`~/.recruiting-agents/scheduling-pilot-shadow-haiku/`) runs until 2026-10-23 (`CLO-550`) and must not be stopped early.

To cut over the installed worker after the gate is green and Sam approves:

```sh
cp worker/pilot.mjs worker/gate.mjs worker/shadow.mjs worker/ledger.mjs worker/roster.mjs worker/prompt.md ~/.recruiting-agents/scheduling-pilot/app/
launchctl kickstart gui/$(id -u)/com.recruiting-agents.scheduling-pilot.worker
node ~/.recruiting-agents/scheduling-pilot/app/pilot.mjs status
```

## Design decisions logged on CLO-555

- **Harness boot ordering (day view first)**: On session start, `CLAUDE.md` builds the Greenhouse + Google Calendar roster (`worker/roster.mjs`), presents today's candidate events in chronological order with interviewer acceptance and candidate confirmation state (with Sam's own Calendly screens shown as roster facts; open question on `CLO-555` whether the agent owns that step), followed by all candidates in play with their `JOB.md` step, roster discrepancies, and unreviewed worker proposals from `DRAFTS.md`.
- **Two-phase action persistence in `ledger.jsonl`**: Outward session steps append an `action` record with `status: "intent"` and `idempotency_key` before dispatch, then append `status: "dispatched"` with `provider_id` on completion; `dedupe()` folds by `idempotency_key` (latest record wins) so interrupted sends remain visible on restart while completed ones carry their provider ID.
- **Defense-in-depth proposal suppression**: The worker both injects the deduped ledger state into `<scan_context>` on `claude` stdin and deterministically filters out any `next_actions` whose `action_key` is already discharged by an `action` record or declined by an `approval` record before writing `checkpoint.json` and `DRAFTS.md`.
