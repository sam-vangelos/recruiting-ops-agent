import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENTS, STATES, TERMINAL_STATES, transition, transitions, type State, type StateEvent } from '../src/states.js';

/** WORKFLOW.md's States table, row by row, plus person_intervened → handed_off from every non-terminal state. */
const TABLE: Array<[State, StateEvent, State]> = [
  ['detected', 'availability_received', 'slot_proposed'],
  ['detected', 'no_availability', 'awaiting_availability'],
  ['awaiting_availability', 'availability_received', 'slot_proposed'],
  ['awaiting_availability', 'nudge_sent', 'awaiting_availability'],
  ['awaiting_availability', 'nudge_exhausted', 'handed_off'],
  ['slot_proposed', 'slot_found', 'slot_proposed'],
  ['slot_proposed', 'hold_dispatched', 'held'],
  ['slot_proposed', 'no_slot', 'no_fit'],
  ['held', 'interviewer_accepted', 'confirming'],
  ['held', 'interviewer_declined', 'rescheduling'],
  ['held', 'nudge_sent', 'held'],
  ['held', 'interviewer_silent_past_threshold', 'escalated'],
  ['confirming', 'candidate_confirmed', 'confirmed'],
  ['confirmed', 'interview_ended', 'done'],
  ['confirmed', 'move_requested', 'rescheduling'],
  ['confirmed', 'candidate_withdrew', 'handed_off'],
  ['rescheduling', 'alternatives_sent', 'awaiting_availability'],
  ['rescheduling', 'new_hold_placed', 'held'],
  ['no_fit', 'alternatives_sent', 'awaiting_availability'],
  ['escalated', 'interviewer_responded_accept', 'confirming'],
  ['escalated', 'interviewer_responded_decline', 'rescheduling'],
  ['escalated', 'recruiter_took_over', 'handed_off'],
  ...STATES.filter((s) => !TERMINAL_STATES.includes(s)).map((s): [State, StateEvent, State] => [s, 'person_intervened', 'handed_off']),
];

test('every transition in the table, and nothing else, is defined', () => {
  for (const [from, event, to] of TABLE) assert.equal(transition(from, event), to, `${from} --${event}-->`);
  const key = (f: string, e: string, t: string) => `${f} ${e} ${t}`;
  assert.deepEqual(
    new Set(transitions().map((t) => key(t.from, t.event, t.to))),
    new Set(TABLE.map(([f, e, t]) => key(f, e, t))),
  );
});

test('every undefined pair throws, naming the state and the event', () => {
  const defined = new Set(TABLE.map(([f, e]) => `${f} ${e}`));
  let refused = 0;
  for (const s of STATES) {
    for (const e of EVENTS) {
      if (defined.has(`${s} ${e}`)) continue;
      assert.throws(() => transition(s, e), (err: Error) => err.message.includes(s) && err.message.includes(e), `${s} ${e}`);
      refused++;
    }
  }
  assert.ok(refused > 150);
  assert.throws(() => transition('held', 'candidate_confirmed'), /held.*candidate_confirmed/);
});

test('terminal states refuse every event, person_intervened included', () => {
  assert.deepEqual([...TERMINAL_STATES], ['handed_off', 'done']);
  for (const s of TERMINAL_STATES) {
    for (const e of EVENTS) assert.throws(() => transition(s, e), /terminal/);
  }
});

test('unknown states and events are refused', () => {
  assert.throws(() => transition('booked' as State, 'slot_found'), /unknown state/);
  assert.throws(() => transition('held', 'teleported' as StateEvent), /unknown event/);
});
