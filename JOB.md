# The scheduling agent's job, step by step

Sam outlined this on 2026-10-16 as the discrete actions the scheduling agent owns, and ruled the same day on the three gaps the outline left open. It is the agent's whole job. Each step says when it starts, what the agent does, when the step is done and what happens when it stalls; anything outside the steps belongs to another agent or to Sam. `WORKFLOW.md` beside this file still describes the hand-built flow of 2026-10-08 and the code that implements it. Both get rebuilt to match this file, and where they disagree, this file wins.

Sam on why the agent exists (2026-10-16): "I'm not a recruitment coordinator … I'm not, as a recruitment coordinator would, you know, in real time monitoring these things. And so, like, I need the agent to be monitoring interviews as they're about to happen, as they're happening, etc. So that they can successfully manage the various sort of things, circumstances, issues that inevitably materialize at some point."

Everything runs as Sam, from his mailbox, his calendar and his Slack, and every interviewer round is scheduled and confirmed inside Greenhouse (Sam, 2026-10-12).

## The ten steps

### 1. Spot the hiring manager's yes

This starts when a hiring manager approves, in the role's Slack channel or a direct message, a candidate Sam presented. The agent ties the yes to one candidate, one application and the next interview in Greenhouse, and takes the interviewer from the interview plan unless the manager names someone else. It then moves the application into that interview's stage, because Greenhouse cannot schedule an interview the application has not reached. The step is done when exactly one interview is ready to schedule; a yes the agent cannot tie to one application goes to Sam as a question. A no belongs to the systems agent (`agents/systems-admin`), which handles the rejection and its email (Sam, 2026-10-16).

### 2. Ask the candidate for availability

Once step 1 is done, the agent sends Greenhouse's availability request from the application, so the request is logged on the candidate's profile. If the candidate has not answered 24 hours later, the agent sends one nudge, and if the nudge also goes unanswered for 24 hours, it tells Sam (Sam, 2026-10-16: "one nudge after 24 hours, then a note to me").

### 3. Watch for the candidate's times

The agent reads the times the candidate submits through Greenhouse's form, and also their email, because some candidates reply there instead. The step is done when their windows are recorded in their own time zone. Anything else in a reply, such as a question or a mention of another role, goes to Sam; a withdrawal goes to the systems agent.

### 4. Find time with the interviewer

With the candidate's windows recorded, the agent checks every interviewer's calendar against them and takes the earliest slot that suits everyone, inside working hours in each person's zone. A chosen slot leads to step 6. When nothing overlaps, step 5 runs.

### 5. Offer the interviewer's earliest openings

The agent emails the candidate, in their existing thread, the interviewer's three earliest open slots. A slot the candidate picks leads to step 6. If none works, the agent goes back to step 2 for more availability and the loop repeats (Sam, 2026-10-16).

### 6. Hold the slot in Greenhouse

The agent schedules the interview in Greenhouse, which puts the event on Sam's calendar and sends the interviewer the invite with the interview kit. A new interviewer first gets the Interviewer role on the job, so the kit link works; Khiem's dead link on 2026-10-11 is why. The step is done when Greenhouse shows the interview scheduled. The click-path is in `docs/playbooks/greenhouse.md`, § Scheduling an interview.

### 7. Wait for the interviewer, and chase at 12 hours

An acceptance leads to step 8. When the invite has had no answer 12 hours after it went out, the agent asks the interviewer on Slack whether they can make the time (Sam, 2026-10-15), and a yes leads to step 8. If that message goes unanswered for 24 hours, the agent sends one one-sentence follow-up in the same thread. If the follow-up also goes unanswered for 24 hours, the agent asks the hiring manager on Slack to nudge the interviewer (Sam, 2026-10-17, after Shyam went unanswered on three screens: "If an interviewer on a hiring team has sort of behaved like this, then the step at this point would be to ping the hiring manager and be like, hey, can you nudge this person for me?"). A no or an outright decline means rebooking: into another of the candidate's windows if one is still open on the interviewer's calendar, otherwise back to step 2. Before rebooking, the agent reads the interviewer's Slack, because a decline often comes with a reason or a substitute, as Andrew's "move it to Khiem" did on 2026-10-09.

### 8. Confirm to the candidate from Greenhouse

The agent sends Greenhouse's interview confirmation with the template the dialog preselects. It carries the time, the interviewer and the Meet link, sends the candidate a calendar invite and schedules a reminder for the day before. The agent never writes a bespoke confirmation (Sam, 2026-10-14). The step is done when Greenhouse logs the send.

### 9. Keep watch until the interview

From confirmation until the interview starts, the agent reads both sides' email, Slack and calendar replies. A request to move, from either side, goes back to step 3 or 4 with the new times, and the Greenhouse interview moves with it so only one booking is ever live. A cancellation frees the interviewer's time in Greenhouse and tells the other side. A candidate who withdraws goes to the systems agent.

### 10. Run the interview day

Sam ruled on 2026-10-16 that the interview itself is part of the job, and that an alert alone is not enough: "if somebody just hasn't joined the call, and either the candidate or interviewer is waiting for them, for the other, then the agent should reach out to the person who has not joined the call and the candidate's case, it would be via email, and the interviewer's case, it would be via Slack. issues related to like technical stuff, like video conference links not working, that's not really something that an agent can troubleshoot. So that should just be like an immediate alert."

- When one side is waiting for the other, the agent alerts Sam at once and then reaches the person who has not joined: the candidate by email, the interviewer by Slack, each with the meeting link.
- A technical problem, such as a link that does not work or someone who cannot get in, gets an immediate alert to Sam and nothing more.
- House practice: in the hour before the interview, the agent checks that both sides are still on (no late cancellation or reschedule, the interviewer's acceptance still standing, the Meet link still on the event). Anything wrong is handled as in step 9, with an alert to Sam.
- House practice: if the missing person still has not joined about ten minutes after the nudge, the agent tells Sam and waits for his call. Each such case is recorded for the exception rulings in CLO-519.
- The step ends when the interview does. Scorecards belong to the systems agent.

## What is not this agent's job

- A hiring manager's no, the rejection and its email, and a candidate's withdrawal belong to the systems agent (Sam, 2026-10-16, for the no).
- Scorecards and other record clean-up belong to the systems agent.
- Outreach to people who have not applied, and its follow-ups, belong to the sourcing agent (`agents/sourcing-admin`).
- Process mail from interviewers, such as a take-home design, is flagged to Sam (Sam, 2026-10-15).
- Sam's own recruiter screens are not in the outline, so they stay out until he says otherwise.

## Which steps wait for Sam's OK

During the pilot, every message to a candidate or an interviewer waits for Sam's tick, with two standing exceptions: Greenhouse record changes such as the stage move and job access go ahead without asking, and so does the Greenhouse confirmation in step 8 (Sam, 2026-10-14). The nudges in step 10 also go out without asking, because a nudge that waits for a tick lands after the moment has passed (Sam, 2026-10-16: "yes").

## What step 10 needs before it can run

Watching an interview day means checking every minute or two from shortly before each interview until it ends. The current pilot runs every 30 minutes, and each run costs about 1% of the weekly Claude allowance, so it cannot do this. The plan is a lightweight watcher that wakes the agent only when someone in that interview writes. Reading Gmail outside a Claude session needs Sam's own Google connection (CLO-398), and reading Slack needs a similar path. The agent also cannot see who is in the Meet call today, so it learns that someone is missing when the person waiting writes. Google's Meet API may let the meeting's owner see who has joined, which would let the agent act without waiting for that message; this is to be verified once CLO-398 exists.

## Sources

- Sam's outline and rulings, Claude Code session of 2026-10-16.
- `docs/playbooks/greenhouse.md`, § Scheduling an interview (the click-path, the 12-hour rule, the confirmation template).
- `~/.claude/projects/-Users-sam-vangelos-Projects-recruiting-tools-recruiting-agents/memory/`: `scheduling-workflow-hm-first.md`, `interviewer-no-accept-12h-slack-followup.md`, `interview-confirmations-greenhouse-template.md`, `scheduling-agent-scope-excludes-process-admin.md`, `scheduling-pilot-review-2026-10-14.md`.
