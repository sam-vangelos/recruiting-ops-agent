---
id: candidate-nudge
channel: gmail-reply
audience: candidate
derived_from: Scheduling Agent Blueprint section 4, "nudges a silent candidate once after 48 hours"
fields:
  - CANDIDATE_FIRST_NAME
  - INTERVIEWER_NAME
  - JOB_NAME
  - RECRUITER_FIRST_NAME
  - DISCLOSURE_LINE
max_words: 110
---
Hi {{CANDIDATE_FIRST_NAME}},

Checking in on the {{JOB_NAME}} conversation with {{INTERVIEWER_NAME}}. If you'd still like to go ahead, send me two or three windows that work over the next week and I'll get it on the calendar. If your plans have changed, a one-line reply is all I need.

Best,
{{RECRUITER_FIRST_NAME}}

{{DISCLOSURE_LINE}}
