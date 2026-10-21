# Design brief for Argon: from scheduling agent to recruiting operations agent

You are a staff-level systems architect who designs agents that act in production systems on a person's behalf. You think in event sources, state machines, idempotent side effects, and failure modes. You are reviewing a working system built by one recruiter, Sam Vangelos, and designing its next form. Your audience is Sam, who decides, and a Claude Code principal who will turn your design into implementation briefs for Opus 5 implementers.

## Task context

Sam is a Senior Recruiter at Turing. Turing has no recruiting coordinators, so Sam runs the full cycle himself: sourcing, his own screens, interview scheduling, Greenhouse upkeep, scorecards, and rejections. Over the past three weeks he has built a scheduling agent that runs as him: same Gmail, Calendar, Slack and Greenhouse identity, no service accounts. It is in a live pilot on one Field Engineer requisition (Greenhouse job 5149015004).

Sam now wants that agent to become his recruiting operations agent. It would keep doing scheduling and also take on the administrative work around every candidate. It should watch every channel on a fixed cadence and do the next step itself, the way a coordinator would. Here is Sam's request, lightly cleaned up from dictation:

<sam_request>
I need you to be submitting scorecards on my behalf. I need you to be uploading candidates to Greenhouse on my behalf. I need you to be grooming and maintaining Greenhouse on my behalf: moving candidates forward, moving candidates between requisitions. And I need you to do it the same way, where you're monitoring things. Every half hour you check all the channels for updates. Did a candidate schedule time on my calendar? Can you see it in Calendly, in a scheduling confirmation over email, or as a new event on my calendar? Then you find the information you need to upload them to Greenhouse, upload them, and put them in the correct stage. Once I'm done with the meeting, you go to Granola, read the transcript, and create and add a scorecard per the parameters we've defined. If you see the hiring team respond positively in Slack to a candidate I've presented, you move them forward to the next stage in Greenhouse, and then you reach out to them, either to get their availability or, if it's an assignment stage, to send them the assignment. If a hiring manager or interviewer submits a scorecard and it's negative, we reject the candidate and send a rejection email, but not immediately, because we don't want it to look like we didn't deliberate. These are the kinds of things I need you to think about. I'm also not sure whether there's already a heartbeat that triggers on a schedule so the agent can look and act, or whether the chat has to be open for it to operate.
</sam_request>

The answer to Sam's last question shapes the whole design, so here are the facts. A macOS launchd job already runs the scheduling worker every 30 minutes without any chat open, and a health check runs every 5 minutes. Both stop while the Mac sleeps or is off. The worker only reads and writes drafts. Every outward action today happens in an interactive Claude Code session that Sam has open.

## What exists today

<existing_system>
Scheduling agent, private repo sam-vangelos/scheduling-agent:
- JOB.md is the single specification: ten steps from a hiring manager's yes through interview day, plus the actions that need Sam's approval. tools/render.mjs generates both the worker prompt and the interactive harness (CLAUDE.md) from it, so the two cannot drift apart.
- worker/pilot.mjs is the ambient scanner, run by launchd every 1800 seconds. It sweeps Greenhouse, Gmail, Calendar and Slack through MCP tools in a headless Claude run. It checks that every fact in its report is tied to a paginated tool-call receipt, then writes proposals to DRAFTS.md and checkpoint.json. It sends nothing.
- On 2026-10-20 that verification rejected 5 of 9 runs with "Ungrounded gmail coverage" and "Ungrounded episode fact or action". It fails closed, so the cost is stale drafts. This is tracked as Linear CLO-610.
- worker/shadow.mjs runs paired shadow scans on claude-haiku-5-5 to test whether a cheaper model can do the sweep.
- The shared ledger (~/.recruiting-agents/scheduling-pilot/ledger.jsonl, spec in LEDGER.md) is append-only. Every outward step writes an "intent" record with an idempotency key before dispatch, then a "dispatched" record with the provider's id. Sam's approvals and declines are recorded too.
- A send gate (commits 5a6e689 and 75b55dc, CLO-636) blocks any outward message Sam has not seen verbatim, and gates legacy Greenhouse writes.

Sibling agents, repo sam-vangelos/recruiting-agents, all drafts-only today:
- agents/desk is the shared contract: content-hashed proposals, approvals bound to one exact proposal version, coverage records stating how completely each source was read, an intent/outcome ledger for a future executor, private stores under ~/.recruiting-agents/, and handoffs between agents.
- agents/systems-admin (CLO-525) turns a finished recruiter screen into a scorecard draft mapped onto the job's real interview kit, keeping only statements it can quote from the transcript or Sam's notes. It also prepares the stage move or rejection that carries out Sam's decision. It has no executor, no schedule, no Slack capture of Sam's decisions, and no Granola collector. Its reading session is a manual procedure in INSTRUCTIONS.md.
- agents/sourcing-admin (CLO-526) proposes Noon sequences, slates and follow-up InMails per requisition.
- agents/followup runs the LinkedIn InMail follow-up for one campaign, with a ledger that prevents a second InMail to the same person.

Connectors available in Sam's Claude Code sessions:
- greenhouse-recruiter, local MCP: full reads, plus preview/apply pairs for stage moves, rejections, unrejects, candidate record updates, candidate notes, offers, and job owner and assignment changes. It has no tool to create a candidate or application and no tool to submit a scorecard. On 2026-10-20 a batch of twelve recruiter-screen scorecards was submitted through the Greenhouse web UI with the Chrome extension. A direct Harvest v3 write acting as Sam (On-Behalf-Of 5085047004) is allowed when the connector cannot do the write, with a read-back afterward.
- Gmail (claude.ai connector), Google Calendar, Slack, Calendly, Granola (meeting notes and transcripts), Notion, Linear, and Claude in Chrome for browser automation.
</existing_system>

<fixed_constraints>
These are Sam's settled rulings. Design within them. Do not re-propose alternatives.
1. Everything runs as Sam: his mailbox, his calendar, his Slack account, and his Greenhouse user (5085047004) with an "assistant acted" note. No agent mailboxes or service identities.
2. Every interviewer round is scheduled and confirmed inside Greenhouse. The interviewer accepts before the candidate is told. Sam's own screens may go on his calendar directly.
3. Right before any candidate send, the agent re-reads the candidate's full email thread and both calendars. It never acts on a sweep more than minutes old.
4. Autonomy is earned per action type, rejections included. A small always-asks tier stays. During the pilot, every candidate or interviewer message waits for Sam's approval, with the exceptions JOB.md lists.
5. Any component that reads untrusted text (emails, transcripts, résumés, Slack messages from others) holds no credentials and produces only structured output or drafts. Plain code decides what acts.
6. Every outward step is persisted with an idempotency key before dispatch, keeps the provider's id, and is reconciled on restart. Never resend blindly: Gmail has no idempotency key.
7. Implementation is TypeScript on Node 24. The stated production runtime is Cloud Run plus Cloud Scheduler in the turing-recruiting GCP project. gcloud is blocked on Sam's Mac, so cloud changes go through the console in his browser.
8. Build only what the next workflow needs. Two earlier roadmaps died building the platform first.
</fixed_constraints>

## The workflows Sam wants

Treat each of these as a state machine with a trigger, the evidence it needs, the actions it takes, the approval tier for each action, and its failure modes.

1. **A candidate books time with Sam.** Detect it from any of three signals: a Calendly booking, a confirmation email, or a new event on his calendar. Gather what Greenhouse needs (name, email, LinkedIn, résumé, source and the right requisition), create the candidate and application, and place it in the correct stage. The three signals often describe the same booking, and the candidate may already exist in Greenhouse under another email or on another job.
2. **Sam finishes a screen.** Read the Granola transcript and Sam's notes, then draft the scorecard against the job's interview kit and the parameters defined in the screening playbook. Submit it. Decide what "done with the meeting" means as a detectable event, and what happens when no transcript exists.
3. **The hiring team reacts positively in Slack to a candidate Sam presented.** Tie the message to one application, move it forward, then either request availability (scheduling steps 1 and 2 in JOB.md) or send the take-home assignment if the next stage is an assignment. Decide what counts as a positive reaction, who on the hiring team can give one, and what to do with an ambiguous one.
4. **A hiring manager or interviewer submits a negative scorecard.** Reject the application with the right reason, and send the rejection email after a deliberate delay so the decision does not look automatic. Design that delay: its length, whether it counts working hours in the candidate's time zone, what cancels it (a second positive scorecard, Sam overriding, the candidate being moved to another requisition), and how it survives a restart.
5. **Ongoing Greenhouse upkeep.** Moving candidates forward and between requisitions, duplicate candidates, rejections with no reason, interview rows stuck in to_be_scheduled, and missing scorecards. Systems-admin already detects two of these.
6. **Everything scheduling does today**, unchanged in behavior.

## What to design

Answer each question with one recommendation and the evidence for it. Where a choice is genuinely Sam's (a product, priority or taste call you cannot settle from the material above), say so and pose it as one question.

1. **Shape.** Should this be one agent that absorbs systems-admin and the scheduling worker, or several residents behind the desk contract sharing one event loop? Say what to reuse, what to retire, and how the JOB.md single-spec pattern extends.
2. **Heartbeat and runtime.** Should the agent run on launchd on the Mac or move to Cloud Run plus Cloud Scheduler? Consider sleep gaps, MCP connectors that exist only in Sam's Claude sessions, Gmail and Calendar OAuth, the Chrome-only Greenhouse writes, and token cost. A full four-service sweep costs about 1% of Sam's weekly subscription budget. Recommend a cadence per signal: polling every 30 minutes, faster polling, or push sources such as Gmail watch, Calendar push notifications or Slack events. Sam floated 30 seconds, so say plainly whether anything here needs that.
3. **Event detection and deduplication.** How does one candidate's booking, seen three ways, become one episode? How does a Slack reaction, a scorecard or a Granola note get tied to exactly one application?
4. **Writes the connector lacks.** For candidate creation and scorecard submission, choose among adding the tools to greenhouse-recruiter, direct Harvest v3 writes, or Chrome UI automation. State the reliability and reconciliation cost of each.
5. **Approval and autonomy tiers.** For every action type in the six workflows, give the starting tier (always asks, asks during the pilot, autonomous) and the evidence that would move it up a tier. Name the circuit breaker that moves it back down.
6. **The read-verification problem.** Today's worker rejects more than half its runs. Should a broader agent keep receipt-level grounding, change it, or split reading from deciding so the check is cheaper and less brittle? Say how the current failure mode would get worse as sources multiply.
7. **Failure modes.** Cover at least these: the same candidate under two emails, a booking that is cancelled after the candidate was created, a transcript naming the wrong candidate, a hiring manager's "looks good" on the wrong thread, a negative scorecard followed by a positive one inside the delay, a crash between the Greenhouse write and the ledger record, and the Mac asleep through a live interview.
8. **Build order.** Give the slices in order, each independently shippable and revertible, each with its gate and the acceptance evidence Sam would see. The first slice should be the one that removes the most of Sam's manual work at the least risk.

## Rules for your answer

- When the material above does not settle a fact, say "unknown" and name what would settle it. Do not invent tool capabilities, API behavior or Greenhouse configuration.
- Prefer extending what exists over building new platform. When you propose something new, say why the existing part cannot carry it.
- Keep candidate data out of every example you write. Use fictional names.
- Recommend one path per question. Do not hand Sam a menu.

## Output format

Return one Markdown document with these sections in this order:

1. **Recommendation in brief:** at most 200 words a non-engineer can act on.
2. **Architecture:** components, runtime, cadence, and data flow, with one diagram in text or Mermaid.
3. **Workflow specifications:** one subsection per workflow with trigger, evidence, actions, approval tier and failure handling.
4. **Autonomy ladder:** a table with one row per action type and columns for starting tier, promotion evidence and demotion trigger.
5. **Risks and failure modes:** each one with how it is detected and how it is contained.
6. **Build plan:** ordered slices with scope, gate and acceptance evidence.
7. **Questions for Sam:** only decisions that are genuinely his, each as one short question.

Now, using the system description, constraints and workflows above, design Sam's recruiting operations agent.
