# Scheduling planner

This package is the executable half of [`WORKFLOW.md`](WORKFLOW.md). Given one interview's facts as JSON, it finds the slot, renders every outgoing text from [`templates/`](templates/), builds the exact Google Calendar and Gmail payloads, keys each outward step for the ledger, runs the guard over all of it, and names the next state. It prints that plan and stops; nothing is sent.

## Running it

```
npm install
npm test                      # node --import tsx --test test/*.test.ts
npm run typecheck
npx tsx src/cli.ts plan test/fixtures/plan-held.json
npx tsx src/cli.ts render candidate-hold-placed fields.json
```

`plan` prints the plan as JSON on stdout and exits 0 when every guard check passed, 2 when the guard refused something (the plan still prints, with `dispatchable: false` and every reason), and 1 when the input is invalid. `render` prints one template filled from a JSON object of field values, so a person can read the wording before it is ever used. The three fixtures cover the hold (`plan-held.json`, the 2026-10-08 worked example with fictional people), the confirmation once the interviewer accepts (`plan-accepted.json`), and the case where the candidate's windows fit nobody (`plan-no-fit.json`).

The input carries the candidate's windows and the free/busy result the caller already read. `freeBusyRange` says what span that read covered; the planner never proposes a slot outside it, and when it had to search 14 days but the read covered only 7, the plan's `notes` say so. Once a hold exists, the input also carries `interviewerResponse` and `heldSlot`, because free/busy then shows the hold itself as busy and the slot cannot be recomputed.

## What it does not do

It makes no network call: no Google, Greenhouse, or Slack client is present, and the package has no runtime dependencies. It does not write the ledger, read a calendar again before the write, or post the Slack nudge and escalation on a clock; those belong to the dispatcher, which wires the spike's `GoogleApi`, `Ledger`, and `dispatchOnce` once the consent in CLO-398 exists. The Greenhouse interview record and the "assistant acted" note appear in the plan only as `deferred` ledger keys until the connector's interview write (CLO-401) ships.
