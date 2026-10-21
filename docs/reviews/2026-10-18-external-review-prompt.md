# Architecture & Failure-Mode Review Brief

This document is the red-team review brief used to evaluate the scheduling agent's two-mode design, idempotency guarantees, and operational failure modes after its first ten days in live pilot operation. Candidate names and emails are always redacted (`[candidate]`) in review bundles.

## System summary

Turing's recruiting team operates without dedicated recruiting coordinators. Sam Vangelos, a senior recruiter, built this agent to automate full-cycle interview coordination across his active requisitions. The agent runs on his Mac under his identity—using his Gmail, Google Calendar, Slack, and Greenhouse accounts via MCP connectors inside Claude Code sessions—without separate service accounts, agent mailboxes, or standalone API keys.

The architecture consists of two operating modes coordinated through a single append-only JSON Lines ledger (`ledger.jsonl`):

1. **Ambient Read-Only Scanner (`worker/pilot.mjs`)**: Runs every 30 minutes via `launchd`, sweeps all four systems of record, verifies that every reported fact and source scan is backed by paginated MCP tool-call receipts, and writes draft proposals to local private files (`DRAFTS.md`, `checkpoint.json`).
2. **Interactive Execution Harness (`CLAUDE.md`)**: Interactive Claude Code sessions booted in this repository read the ledger and roster on startup, present a chronological day-view of interviews, surface unreviewed worker proposals, and execute outward actions with Sam's approval—recording each step in `ledger.jsonl` as `"intent"` before dispatch and `"dispatched"` with its provider ID upon completion.

Every interviewer round is scheduled and confirmed inside Greenhouse, and the interviewer must accept the calendar invite before the candidate is sent confirmation details. The domain rules live in a single specification ([`JOB.md`](../../JOB.md)), from which [`tools/render.mjs`](../../tools/render.mjs) generates both the ambient worker prompt and the interactive session harness so the two modes cannot drift.

## Fixed architectural constraints

1. **Single human identity**: All reads and writes run as Sam. No separate agent mailboxes, service accounts, or Greenhouse seats.
2. **Greenhouse as system of record**: Interviewer rounds are scheduled and confirmed through Greenhouse, never via bespoke confirmation emails or unlinked calendar holds.
3. **Interviewer acceptance gates candidate confirmation**: The interviewer must accept the hold before the candidate receives confirmation.
4. **Human-in-the-loop by default**: During the pilot, every candidate or interviewer message waits for explicit approval, except for the three operational exceptions defined in [`JOB.md`](../../JOB.md) (Greenhouse stage/access updates and standard confirmation sends, urgent interviewer cancellation notices, and live interview call-waiting nudges).

## Review dimensions & failure modes

1. **The ten steps as a coordinator's job (`JOB.md`)**:
   - Multi-interviewer and panel rounds, late candidate-initiated reschedules, no-shows on either side, IANA time zones and the late-October US/Europe daylight-saving transition gap, interviewer kit permissions, and hiring-manager routing changes mid-loop.
2. **Dual-mode coordination and `ledger.jsonl` (`LEDGER.md`, `worker/ledger.mjs`)**:
   - Concurrency and race conditions: an interactive session dispatching while a 30-minute background scan is mid-flight, multiple interactive sessions open concurrently, a process crash between writing `"intent"` and completing the provider call, or a provider call that succeeded over the network before returning a timeout. Because Gmail send has no server-side idempotency key, `ledger.jsonl` is the primary guard against duplicate messages.
3. **The send path and approval freshness (`CLAUDE.md`, `planner/src/guard.ts`)**:
   - What can change between draft generation, human approval, and connector dispatch (e.g., a candidate replying in the thread or an interviewer's calendar slot filling while a proposal sits awaiting review), requiring a fresh thread and calendar read immediately prior to dispatch plus deterministic pre-send guard checks.
4. **Earned autonomy criteria**:
   - Evaluating per-action-type release thresholds (e.g., consecutive unedited, incident-free approvals), defining what constitutes a scheduling incident, and designing automatic circuit-breakers to revoke autonomy on regression.
5. **Operational ceiling & desktop runtime limits (`worker/pilot.mjs`, `worker/shadow.mjs`)**:
   - Desktop sleep/wake gaps, upstream MCP connector availability (e.g., transient 503s), weekly subscription token budget (~1% per full 4-service Sonnet sweep), and evaluating smaller models (`claude-haiku-5-5`) via paired shadow runs (`shadow.mjs`) to reduce per-scan cost and latency.
6. **Verification rigor (`worker/*.test.mjs`, `planner/test/*.test.ts`)**:
   - Ensuring tests verify real invariants (receipt binding, pagination exhaustion, lock recovery, idempotent deduplication, and timezone-boundary math) against adversarial or partial inputs.
