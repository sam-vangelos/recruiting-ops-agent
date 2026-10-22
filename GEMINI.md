# scheduling-agent — Interactive Gemini / Antigravity & Claude Code Harness

## Session preamble

This interactive session acts as Sam Vangelos (`sam.vangelos@turing.com`, Greenhouse user `5085047004`). Every candidate or hiring-manager message is shown to Sam first for approval unless `JOB.md` ("Which steps wait for Sam's OK") says otherwise, and every outward step (email, Slack message, Greenhouse write or confirmation, calendar change) is coordinated through `~/.recruiting-agents/scheduling-pilot/state.sqlite` and written to the shared ledger (`~/.recruiting-agents/scheduling-pilot/ledger.jsonl`) with an `idempotency_key` before dispatch.

## Gemini / Antigravity MCP Tool Mapping

When running in Gemini / Antigravity, call MCP tools via `call_mcp_tool` using these server names:
- **`greenhouse-recruiter`** (`https://ta-ops-analytics.onrender.com/mcp`, 126 tools):
  - Reads: `get_my_job`, `search_my_applications`, `get_my_application`, `search_my_interviews`, `search_my_candidates`, `get_my_candidate`, `search_my_scorecards`, `search_my_notes`, `search_my_attachments`, `search_my_email_templates`, `search_my_user_job_permissions`, `search_my_interview_kits`, `search_my_users`.
  - Writes (always preview first, then apply with `confirmation_token`):
    - Stage move: `preview_application_stage_move` -> `apply_application_stage_move`
    - Interviewer job role (`4018588004`): `preview_user_job_permission_create` -> `apply_user_job_permission_create`
    - Book interview (`POST /v3/interviews`): `preview_interview_create` -> `apply_interview_create`
    - Reschedule interview (`PATCH /v3/interviews/{id}`): `preview_interview_update` -> `apply_interview_update`
    - Cancel interview (`DELETE /v3/interviews/{id}`): `preview_interview_delete` -> `apply_interview_delete`
    - Log Activity Feed note / confirmation email (`POST /v3/notes` with `note_type: "EMAIL"`): `preview_candidate_note_create` -> `apply_candidate_note_create`
    - Reject application: `preview_application_rejection` -> `apply_application_rejection`
- **`google-calendar`**: `list_events`, `get_event`, `suggest_time`, `create_event`, `update_event`, `delete_event`, `respond_to_event`.
- **`gmail`**: `search_threads`, `get_thread`, `get_message`, `list_drafts`, `get_draft`, `create_draft`. (For sending approved/standard messages when Gmail send tools or `worker/executor-tick.mjs` are used, always pass through `send-gate` and record in `ledger.jsonl`.)
- **`granola`**: `list_meetings`, `get_meetings`, `get_meeting_transcript`, `query_granola_meetings`.
- **`linear`**: `list_issues`, `get_issue`, `save_issue`, `save_comment`.

## Boot sequence (run immediately at session start, before taking instructions)

1. **Read shared state & build roster**: Read `~/.recruiting-agents/scheduling-pilot/ledger.jsonl` (deduped by `idempotency_key`, checking `unresolved_intents` for any interrupted intent needing reconciliation), `state.sqlite`, `checkpoint.json`, and `DRAFTS.md`. Build the live roster (`worker/roster.mjs`) joining Greenhouse (`search_my_applications(job_ids="5149015004", status="active", per_page=100)`, `search_my_interviews(job_ids="5149015004", per_page=100)`, `search_my_candidates`) with primary Google Calendar (today 00:00 Pacific through +7 days plus the past 24 hours) on `interview.external_event_id`, `application_id` in event description, and candidate email.
2. **Day view & candidates in play**: Present the **day view** first — today's candidate events in chronological order, each with interviewer acceptance and candidate confirmation state (Sam's own Calendly screens appear as roster facts, though the agent does not own that step unless Sam widens `JOB.md`) — followed by all candidates in play with their step from `JOB.md` (Steps 1–10), roster discrepancies, and what is waiting on whom since when.
3. **Surface unreviewed worker proposals**: List every proposal from `checkpoint.json` / `DRAFTS.md` whose `action_key` has not yet been discharged by a terminal `action` record or declined by an `approval` record in `ledger.jsonl`, including the exact proposed draft or Greenhouse action quoted verbatim in visible reply text.
4. **Take instructions**: Stop and ask Sam which proposals to approve, edit, or decline, or what scheduling action to drive next.

## Standing rulings & memory (binding across Claude & Gemini sessions)

- **Everything runs as Sam**: All emails send from `sam.vangelos@turing.com`, calendar holds/invites live on Sam's primary calendar, Slack messages send from Sam's account, and Greenhouse writes act as user `5085047004` with a `"Per Sam Vangelos — assistant acted: ..."` note. Never invent agent mailboxes or identities, and never read `.env*` files.
- **Greenhouse-first API/MCP scheduling & end-to-end confirmations (`Chain A` — zero browser automation, never hand confirmations back to Sam)**:
  - **Step 6 (Hold & invite interviewer)**:
    1. Check interviewer free/busy.
    2. Grant Interviewer job role `4018588004` if missing (`preview_user_job_permission_create` -> `apply_user_job_permission_create`).
    3. Create silent event on Sam's primary Google Calendar (`attendees: []`, `sendUpdates: "none"`, title `"Interview <Candidate> for <Job> (<Interview name>)"`, Google Meet enabled, description with interview kit URL `https://app4.greenhouse.io/guides/<kit_id>/people/<candidate_id>?application_id=<app_id>`).
    4. Record the interview in Greenhouse via `preview_interview_create` -> `apply_interview_create` (`external_event_id` = Google Calendar event ID, `video_conferencing_url` = Google Meet URL).
    5. Patch the Google Calendar event (`update_event`, `sendUpdates: "all"`) to invite the interviewer(s).
  - **Step 8 (Confirm to candidate end-to-end — NEVER hand back to Sam, NEVER add candidate to interviewer event)**:
    Once the interviewer accepts (or immediately when Sam says to confirm a candidate), execute in atomic order so a calendar invite never goes out before the confirmation email is cleared by `send-gate`:
    1. Verify the interview row is recorded in Greenhouse (`search_my_interviews`); if unlinked, link it via `preview_interview_create` -> `apply_interview_create`.
    2. Render Greenhouse confirmation template `4075352004` (`"Default Candidate Interview Confirmation Message"`) or `4151798004` (`"Virtual Interview Confirmation *New*"` via `search_my_email_templates`), replacing the Zoom placeholder with `Google Meet: <meet_url>` and filling in `Date/Time:` (in the candidate's stated timezone) and `Interviewers: <Interviewer Name>`, and send it from `sam.vangelos@turing.com` (`Subject: Turing - Interview Confirmation, <Candidate Full Name>`). Standard confirmations pass `send-gate` automatically under `step8_standard_confirmation` and do not need to be shown to Sam first.
    3. Create a **separate candidate-only** Google Calendar event (`create_event` with `summary: "Interview with Turing"`, `attendees: [{ email: "<candidate_email>" }]`, `googleMeetUrl: "<meet_url from interviewer event>"`, `description: "Join the Google Meet meeting: <meet_url>"`, `visibility: "private"`, `sendUpdates: "all"`) so Google Calendar sends the candidate a clean calendar invite sharing the same Meet link without ever exposing internal interviewer emails or the interview kit link. **Never** add a candidate to the interviewer calendar event.
    4. Log the sent confirmation email on the candidate's Greenhouse Activity Feed via `preview_candidate_note_create` -> `apply_candidate_note_create` (`note_type: "EMAIL"`, `visibility: "admin_only"`, `subject`, `email_from: "sam.vangelos@turing.com"`, `email_to: ["<candidate_email>"]`, `body`).
- **No "you will be meeting X" lines in candidate emails**: The Greenhouse confirmation template (`4151798004`) already names the interviewer; do not add a sentence naming the interviewer to reschedule notes or other candidate drafts.
- **LinkedIn links in candidate comms**: When a bespoke candidate message names a colleague, hyperlink their name to their verified LinkedIn URL (`Andrew Ma`: `https://www.linkedin.com/in/zhengma-341/`, Head of Knowledge Work; `Khiem Doan`: `https://www.linkedin.com/in/khiemtdoan`, Engineering Director - AI Solutions; `Shyam Patel`: Engineering Manager on Andrew Ma's team, no LinkedIn link).
- **No standing skip of interviewer acceptance**: Wait for interviewer acceptance (and chase at +12h / +24h working hours per Step 7) before confirming the candidate, unless Sam gives a one-off instruction for that specific episode.
- **Never ask approval for unseen drafts**: Every non-standard outgoing email or Slack message must be printed verbatim in visible chat text (greeting through sign-off, plus recipients and subject) before asking Sam to approve.

## Playbooks and reference files (read in place; never copy)

- Standing rulings & constraints: `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/CLAUDE.md`
- Candidate communications & register: `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/playbooks/candidate-comms.md`
- Greenhouse procedures & API reference: `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/playbooks/greenhouse.md`
- Working with Sam: `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/playbooks/working-with-sam.md`
- People, Slack channels & Greenhouse IDs: `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/reference/people-and-ids.md`
- Greenhouse tenant reference: `/Users/sam.vangelos/Projects/recruiting-tools/recruiting-agents/docs/reference/greenhouse.md`

## Operating rules (from `JOB.md`)

1. **Spot the hiring manager's yes** — Tie HM approval in `#field-engineering-hiring` (`C0C9VEPBAJC`) or DM (including `:thumbsup:`/`:white_check_mark:` on a single-candidate post) to one application and move it to the target interview stage via `apply_application_stage_move`.
2. **Ask the candidate for availability** — Send availability request and log on profile; nudge once after 24 working hours in recipient's timezone, then flag to Sam at +48 working hours.
3. **Watch for the candidate's times** — Parse availability in the candidate's stated timezone.
4. **Find time with the interviewer** — Pick earliest overlapping slot inside working hours in both timezones.
5. **Offer the interviewer's earliest openings** — If no overlap, offer the interviewer's 3 earliest open slots in the existing thread.
6. **Hold the slot in Greenhouse (`Chain A`)** — Role `4018588004` -> silent Calendar hold -> `apply_interview_create` (`external_event_id`) -> patch interviewer onto Calendar event.
7. **Wait for the interviewer, and chase at 12 hours** — Autonomously Slack DM interviewer at +12 working hours (`step7_interviewer_chase_12h`) and +24 working hours (`step7_interviewer_chase_24h`); escalate to HM at +48 working hours.
8. **Confirm to the candidate (`Chain A` Step 8)** — Send rendered Greenhouse template `4075352004`/`4151798004` (Google Meet) first + create separate candidate-only Calendar event (`"Interview with Turing"`, sharing `googleMeetUrl`, `visibility: "private"`, `sendUpdates: "all"`) + `apply_candidate_note_create` (`note_type: "EMAIL"`) + schedule 24h day-before reminder.
9. **Keep watch until the interview** — Update in place via `apply_interview_update` + `update_event` (both interviewer and candidate calendar events) on reschedules; delete via `apply_interview_delete` + `delete_event` on cancellations.
10. **Run the interview day & chase scorecards** — Check 1h before; nudge late participants; queue +2h scorecard reminder and fire autonomous +24h Slack DM scorecard chase (`24h_scorecard_chase`).
