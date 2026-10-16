/**
 * The interview record's state machine, exactly WORKFLOW.md's "States" table. Any (state, event) pair
 * the table does not define throws; the terminal states accept nothing.
 */

export const STATES = [
  'detected',
  'awaiting_availability',
  'slot_proposed',
  'held',
  'confirming',
  'confirmed',
  'rescheduling',
  'no_fit',
  'escalated',
  'handed_off',
  'done',
] as const;
export type State = (typeof STATES)[number];

export const EVENTS = [
  'availability_received',
  'no_availability',
  'slot_found',
  'no_slot',
  'hold_dispatched',
  'interviewer_accepted',
  'interviewer_declined',
  'interviewer_silent_past_threshold',
  'candidate_confirmed',
  'move_requested',
  'candidate_withdrew',
  'person_intervened',
  'interview_ended',
  'alternatives_sent',
  'new_hold_placed',
  'recruiter_took_over',
  'interviewer_responded_accept',
  'interviewer_responded_decline',
  'nudge_sent',
  'nudge_exhausted',
] as const;
export type StateEvent = (typeof EVENTS)[number];

export const TERMINAL_STATES: readonly State[] = ['handed_off', 'done'];

/** Row by row from the table's "Leaves on" column. `person_intervened` is added to every non-terminal row below. */
const TABLE: Record<State, Partial<Record<StateEvent, State>>> = {
  // "Candidate availability present → slot_proposed; none → awaiting_availability."
  detected: { availability_received: 'slot_proposed', no_availability: 'awaiting_availability' },
  // "Availability received → slot_proposed; 48 h silence → one nudge; another 48 h → handed_off."
  awaiting_availability: { availability_received: 'slot_proposed', nudge_sent: 'awaiting_availability', nudge_exhausted: 'handed_off' },
  // "A slot was found and the hold event is queued" (slot_found re-affirms it);
  // "Hold written and candidate reply sent → held; no slot within five working days → no_fit."
  slot_proposed: { slot_found: 'slot_proposed', hold_dispatched: 'held', no_slot: 'no_fit' },
  // "Interviewer accepted → confirming; declined → rescheduling; needsAction past the nudge thresholds → Slack nudge, then escalated."
  held: {
    interviewer_accepted: 'confirming',
    interviewer_declined: 'rescheduling',
    nudge_sent: 'held',
    interviewer_silent_past_threshold: 'escalated',
  },
  // "Both dispatched and Greenhouse interview recorded → confirmed."
  confirming: { candidate_confirmed: 'confirmed' },
  // "Interview end time passes → done; either party asks to move → rescheduling; candidate withdraws → handed_off."
  confirmed: { interview_ended: 'done', move_requested: 'rescheduling', candidate_withdrew: 'handed_off' },
  // "Candidate offered 3 to 5 new slots (candidate-alternative-times) or a new hold placed → held."
  rescheduling: { alternatives_sent: 'awaiting_availability', new_hold_placed: 'held' },
  // "candidate-alternative-times sent → awaiting_availability."
  no_fit: { alternatives_sent: 'awaiting_availability' },
  // "Interviewer responds → confirming or rescheduling; recruiter takes over → handed_off."
  escalated: { interviewer_responded_accept: 'confirming', interviewer_responded_decline: 'rescheduling', recruiter_took_over: 'handed_off' },
  handed_off: {},
  done: {},
};

for (const s of STATES) if (!TERMINAL_STATES.includes(s)) TABLE[s].person_intervened = 'handed_off';

export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Every defined (from, event, to) triple, for tests and for printing the machine. */
export function transitions(): Array<{ from: State; event: StateEvent; to: State }> {
  return STATES.flatMap((from) => Object.entries(TABLE[from]).map(([event, to]) => ({ from, event: event as StateEvent, to: to as State })));
}

export function transition(state: State, event: StateEvent): State {
  if (!STATES.includes(state)) throw new Error(`unknown state ${JSON.stringify(state)}`);
  if (!EVENTS.includes(event)) throw new Error(`unknown event ${JSON.stringify(event)}`);
  if (isTerminal(state)) throw new Error(`state ${state} is terminal; event ${event} is refused`);
  const next = TABLE[state][event];
  if (next === undefined) throw new Error(`no transition from state ${state} on event ${event}`);
  return next;
}
