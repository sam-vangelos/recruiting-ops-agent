# Refinements to your recruiting operations design (from the Claude reviewer, 2026-10-20)

You are now the implementer for this program, and a Claude session reviews each branch before it merges. Claude checked your design and your Slice 1 brief against the code and the live run data. Most of the design stands. The corrections below are binding, so revise the plan and your next brief to match them.

## 1. Your Slice 1 diagnosis was wrong, and the fix is already built

The scan failures on 2026-10-20 came from neither cause you named. All six failing runs (15:31Z, 16:07Z, 16:42Z, 17:17Z, 20:13Z and 21:21Z, in `~/.recruiting-agents/scheduling-pilot/runs/*-verification.json`) share one cause:

- The model called `mcp__claude_ai_Gmail__list_drafts` to check whether Sam had a draft on a thread.
- Sam's drafts folder is too large to page through, so every `list_drafts` receipt ended "Unread or unresolved pagination".
- The report still cited `list_drafts` in `coverage.gmail` and in facts. Those citations resolved to no verified receipt, which raised both errors.

The error "A Gmail search result has no successful full-body read." appears in none of the failures, and neither does a carried-forward fact citing an old receipt. Your proposed red test asserted that string, so it would have tested a defect that was not occurring.

Both fixes are on branch `clo-610-drafts-listing`, in worktree `/Users/sam.vangelos/Projects/recruiting-tools/scheduling-agent-clo610`, cut from `75b55dc`:

- `09692a8` (Linear CLO-658) removes `list_drafts` and `get_draft` from the worker allowlist and adds a prompt rule never to call them. It also moves the Sam-draft check into the interactive session's pre-send fresh read.
- `f9a341f` (Linear CLO-610, which is a separate older defect):
  - An unverified, unrecovered read is now fatal unless its source is declared incomplete.
  - The required Greenhouse reads now include applications and candidates.
  - `search_my_candidates` must be scoped.
  - `search_my_attachments` is allowed only when scoped.

The gate (`node tools/render.mjs --check && node --test worker/*.test.mjs .claude/hooks/send-gate.test.mjs`) exits 0 with 117 of 117 tests passing.

Do not redo this work, and drop the collector/extractor/planner rebuild from Slice 1. Keep that rebuild as a later option, and revisit it only if verification becomes brittle again once more sources are added.

## 2. Work from commits, never from the main checkout's working tree

The main checkout at `/Users/sam.vangelos/Projects/recruiting-tools/scheduling-agent` has 17 uncommitted files dated 10/19 17:53. They look like redaction for the external review:

- Sam's dated rulings are stripped out.
- Real colleagues are replaced with fictional names. In `LEDGER.md`, for example, `khiem.doan` became `dana.okafor`.
- The "Linear is Sam's record" rule is gone from `CLAUDE.md`.

Sam is deciding whether to save them as a patch and reset main. Until he does, cut every worktree from a commit, and never copy or deploy anything from main's working tree.

## 3. The live worker is a stale copy, so never hand-patch it

`~/.recruiting-agents/scheduling-pilot/app/` holds the worker as of 10/15–10/16. It has no `roster.mjs`, no `ledger.mjs`, and a prompt from before the 10/18 working-hours rules. Installing the repo worker is Linear CLO-592, and its procedure is in the repo README under "Install and cutover". It needs three things:

1. CLO-557, ledger hardening (a tolerant ledger read, monotonic status, and intents that are not counted as discharges), is still Todo.
2. CLO-659, below, must be fixed.
3. Sam has to say go.

Do not stop the Haiku shadow run before 2026-10-23, which is CLO-550.

## 4. The next two small tasks come before Slice 2

1. **CLO-659.** `permitted()` in `worker/gate.mjs` never checks `scope_handle`. The greenhouse-recruiter server lets `scope_handle` win over `job_ids`, so a pilot-scoped call that also carries another job's handle escapes the pilot job. Reject any input that carries `scope_handle`, with a red test first. Branch from `f9a341f`.
2. **CLO-557.** Make the ledger hardening the cutover needs. Its issue text has the spec.

Both are small. Ship each as its own branch and commit, and hand it back for review.

## 5. Codify the rulings with the slice that builds them

Sam's five rulings of 2026-10-20 are recorded on Linear CLO-649. Rulings 2, 3 and 4 (the rejection delay, emoji approvals, and the autonomous scorecard nudge) change what the live agent does. `JOB.md` renders straight into the worker prompt and into the interactive harness. Writing those rulings in before their code exists would make the running agent act on workflows it cannot carry out.

- Put each ruling into `JOB.md` in the same commit as the slice that implements it: ruling 3 with slice 4, ruling 2 with slice 5, and ruling 4 with slice 6.
- Ruling 1 (hold an unmapped booking and ask Sam) goes in with slice 3.
- Ruling 5 is a Greenhouse UI edit to a template other recruiters share. It is Linear CLO-657 and needs Sam's OK on the before and after text. It is not code.

## 6. Claims in your design to fix or verify

- **Token cost.** "About 1% of the weekly budget per sweep" cannot be right, because the worker already sweeps 48 times a day. "50 to 70% for a 30-minute sweep" has the same problem. Measure the real cost per run from the stream logs before any runtime or cadence decision rests on it.
- **"0 tokens" for the 60-second live-interview watcher.** Checking a Gmail thread, a calendar RSVP and a Slack DM goes through the claude.ai connectors, which run inside a Claude session. Cost the watcher honestly, or design it around reads plain code can make.
- **Harvest token collision.** You stated that minting a Harvest v3 token outside the MCP server revokes the server's token. Cite where that is documented in `docs/reference/greenhouse.md` or the greenhouse-mcp repo, or mark it unknown and verify it in the slice 3 spike.
- **Connector reach in headless runs.** Before slice 2, confirm that the Granola and Calendly connectors are available to the headless `claude --print` worker, as Gmail and Calendar already are. Run a dry scan with those tools on the allowlist and report what comes back.

## 7. The revised slice order

1. Done: CLO-658 and CLO-610. Next: CLO-659 and CLO-557, then the cutover (CLO-592) on Sam's go.
2. CLO-651: a Granola collector, and post-screen scorecard drafts on the 30-minute loop. These are drafts only, and nothing is submitted.
3. CLO-652: create the candidate and application when a screen is booked.
4. CLO-653: a hiring-team yes in Slack leads to a stage move, then an availability request or take-home.
5. CLO-654: a negative scorecard leads to a rejection after the deliberate delay.
6. CLO-655: the executors, the live-interview watcher, and caffeinate.
7. CLO-656: Greenhouse upkeep across several requisitions.

## 8. How each slice comes back for review

Hand back every slice in this shape, and Claude reviews it before anything merges or deploys.

- One git worktree per slice, cut from a named commit.
- A file allowlist and a do-not-touch list.
- A red test that fails before the fix, with its failing output quoted.
- The exact gate command, with its exit code captured to a file.
- One commit per slice, with a message naming the Linear issue.
- No merge, push, stash or deploy.
- Report the branch, the SHA, the gate output and any deviations.
- Tests use fictional people only. Candidate names, emails and message bodies never go into the repo or into Linear.
- Update the slice's Linear issue as the work moves.

Now revise your design and Slice 2 brief to reflect these corrections. Then start with CLO-659.
