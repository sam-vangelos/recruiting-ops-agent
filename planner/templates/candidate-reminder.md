---
id: candidate-reminder
channel: gmail-reply
audience: candidate
derived_from: Greenhouse 4155637004 "0 - Reminder for upcoming interview", its "(add date)" placeholders replaced with fields
fields:
  - CANDIDATE_FIRST_NAME
  - INTERVIEWER_NAME
  - INTERVIEW_TIME_CANDIDATE
  - INTERVIEW_DURATION_MIN
  - MEET_LINK
  - RECRUITER_FIRST_NAME
  - DISCLOSURE_LINE
max_words: 120
---
Hi {{CANDIDATE_FIRST_NAME}},

A quick reminder that your {{INTERVIEW_DURATION_MIN}}-minute interview with {{INTERVIEWER_NAME}} is tomorrow, {{INTERVIEW_TIME_CANDIDATE}}, on Google Meet: {{MEET_LINK}}.

Please join a few minutes early. If anything has come up and you need to move it, reply here as soon as you can so I can let {{INTERVIEWER_NAME}} know.

Best,
{{RECRUITER_FIRST_NAME}}

{{DISCLOSURE_LINE}}
