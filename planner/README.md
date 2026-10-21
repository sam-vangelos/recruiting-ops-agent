# Deterministic Slot Planner & Pre-Send Guard (`planner/`)

This zero-dependency TypeScript package handles the parts of interview scheduling that an LLM should never improvise: **IANA timezone and daylight-saving arithmetic**, **free/busy slot intersection**, **strict template rendering**, and **deterministic pre-dispatch safety checks**.

Given an interview's inputs as JSON (candidate availability windows, interviewer free/busy blocks, time zones, and current booking state), `planner` computes valid slots, renders outgoing messages from [`templates/`](templates/), builds exact Google Calendar and Gmail payloads, assigns idempotent ledger keys, and runs a 7-rule safety guard over every outgoing payload before anything can be sent.

## Relationship to [`JOB.md`](../JOB.md) and [`worker/`](../worker/)

- **[`planner/`](.)** provides the pure, deterministic slot-finding (`src/slots.ts`), IANA timezone normalization (`src/time.ts`), template compiler (`src/templates.ts`), and pre-send message guard (`src/guard.ts`), originally built around the 4-step calendar-hold state machine documented in [`WORKFLOW.md`](WORKFLOW.md).
- **[`JOB.md`](../JOB.md) and [`worker/`](../worker/)** define the full 10-step Greenhouse-first operating loop and live MCP orchestration harness.

## Running it

```sh
npm install
npm test                      # node --import tsx --test test/*.test.ts
npm run typecheck
npx tsx src/cli.ts plan test/fixtures/plan-held.json
npx tsx src/cli.ts render candidate-hold-placed fields.json
```

`plan` prints the computed plan as JSON on stdout and exits `0` when every guard check passes, `2` when the guard refuses an outgoing payload (the plan still prints with `dispatchable: false` and every refusal reason), and `1` when the input schema is invalid. `render` renders a single template from a JSON object of field values for inspection.

The three test fixtures cover:
- `plan-held.json` — Placing an initial interviewer calendar hold and sending the candidate hold notice.
- `plan-accepted.json` — Confirming the candidate once the interviewer accepts the calendar hold.
- `plan-no-fit.json` — Offering calendar-confirmed alternative slots when candidate windows do not overlap with interviewer availability.

## Core modules

- [`src/time.ts`](src/time.ts) — Zone-aware formatting and normalization via `Intl.DateTimeFormat`. Maps Greenhouse's non-IANA timezone labels (e.g., `"Eastern Time (US & Canada)"`, `"Asia/Calcutta"`) to canonical IANA identifiers and forbids wall-clock string arithmetic across US/Europe DST transitions.
- [`src/slots.ts`](src/slots.ts) — Intersects candidate windows against recruiter and interviewer free/busy spans, enforcing working hours in the interviewer's local zone, 15-minute buffers, 30-minute wall-clock alignment, a 2-hour minimum lead time, and daily interview caps. Any calendar that errors on free/busy fails closed (treated as busy).
- [`src/guard.ts`](src/guard.ts) — Deterministic pre-dispatch verifier checking 7 rules on every outgoing payload: `recipients`, `no-zoom` (enforces Google Meet), `links` (allowlists `meet.google.com`, `app4.greenhouse.io`, and `turing.com`), `confirmed-times` (every clock time in text must match a calendar-confirmed slot), `other-candidates` (blocks cross-candidate name leaks), `placeholders` (blocks unrendered `[Bracket]` tokens), and `word-cap`.
- [`src/templates.ts`](src/templates.ts) — Strict front-matter template parser and renderer that rejects undeclared or missing merge fields.
- [`src/states.ts`](src/states.ts) & [`src/plan.ts`](src/plan.ts) — Pure state machine and payload builder. Makes zero network calls and has no runtime dependencies.
