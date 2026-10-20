# Send gate (`send-gate.mjs`)

This Claude Code `PreToolUse` hook stops the interactive scheduling session from sending an email or Slack message whose exact wording Sam has not seen on screen. It ships in the repo through `.claude/settings.json`, so it applies to anyone who opens the project in Claude Code. The headless worker (`worker/pilot.mjs`) runs with `--setting-sources user` from outside the repo and never loads it.

## What the gate blocks

The hook looks only at MCP tool calls and matches them by the end of the tool name, because the server prefix differs per user. The `TOOLS` table at the top of `send-gate.mjs` holds the classification, and extending it means adding a row.

Message tools get the verbatim check: Gmail `send_message`, `reply` and `forward`, and Slack `slack_send_message` and `slack_schedule_message`. A call goes through only when Sam replied after the wording was shown to him. Concretely, the hook finds Sam's latest message in the session transcript and the one before it, takes the assistant's chat text printed between the two, and requires the outgoing body to appear in that text. For a Gmail call it also requires every `to`, `cc` and `bcc` address, the subject line, and every link URL in an `htmlBody` to appear there. A send by `draftId`, an empty body, a call from a subagent, and a transcript that cannot be read or parsed are all denied.

Calendar, Calendly, Notion calendar, Slack canvas and Greenhouse `apply_*` writes have no single body to compare, so the hook answers `ask`, and Claude Code then shows Sam the exact tool input in a permission prompt that the model cannot answer for him. Drafts (`create_draft`, `update_draft`, `slack_send_message_draft`), Greenhouse `preview_*` tools, Gmail label tools and every read pass through without a decision.

## How to show a draft so it passes

Print the full message as ordinary chat text in the reply that asks Sam: greeting through sign-off, and for an email the recipients and subject as well, then end the turn and wait for his answer. Markdown emphasis, quote markers, code fences, curly quotes, `--` versus an em dash, and line wrapping are all normalised away before the comparison, and a Slack `<@U123>` mention can be left out of the displayed version. Wording is compared case-sensitively, so a changed word fails. Text placed only in a tool input (a summary box), in a thinking block, in a subagent, or printed after Sam's latest message does not count. A message Sam typed while the model was still working counts from the moment he pressed enter, so text that appeared after that moment does not count as seen.

## Exceptions that go without Sam

`JOB.md` lets five actions proceed without Sam's OK. Each one is claimed through the shared ledger (`~/.recruiting-agents/scheduling-pilot/ledger.jsonl`, overridable with `SCHEDULING_LEDGER_PATH`) by an `action` record with `status: "intent"`, written less than 15 minutes before the call, carrying an `exception` field:

| `exception` | Covers |
| --- | --- |
| `step1_stage_move` | Greenhouse `apply_application_stage_move` |
| `step6_interviewer_role` | a Greenhouse `apply_*` tool whose name mentions a permission or role |
| `step8_standard_confirmation` | a Greenhouse `apply_*` tool whose name mentions an interview or confirmation |
| `step9_urgent_cancellation` | any message tool, when `draft_sha256` matches the body |
| `step10_live_nudge` | any message tool, when `draft_sha256` matches the body |

An intent already followed by a `dispatched` record with the same `action_key` no longer counts, and neither does one dated in the future. To get the `draft_sha256` for a message, pipe the exact tool input to the hook: `echo '<tool_input json>' | node .claude/hooks/send-gate.mjs --hash <tool_name>`. Every send allowed this way appends one line to `~/.recruiting-agents/scheduling-pilot/send-gate.log` (overridable with `SCHEDULING_SEND_GATE_LOG`) with the time, tool, exception and `action_key`, never the body.

## What the gate does not cover

- Anything sent by clicking in a browser: the Greenhouse UI (including the step 6 scheduling and step 8 confirmation click-paths), or Gmail and Slack driven through Chrome or computer use.
- Sends made from Bash or any other network call outside an MCP tool.
- Whether Sam's latest message actually approved the draft. The gate proves he saw the wording before replying; a reply of "no, don't send that" still unlocks it. Recording his approval against a hash of the draft is layer 2 of CLO-636.
- The thread a Gmail `reply` lands in, its implicit recipients, the original message a `forward` carries, and the channel a Slack message goes to.
- Honest ledger records. An exception relies on the model writing a truthful intent record, and the log is the audit trail for checking that it did.
- Permission modes that skip prompts: the `ask` path depends on Claude Code showing the permission prompt in the mode the session runs in.

## Tests

`node --test .claude/hooks/send-gate.test.mjs` drives the hook as a child process against synthetic transcripts and ledgers built in a temp directory.
