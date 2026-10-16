# Desktop scheduling pilot

One read-only Claude run scans Field Engineer scheduling (job `5149015004`), reconciles open episodes, and produces local proposals. It uses Sam's existing Claude subscription login and the already connected Gmail, Calendar, Slack and `greenhouse-recruiter` tools. Nothing sends messages, creates Gmail drafts, changes calendars, or changes candidate records.

This directory supplies the worker and health check. It does not install or enable a schedule. An operator installs a frozen copy of `pilot.mjs`, `gate.mjs`, and `prompt.md` in the private runtime directory and configures two separate launchd jobs: one worker every 30 minutes, one health check every five minutes. Use absolute paths to Node and Claude. They run while the desktop is available; they cannot wake an unavailable Mac or deliver alerts while it is off.

## Commands

```sh
node pilot.mjs init --interval-minutes 30
node pilot.mjs run --claude /absolute/path/to/claude
node pilot.mjs health --notify
node pilot.mjs status
node pilot.mjs recover-lock
```

Every command accepts `--data-dir /absolute/private/directory`. Default: `~/.recruiting-agents/scheduling-pilot`. `init` is idempotent and preserves the initial interval and installed time. The launchd interval must match `config.json`; edit neither independently. Tests inject a fictional CLI with `--claude`; production uses the installed executable. No model override or API key is used. Environment overrides for Anthropic API credentials/providers are removed from the child's environment; the existing subscription login is used.

`run` exits nonzero on failed or incomplete verification. `health` and `status` return sanitized JSON with health and file paths; they do not print candidate content. `status` is read-only and reports the saved `monitor_checked_at` separately from its current assessment. Only `health` updates the monitor heartbeat and notification deduplication. `--notify` requests a macOS notification only when a new health alarm appears. A successful notification request is not proof that the OS displayed it; notification settings can suppress it. Recovery resets notification deduplication. The same persistent alarm is not repeatedly requested.

`recover-lock` removes only a lock whose recorded owner and child PIDs are absent. It refuses live/unknown owners, including PID reuse, rather than guessing that they are stale. Use it as an operator action after inspecting a stopped worker, then allow the next scheduled run. It is not run automatically. A scheduled `run` reclaims a lock by itself only when both recorded PIDs are gone and the lock is older than one configured interval; it records the reclaimed owner as `reclaimed_lock` in `state.json` for that run. Any other existing lock (a live owner or child, a recent lock, or an unreadable one) blocks the run, which writes `blocked.json` with the time and owner and leaves `state.json` untouched; health reports a block newer than the last successful scan.

## Local outputs

All runtime files are private (`0600` inside a `0700` directory), outside Git:

- `DRAFTS.md`: the latest verified scheduling proposals, never automatically executed.
- `checkpoint.json`: authoritative verified scan, any `partial` sources, observed episode facts, pending work, resolved receipt references, and proposal changes. Open episodes must survive subsequent scans; an omitted open episode rejects the scan. A closed episode needs explicit current evidence of resolution and no pending actions.
- `HEALTH.md`, `health.json`: attention state and monitor checked time.
- `state.json`: run start, last output progress, completion, last verified success, error, any lock reclaimed by this run (`reclaimed_lock`), and any housekeeping failure (`housekeeping_error`).
- `blocked.json`: the time and lock owner of the latest run that a lock blocked.
- `last-verification.json`: independent receipt verification, including errors, `warnings` (uncited reads that did not verify), `partial` sources, and recovered reads.
- `latest-stream.jsonl`, `latest-stderr.txt`: the latest private diagnostic output. These may contain candidate information. Do not commit or share them.
- `last-good-stream.jsonl`: supporting stream for the last verified scan, retained when subsequent scans fail.
- `runs/`: per-run copies of the stream and, when the run reached verification, its verification, named by run start time (`<started_at>-stream.jsonl`, `<started_at>-verification.json`), pruned to the newest 10 runs. These carry the same candidate information as the latest files.
- `settings.json`: generated exact read permissions and hook settings, with user plugins disabled for the invocation. No credentials are copied.

Claude Code persists oversized tool results outside this directory, under `~/.claude/projects/<data directory with / and . replaced by ->/<session>/tool-results/`. After every run, success or failure, the worker deletes the regular files under those `tool-results` directories and then any directories the deletion left empty; it touches nothing else there.

Failed scans leave the last good checkpoint and drafts intact and become attention states. A partial scan, where the report marks one to three sources `complete: false` with notes explaining why, still writes the checkpoint and drafts; `DRAFTS.md` names the unread sources under the scan time, and health reports attention until a complete scan follows. A scan with all four sources incomplete fails. An empty completed scan cannot silently remove unresolved episodes. Repeated action keys with identical draft/action text do not count as new work when only timestamps or receipt IDs change. This is textual deduplication: an unnecessary model paraphrase can still appear as a change. The prompt asks it to retain unchanged wording.

## Evidence and limits

The CLI runs with `dontAsk`, no permission prompts, no session persistence, no Chrome, no slash commands, and only ToolSearch plus an exact list of MCP read tools. Explicit mutation deny patterns in both invocation arguments and permissions hide known write tools even when user settings grant them. A PreToolUse hook denies every other tool and enforces the pilot job on Greenhouse reads; it is generated with `"onFailure": "block"` (Claude Code 2.1.295 or later), so a hook that crashes or times out blocks the tool call instead of letting it through. Built-in shell, file, browser, subagent, and scheduling tools are unavailable. Existing user settings remain loaded to obtain the already working subscription connectors; enabled user plugins are disabled in the invocation settings. User hooks should remain separately reviewed when global configuration changes.

A zero exit code or a model's claim of success is insufficient. The verifier requires successful actual tool-call results from all four services, job and interview reads, Gmail searches and full bodies for returned threads (or every metadata-listed message through the exact get_message read tool), current tool evidence on each fact and proposal, and completed pagination. It recognizes Gmail tokens, Slack prose cursors, and Greenhouse offset slices, including nested MCP JSON content envelopes, Slack's structured Markdown search-result envelope, and the live empty answers (Gmail's `{}` and Slack's `No results found.` body with its terminal pagination line). Metadata-only long threads require matching full message bodies for every unique listed ID; snippets cannot satisfy this check. The verifier does not reconcile a thread's `messageCount` against its returned messages: `get_thread` can leave out unsent drafts, so the prompt has the model record any gap as an unknown ("n of m messages returned") instead of enumerating the drafts folder. `list_drafts` and `get_draft` remain allowed reads. Existing drafts indicate user ownership and are never approval to act. All draft creation, editing, sending and deletion tools remain denied. Earlier read errors or oversized responses may recover only through a later recognized, fully paginated read of the same query; page-size controls are excluded from query comparison. Recovered reads remain diagnostics and cannot serve as evidence. A read that neither verifies nor recovers is a warning when nothing in the report cites it, and an error when coverage or episode evidence cites its receipt ID. Citations by tool name bind only to verified receipts, so a source still needs at least one verified read of each required kind. Missing required reads, unexplained incomplete coverage, missing or unmatched receipts, ungrounded facts, permission denials, and unauthorized attempts reject the scan. The prompt requests 10–20 results per page without capping total results.

The model cites exact visible tool names; code binds them to actual successful receipts from this run. These links prove that a source was read. They do not independently prove every inferred statement or the completeness of the model's search strategy. Semantic scheduling judgment remains a draft requiring Sam's review. Mailbox discovery is limited to inbound scheduling, current pilot participants, and pending episodes; cold-outreach and job-alert inventories are outside this pilot. Initial discovery looks back seven days; later scans start two hours before the last successful scan, and every Gmail and Slack `after:` filter uses that instant's Pacific calendar date (`scan_since_date_pacific` in the scan context), while always revisiting open episodes and the next 14 days of calendars. Historical conversations outside this scope are not exhaustively mined by the pilot.

## Stopped-worker detection

The health job is independent of the worker. It detects failed reads immediately, output stalled for 15 minutes, a dead process's lock, or no successful scan within two configured intervals plus ten minutes. A never-started worker is measured from installation. A running worker that stops producing progress is terminated after 15 minutes (with forced termination after another minute); shutdown signals target only that run's child process group.

A stale `HEALTH.md` checked time means the health job itself may have stopped. Two jobs on one Mac cannot detect the Mac being asleep/off or both jobs being unloaded in real time. Inspect the latest health timestamp after returning to the Mac; an independent always-on monitor would be a separate later capability.

## Shadow testing

`shadow.mjs` runs the same read-only scan with a second model and scores each of its runs against the live pilot, so the two models can be compared on the same scheduling traffic. It sits beside `pilot.mjs`, `gate.mjs` and `prompt.md` in the installed app directory and runs that same frozen copy. The first shadow model is `claude-haiku-5-5`.

```sh
node shadow.mjs cycle --model claude-haiku-5-5 --shadow-dir /abs/shadow --live-dir /abs/live --claude /abs/claude
node shadow.mjs pair --shadow-dir /abs/shadow --live-dir /abs/live [--out /abs/dir] [--window-minutes 45]
```

`cycle` sets `PILOT_MODEL` before it loads `pilot.mjs`, because the pilot fixes its model when that module loads, and it refuses to run if `pilot.mjs` was already loaded with another model. It then performs one ordinary pilot `run` in the shadow data directory and pairs the result. A shadow run that fails still exits 0, since the failure is one of the outcomes being scored. `cycle` exits nonzero only for harness errors: bad arguments, an unreadable live `runs/` directory, overlapping directories, or a run that left no record to score, such as one blocked by an earlier shadow run's lock. `pair` takes the newest shadow run and matches it to the live run that started nearest before it within the window (45 minutes by default), then to the nearest one after it; with neither, it records no live run and scores the shadow side alone. It only reads the live directory.

Each pairing writes these files under `--out` (default `<shadow-dir>/shadow`):

- `pairs/<shadow run>/shadow-verification.json` and `live-verification.json`: copies of each run's verification, taken on every cycle because `pilot.mjs` prunes `runs/` to the newest 10 runs. They hold candidate content, as the originals do.
- `pairs/<shadow run>/meta.json`: run ids, start times, and each stream's model, result status, cost, duration and turn count, read from the stream without copying it.
- `pairs/<shadow run>/score.json`, also kept as one line of `pairs.jsonl`: whether the shadow verified and the recorded reason when it did not; per-source coverage on each side; episode ids found by one side only or with different statuses; action keys (`<episode_id>/<action_key>`) found by one side only; for shared action keys, whether the drafts differ and their word counts; unknown counts; and cost, duration and turns with shadow-to-live ratios. Episode and action comparisons need a verification from both runs.
- `SHADOW.md`: totals across all pairs, then one row per pair, newest first, in Pacific time.

`score.json`, `pairs.jsonl` and `SHADOW.md` carry opaque ids and counts only. Draft text, candidate names, email addresses and message bodies stay in the private verification snapshots, which are `0600` inside `0700` directories like every other output. Re-pairing a shadow run overwrites its pair directory and replaces its `pairs.jsonl` line, and keeps its live snapshot after `pilot.mjs` has pruned the live run.

The shadow must have its own `--shadow-dir`, separate from the live data directory. Each run keeps a lock, a checkpoint and run history in its data directory, and the shadow reconciles against the checkpoint from its own earlier scans. `cycle` and `pair` refuse a shadow directory equal to, inside, or containing the live one, and an `--out` inside the live one. The launchd template `launchd/com.recruiting-agents.scheduling-pilot.shadow-haiku.plist` runs `cycle` at 08:20, 09:50, 11:20, 12:50, 14:20, 15:50, 17:20 and 18:50 local time. Create its data directory before loading it (`node pilot.mjs init --data-dir <shadow-dir>`), because launchd opens the working directory and log files there before the job starts. Each shadow run is a full scan on the same subscription, eight a day on top of the live pilot's own.

## Verification

```sh
node --test agents/scheduling-pilot/pilot.test.mjs agents/scheduling-pilot/shadow.test.mjs
```

Tests use only fictional provider results and a fake Claude executable. They exercise actual run/checkpoint files, allowed/denied hooks, false-success rejection, all-source evidence, nested MCP errors, live empty envelopes, warnings for uncited reads, partial scans, full Gmail content, pagination, preserved pending work, repeated proposals, private permissions, run history, persisted tool-result cleanup, overlap prevention, stale-lock reclaim, blocked runs, the blocking hook mode, stale health, and alert recovery. The shadow tests pair fictional run directories and run `cycle` against the same kind of fake executable. No live reads, sends, notifications, or schedule installation occur in tests. Successful live scheduled runs and an OS notification witness must be checked separately during activation.
