# Interview scheduling: the workflow, codified

The agent's job is now defined step by step in [`JOB.md`](JOB.md), from Sam's outline of 2026-10-16. This file describes the hand-built flow of 2026-10-08 and the code in `src/` that implements it; both are rebuilt to match `JOB.md`, and where they disagree, `JOB.md` wins.

Sam ruled this flow on 2026-10-08 while scheduling two field-engineering candidates with Andrew Ma by hand, and the rule in `CLAUDE.md` already names it: hold on the hiring manager's calendar from Sam's calendar, the hiring manager accepts, then the confirming invite goes to the candidate. This file is the spec the scheduling resident implements. The code in `src/` is the executable half; the templates in `templates/` are the voice. Anything here that contradicts `CLAUDE.md` is a bug in this file.

Everything runs as Sam: his calendar holds the events, his Gmail sends the mail, and Greenhouse records the interview under his name with an "assistant acted" note. There is no agent mailbox and no agent calendar.

## The four steps

A booking moves through four steps in a fixed order. The interviewer's acceptance is the real confirmation, so the candidate never receives a time the interviewer could still decline.

1. **Find the slot.** Read the interviewer's free/busy from Sam's account (Turing colleagues share free/busy across the domain) and intersect it with the candidate's stated windows, the interview length from the job's plan, the interviewer's interview hours, and a buffer either side. Free/busy cannot see private holds, so "free" is probable, never certain, and the calendar is read again immediately before the event is written.
2. **Hold it.** Create the event on Sam's primary calendar with a Google Meet, the interviewer as the only attendee, and a client-chosen event id. Title: `Virtual Interview with <Candidate full name> for the role of <Job name>`. Description: the `interviewer-invite` template, which is the text of Greenhouse template "Interview Invitation - Interview Team *New*" (id 4151796004) with the interview-kit link and a line saying the candidate is holding the slot. In the same step, reply in the candidate's own thread with `candidate-hold-placed`: the time in the candidate's zone, "the invite follows once the interviewer confirms", no menu of alternatives.
3. **Wait for acceptance.** Poll the event's attendee `responseStatus`. `accepted` moves to step 4. `declined` triggers the reschedule branch below. `needsAction` after four working hours sends the interviewer a Slack nudge; by the end of the next working day the recruiter is asked to step in. The candidate is not contacted during the wait.
4. **Confirm the candidate.** Patch the same event to add the candidate as an attendee (so the Meet link and the calendar invite reach them) and send `candidate-confirmation` in their thread: the Greenhouse "Virtual Interview Confirmation *New*" (id 4151798004) text with Google Meet in place of its Zoom instructions. Record the interview in Greenhouse through the connector (CLO-401) against the calendar event, and leave the private "assistant acted" note. The reminder goes the day before.

## States

One record per interview, keyed by the Greenhouse application id and the job-interview id. The state names are the ones the code uses.

| State | Meaning | Leaves on |
|---|---|---|
| `detected` | Greenhouse shows the interview `to_be_scheduled` on an allowlisted job, and the agent has made itself coordinator. | Candidate availability present → `slot_proposed`; none → `awaiting_availability`. |
| `awaiting_availability` | Greenhouse's own availability request has gone out (stage rule); the agent is waiting on the candidate. | Availability received → `slot_proposed`; 48 h silence → one nudge; another 48 h → `handed_off`. |
| `slot_proposed` | A slot was found and the hold event is queued behind an approval or a ledger intent. | Hold written and candidate reply sent → `held`; the planner finds nothing in the 7-day window and then the 14-day window → `no_fit`. |
| `held` | Event exists on Sam's calendar with the interviewer invited; candidate told a hold is placed. | Interviewer `accepted` → `confirming`; `declined` → `rescheduling`; `needsAction` past the nudge thresholds → Slack nudge, then `escalated`. |
| `confirming` | Candidate is being added to the event and the confirmation email is queued. | Both dispatched and Greenhouse interview recorded → `confirmed`. |
| `confirmed` | Everyone has the invite; reminder scheduled for the day before. | Interview end time passes → `done`; either party asks to move → `rescheduling`; candidate withdraws → `handed_off`. |
| `rescheduling` | Someone declined or asked to move. The old event is updated in place where it still exists. | Candidate offered 3 to 5 new slots (`candidate-alternative-times`) → `awaiting_availability`; a new hold placed → `held`. |
| `no_fit` | Candidate's windows intersect nobody's free time. | `candidate-alternative-times` sent → `awaiting_availability`; when the dispatcher's clock shows no interviewer time in five working days → Slack to hiring manager and recruiter the same day. |
| `escalated` | Interviewer silent past the nudge thresholds; recruiter asked in Slack. | Interviewer responds → `confirming` or `rescheduling`; recruiter takes over → `handed_off`. |
| `handed_off` | A person owns this candidate now. The agent stops and posts that it stopped. | Terminal for the agent. |
| `done` | Interview took place. | Terminal. |

The agent also stops the moment a person emails, books, or moves a candidate it owns (one owner per candidate). That transition is `handed_off` from any state.

## What goes out, and from which template

Every outward message comes from a file in `templates/`. The renderer refuses any template whose declared fields are not all supplied, so a "[Job Title]" can never leave. Each file's front matter names the Greenhouse template it derives from, where one exists.

| Template | Channel | Trigger | Derived from |
|---|---|---|---|
| `interviewer-invite` | Calendar event description, interviewer only | Step 2 | Greenhouse 4151796004 |
| `candidate-hold-placed` | Gmail reply in the candidate's thread | Step 2 | Sam's reply to a candidate, 2026-10-08 |
| `candidate-confirmation` | Gmail reply in the candidate's thread | Step 4 | Greenhouse 4151798004, Zoom text replaced |
| `candidate-alternative-times` | Gmail reply | `no_fit`, `rescheduling` | Blueprint section 6 example |
| `candidate-reschedule` | Gmail reply | `rescheduling` after a new hold is accepted | — |
| `candidate-reminder` | Gmail reply, the day before | `confirmed` | Greenhouse 4155637004, placeholders replaced |
| `candidate-nudge` | Gmail reply, once, after 48 h silence | `awaiting_availability` | Blueprint section 4 |
| `candidate-handoff` | Gmail reply | `handed_off` from a candidate-facing state | Blueprint section 4 |

Rules every template obeys, enforced by `src/guard.ts` before dispatch:

- Every time is written with its zone in words ("Friday, October 9 at 4:30 pm Eastern Time"), and the candidate sees their own zone first. The interviewer's description shows the interviewer's zone first and the candidate's in parentheses.
- Replies stay in the candidate's existing thread under its original subject. A new thread is a defect.
- First name exactly as Greenhouse stores it; no pronouns for the candidate or the interviewer.
- The meeting is always Google Meet. The word "Zoom" in any outgoing text fails the guard.
- Links may point only to Google Meet, `app4.greenhouse.io`, or a `turing.com` page.
- Every time in an outgoing message must equal a time the calendar confirmed for this interview. No other candidate's name may appear.
- One ask per email, and each template's own `max_words` cap (60 to 120 for the short messages; the confirmation, which is Greenhouse's own text, allows 240).
- The AI disclosure line (CLO-278) is a declared field, `DISCLOSURE_LINE`, in the first candidate message and every candidate signature. Until legal rules on its wording the field is supplied as the blueprint's draft, and the pilot's approval step is what makes that lawful: Sam reads and sends every message.

## Time

Times are stored as an instant plus a named IANA zone (`America/New_York`, not "ET" or "UTC-4"), and rendered through `src/time.ts` only. Greenhouse names zones two ways in the same feed ("Asia/Calcutta", "Eastern Time (US & Canada)"); the parser accepts both and normalises to IANA. Europe leaves daylight saving on 25 October 2026 and the US on 1 November, so for one week the usual gap is an hour shorter; that is why arithmetic on wall-clock strings is forbidden and every conversion goes through the zone-aware formatter.

Interview hours default to 9:00 to 17:00 in the interviewer's zone, Monday to Friday, with a 15-minute buffer either side of existing events and a cap of four interviews a day per interviewer. A calendar that errors on free/busy is treated as busy for the whole window, never as free.

## Idempotency and the ledger

Each outward step writes an intent to the ledger before dispatch, carrying the key `<step>:<application_id>:<job_interview_id>:<attempt>`, and records the provider's id (Gmail message id, Calendar event id, Greenhouse interview id) on completion. The calendar event id is client-chosen, derived from the application and job-interview ids and the attempt, so Google itself rejects a duplicate. `attempt` rises only when an event is cancelled and recreated, because Google never reuses a deleted id; a move in place keeps the attempt and the event id and is keyed as the step `hold-update`. Gmail has no idempotency key, so the ledger is the only protection: an intent with no done/failed record blocks every dispatch until `reconcile` finds the message or marks it failed. The spike at `spikes/google-as-sam/src/ledger.ts` is the ledger this resident adopts.

## Provider calls, in order

| Step | Call | Notes |
|---|---|---|
| 1 | `POST calendar/v3/freeBusy` | `items`: Sam's primary plus each interviewer. 7-day window from now, extended to 14 when nothing fits. |
| 2a | `POST calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all` | `id` client-chosen; `conferenceData.createRequest` for Meet; `attendees` = interviewers only; `summary` and `description` from the `interviewer-invite` template. |
| 2b | `POST gmail/v1/users/me/messages/send` | `threadId` = candidate's thread; `In-Reply-To` and `References` set; body from `candidate-hold-placed`. |
| 3 | `GET calendar/v3/calendars/primary/events/{id}` every few minutes | Read `attendees[].responseStatus`. A sync token over the calendar replaces polling once the resident runs on Cloud Scheduler. |
| 4a | `PATCH calendar/v3/calendars/primary/events/{id}?sendUpdates=all` | Append the candidate to `attendees`. Same event, never a new one. |
| 4b | `POST gmail/v1/users/me/messages/send` | Body from `candidate-confirmation`, Meet link included. |
| 4c | greenhouse-mcp `preview_interview_create` then `apply_interview_create` (CLO-401) | Application, job-interview id, interviewers, start and end, external event id. Then `apply_candidate_note_create` with the "assistant acted" note. |

Greenhouse writes never go direct to Harvest from this resident; a write the connector lacks is added to the connector first.

## The pilot gate

For the first two weeks on the pilot req, nothing dispatches by itself. The planner produces the exact payloads; the dispatcher writes a Gmail draft (for mail) or posts a Slack card (for calendar and Greenhouse writes), and Sam's send or tick is the dispatch. Each action type (hold, candidate hold reply, confirmation, alternative times, reminder) earns autonomy on its own clean record, in line with the "rejections earn autonomy" ruling. A global pause switch and a per-job switch sit in front of the dispatcher, and a daily cap of 20 outward messages bounds a bad hour.

## What the code in `src/` does and does not do

Does: parse the inputs into typed records, find slots, build the exact event and email payloads, render and validate templates, run the guard, advance the state machine, and print a plan as JSON. All of it is pure and tested without network access.

Does not, yet: call Google, Greenhouse, or Slack. Dispatch is wired through the spike's `GoogleApi`, `Ledger`, and `dispatchOnce` once the OAuth consent in CLO-398 exists, and through the greenhouse-mcp connector once CLO-401 is deployed. Until then `plan` is a dry run whose output a person can execute by hand, which is exactly what happened on 2026-10-08.

## Worked example: the two holds of 2026-10-08

a candidate, Field Engineer, AI Labs (job 5149015004, application APPLICATION_ID), Manager/Tech Screen kit 14297351004. Andrew Ma's free/busy showed Friday 9 October 13:30 to 14:00 Pacific open; the candidate had said Friday 1 to 5 pm Eastern. Hold placed on Sam's calendar with Meet, Andrew invited, description from `interviewer-invite` with kit link `https://app4.greenhouse.io/guides/14297351004/people/CANDIDATE_ID?application_id=APPLICATION_ID`. the candidate's thread got the hold reply naming "Friday, October 9 at 4:30 pm Eastern Time". State: `held`, waiting on Andrew's acceptance. A second candidate's hold followed the same path for Monday 12 October 11:30 to 12:00 Pacific, with the reply still a draft at the time of writing.
