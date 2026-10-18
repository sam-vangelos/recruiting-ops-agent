# Independent review of a recruiting scheduling agent, before its next build phase

You are reviewing the design, code and plan of an interview-scheduling agent that one recruiter has been running for ten days. Your job is to find what is wrong, what is missing and what would be better, before the next two weeks of building start. You are not building anything and you are not here to reassure anyone. The people who built this have read their own plan many times; what they cannot do is see it fresh.

Everything you need is in the bundle below this prompt: the rule set, the ledger spec, the README, the worker's code and prompt, the roadmap, and the three Linear issues that carry the open design questions. Candidate names and emails are replaced with `[candidate]` on purpose; colleagues' names and the recruiter's own are real.

## The situation in ten lines

Turing's recruiting team has no coordinator. Sam Vangelos, a senior recruiter, schedules his own interviews and built this agent to take that over. The agent runs on his Mac, as him: his Gmail, his Google Calendar, his Slack and his Greenhouse login, through the connectors available inside Claude Code sessions. There is no API key, no agent mailbox and no service account, by his ruling.

It has two modes that share one append-only ledger. A read-only scanner runs every 30 minutes, reads the four systems and writes draft proposals to local files. Claude Code sessions, started from the repo, do the actual sending with Sam's approval on every candidate or interviewer message, and record each outward step in the ledger as an intent before the send and as dispatched after it. Interviews are booked and confirmed only inside Greenhouse through its web UI, driven by the session through a Chrome extension; the interviewer must accept before the candidate is told the time.

The job is written as ten steps in `JOB.md`, with Sam's rulings quoted and dated. The worker's prompt and the session's instructions are both generated from that file so they cannot drift. The pilot is one requisition (Field Engineer, Greenhouse job 5149015004), a handful of candidates at a time, one hiring manager and two or three interviewers.

## What is settled, and what is about to be built

These are Sam's rulings. Do not spend words re-arguing them unless you believe one is dangerous, in which case say so once, with the specific harm and what changing it would cost:

- Everything runs as Sam. No new identities, mailboxes, keys or Greenhouse users.
- Interviewer rounds are scheduled and confirmed only in Greenhouse. No hand-built calendar holds, no bespoke confirmation emails.
- The interviewer accepts before the candidate hears a time.
- During the pilot every message to a candidate or interviewer waits for Sam's explicit approval, with three exceptions listed in `JOB.md`.
- The runtime is Claude Code on Sam's Mac for the pilot. Moving to an unattended server is parked (milestone M5).
- Linear is the record; the repo holds the rules and the code.

What is about to be built, in order (the roadmap document in the bundle has the detail):

1. Milestone M2: harden the ledger (CLO-557), make the roster join runnable from both modes (CLO-558), replace the installed scanner with the repo's worker, delete the retired `planner/` code.
2. Milestone M3: the pre-send checks listed in CLO-453 become code the session runs before any send, and a counter releases a message type from approval after 15 consecutive unedited, incident-free approvals.

Three decisions are still Sam's: the AI disclosure line on candidate email (with legal), where Turing's paid-holiday list lives, and whether his own Calendly recruiter screens come inside the agent's job.

## What to examine

Work through these in order. For each, the question is not "is this reasonable" but "where does this break, and what would a strong team do instead".

1. **The ten steps as a coordinator's job.** Read `JOB.md` as if you were an experienced recruiting coordinator. What does a good coordinator do that these steps never mention? Consider panels and multi-interviewer rounds, reschedules the candidate initiates late, no-shows on either side, time zones and the US/Europe daylight-saving gap in late October, interviewer preparation and kit access, candidate experience between steps, and what happens when the hiring manager changes their mind mid-process.

2. **The two-mode design and the ledger.** The scanner and the sessions coordinate only through `ledger.jsonl` and the four systems of record. Find the races and the disagreements: a session acting while a scan is mid-flight, two sessions open at once, a crash between intent and send, a send that succeeded but was recorded as failed. Gmail has no idempotency key, so the ledger is the only protection against a double send. Is the intent/dispatched model sufficient? What should the ledger record that it does not? CLO-557 already lists eight defects the team found; judge whether that list is complete and whether its fixes are the right ones.

3. **The send path and the meaning of a tick.** A model drafts, Sam approves in chat, the same model sends through a connector. What can still go wrong between approval and send? When does an approval stop being meaningful (stale context, a draft that changed, a thread that moved on)? The pre-send gate in CLO-453 has 14 checks: which are missing, which are theatre, and which would hand too many cases back to Sam to be worth it?

4. **Earned autonomy.** Is "15 consecutive unedited, incident-free approvals per message type" a sound release criterion? What counts as an incident, who detects it, and how is autonomy revoked? What would you require in addition, or instead?

5. **Operational reality.** The Mac sleeps; Google's Context Aware Access blocks the cloud console from it; the Greenhouse connector returned 503s today; each scanner run costs about 1% of the weekly Claude allowance; a Haiku shadow is being scored against Sonnet. What fails first at twice the candidate volume, or with a second recruiter's requisitions? Which of these is the real ceiling on this architecture?

6. **Verification and tests.** The team has already found tests that passed against a neutered implementation. Read the test files in the bundle with that in mind: what do they actually prove, and what evidence should exist before the scanner cutover that does not exist today?

7. **Roadmap sequencing.** Is M2 before M3 the right order? Is anything parked in M5 needed sooner than the plan admits? What would you cut from the next two weeks, and what would you add?

8. **Blind spots.** Name the things this review brief itself did not think to ask about.

## How to write the review

- Cite the bundle: file and line, or section heading. A finding without a citation is an opinion; label it as one.
- Mark each finding as **verified** (you can point at the code or text that shows it) or **inferred** (a reasonable reading the bundle does not confirm).
- Rank by consequence. Lead with what would hurt a candidate, an interviewer or Sam's standing if left alone; put style and tidiness last or leave them out.
- Every finding ends with the concrete change you would make and roughly what it costs (hours, days, or a decision).
- No praise, no summary of the bundle back to us, no generic best-practice lists. If a point is already in CLO-557 or CLO-453, say "already captured in CLO-557 item 3" and move on, or say why their fix is wrong.
- Where the bundle does not contain what you need to judge, say exactly what is missing rather than guessing.
- Hold it to about 2,500 words. Fewer, sharper findings beat a long list.

## Output format

1. **Overall read**: three sentences. Is this on a sound footing, and what is the single biggest risk?
2. **Findings**, ranked, as a table: number, severity (high / medium / low), area (one of the eight above), the claim in one sentence, the evidence (citation), verified or inferred, the change, the cost.
3. **The next two weeks, as you would run them**: an ordered list, each item one line, noting where it departs from M2 and M3 and why.
4. **Questions you would need answered** before committing to the plan.
5. **What you could not assess** from the bundle.

The bundle follows. Files are delimited by lines beginning `===== `.
