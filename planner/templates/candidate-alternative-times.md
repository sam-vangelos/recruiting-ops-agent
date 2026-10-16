---
id: candidate-alternative-times
channel: gmail-reply
audience: candidate
derived_from: Scheduling Agent Blueprint section 6, "when the candidate's times don't fit", reworded to hold after a decline too
fields:
  - CANDIDATE_FIRST_NAME
  - INTERVIEWER_NAME
  - INTERVIEW_DURATION_MIN
  - JOB_NAME
  - ALTERNATIVE_SLOTS
  - RECRUITER_FIRST_NAME
  - DISCLOSURE_LINE
max_words: 140
---
Hi {{CANDIDATE_FIRST_NAME}},

Thanks for your patience. {{INTERVIEWER_NAME}}, who runs the {{INTERVIEW_DURATION_MIN}}-minute conversation for the {{JOB_NAME}} role, isn't free at the time we had in mind, but these are open, shown in your time zone:

{{ALTERNATIVE_SLOTS}}

Reply with the one that suits you. If none of these work, tell me what does and I'll find another slot.

Best,
{{RECRUITER_FIRST_NAME}}

{{DISCLOSURE_LINE}}
