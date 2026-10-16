# Templates

One file per outgoing message. The front matter is the contract the renderer (`src/templates.ts`) enforces; the body is the text. `{{FIELD}}` is a merge field. Every field named under `fields` must be supplied, non-empty, or the render fails and nothing is sent. A field under `optional_fields` may be absent or empty; a line that renders to nothing because its only content was an empty optional field is dropped, together with one blank line that followed it.

Front matter keys:

- `id`: file name without extension; what the state machine asks for.
- `channel`: `gmail-reply` (sent in the candidate's existing thread, subject `Re: <thread subject>`), `calendar-description` (the event's description; `summary` gives the title).
- `audience`: `candidate` or `interviewer`.
- `derived_from`: the Greenhouse template id and name, or the message this was lifted from.
- `fields`, `optional_fields`: the merge fields.
- `max_words`: the guard's word cap for the rendered body, signature included.
- `summary`: calendar channel only, the event title with merge fields.

Field vocabulary (the renderer accepts no others):

| Field | Meaning |
|---|---|
| `CANDIDATE_FIRST_NAME` | First name exactly as Greenhouse stores it |
| `CANDIDATE_NAME` | Full name as Greenhouse stores it |
| `CANDIDATE_LOCATION` | City or city and state as the candidate gave it |
| `JOB_NAME` | Greenhouse job name, e.g. "Field Engineer, AI Labs" |
| `INTERVIEWER_NAME` | Interviewer's full name |
| `INTERVIEWER_FIRST_NAME` | Interviewer's first name |
| `INTERVIEWER_TITLE` | Interviewer's title, e.g. "Hiring Manager, AI Labs" |
| `INTERVIEW_TIME_CANDIDATE` | Start time in the candidate's zone, zone in words: "Friday, October 9 at 4:30 pm Eastern Time" |
| `INTERVIEW_TIME_INTERVIEWER` | Start time in the interviewer's zone, zone in words |
| `INTERVIEW_WINDOW_INTERVIEWER` | Start to end in the interviewer's zone: "Friday, October 9, 2026, 1:30 to 2:00 pm Pacific Time" |
| `INTERVIEW_DURATION_MIN` | Length in minutes, digits only |
| `MEET_LINK` | The Google Meet URL for this event |
| `INTERVIEW_KIT_LINK` | `https://app4.greenhouse.io/guides/<kit>/people/<candidate>?application_id=<application>` |
| `ALTERNATIVE_SLOTS` | A pre-rendered list of 3 to 5 lines, each a time in the candidate's zone, built by code from calendar-confirmed slots |
| `CANDIDATE_SUMMARY` | Two or three sentences for the interviewer, from the recruiter's screen notes |
| `RULING_LINE` | e.g. "Your 8 Oct ruling: yes." Empty when the interviewer gave none |
| `RECRUITER_ADDITIONS` | The recruiter's own extras for this req, e.g. a prep-call line. Empty when none |
| `RECRUITER_FIRST_NAME` | "Sam" |
| `RECRUITER_FULL_NAME` | "Sam Vangelos" |
| `RECRUITER_TITLE` | Sam's Greenhouse job title |
| `DISCLOSURE_LINE` | The AI disclosure sentence (CLO-278). Draft until legal rules: "Scheduling for this interview is handled with Turing's AI assistant on Sam's behalf; reply here and Sam reads it directly." |
| `NEW_INTERVIEW_TIME_CANDIDATE` | For reschedules: the new start in the candidate's zone |
| `OLD_INTERVIEW_TIME_CANDIDATE` | For reschedules: the start being replaced |
| `DAYS_SILENT` | For the nudge: digits |
