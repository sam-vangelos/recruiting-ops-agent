import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTime, formatWindow, normalizeZone, parseInstant, toZonedIso, wallParts, zoneNoun } from '../src/time.js';

test('normalizeZone maps every Greenhouse name the brief lists to IANA', () => {
  const cases: Array<[string, string]> = [
    ['Eastern Time (US & Canada)', 'America/New_York'],
    ['Central Time (US & Canada)', 'America/Chicago'],
    ['Mountain Time (US & Canada)', 'America/Denver'],
    ['Pacific Time (US & Canada)', 'America/Los_Angeles'],
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Bogota', 'America/Bogota'],
    ['Brasilia', 'America/Sao_Paulo'],
    ['London', 'Europe/London'],
  ];
  for (const [gh, iana] of cases) assert.equal(normalizeZone(gh), iana, gh);
});

test('normalizeZone passes valid IANA ids through and refuses offsets, abbreviations and nonsense', () => {
  assert.equal(normalizeZone('America/New_York'), 'America/New_York');
  assert.equal(normalizeZone('Asia/Kolkata'), 'Asia/Kolkata');
  assert.equal(normalizeZone('Europe/Berlin'), 'Europe/Berlin');
  assert.equal(normalizeZone('UTC'), 'UTC');
  assert.equal(normalizeZone('Europe/Kyiv'), 'Europe/Kyiv', 'modern ids are not rewritten to ICU legacy names');
  assert.equal(normalizeZone('america/new_york'), 'America/New_York', 'letter case is corrected');
  for (const bad of ['ET', 'EST', '+05:30', 'UTC-4', 'Nowhere/Land', '', 'Pacific Time']) {
    assert.throws(() => normalizeZone(bad), /time zone/, bad);
  }
});

test('formatTime writes the zone in words, as the README example', () => {
  assert.equal(formatTime('2026-10-09T20:30:00Z', 'America/New_York'), 'Friday, October 9 at 4:30 pm Eastern Time');
  assert.equal(formatTime('2026-10-09T13:30:00-07:00', 'America/Los_Angeles'), 'Friday, October 9 at 1:30 pm Pacific Time');
  assert.equal(formatTime('2026-10-12T06:30:00Z', 'Asia/Kolkata'), 'Monday, October 12 at 12:00 pm India Standard Time');
  assert.equal(formatTime('2026-10-09T04:00:00Z', 'America/New_York'), 'Friday, October 9 at 12:00 am Eastern Time');
});

test('zoneNoun gives the generic name, and the IANA id where Intl only has a GMT offset', () => {
  assert.equal(zoneNoun('America/New_York'), 'Eastern Time');
  assert.equal(zoneNoun('America/Los_Angeles'), 'Pacific Time');
  assert.equal(zoneNoun('UTC'), 'UTC');
});

test('formatWindow: one am/pm when shared, both when they differ, both dates across midnight', () => {
  assert.equal(formatWindow('2026-10-09T20:30:00Z', '2026-10-09T21:00:00Z', 'America/Los_Angeles'), 'Friday, October 9, 2026, 1:30 to 2:00 pm Pacific Time');
  assert.equal(
    formatWindow('2026-10-12T11:30:00-07:00', '2026-10-12T12:00:00-07:00', 'America/Los_Angeles'),
    'Monday, October 12, 2026, 11:30 am to 12:00 pm Pacific Time',
  );
  assert.equal(
    formatWindow('2026-10-12T23:30:00-07:00', '2026-10-13T00:30:00-07:00', 'America/Los_Angeles'),
    'Monday, October 12, 2026, 11:30 pm to Tuesday, October 13, 2026, 12:30 am Pacific Time',
  );
  assert.throws(() => formatWindow('2026-10-12T12:00:00Z', '2026-10-12T12:00:00Z', 'UTC'), /not after/);
});

test('the DST-gap week: Europe has left summer time on 25 October 2026, the US not until 1 November', () => {
  // 28 Oct 2026, 15:00 UTC: London is on GMT (UTC+0), New York still on EDT (UTC-4). The gap is 4 hours, not 5.
  const iso = '2026-10-28T15:00:00Z';
  assert.equal(formatTime(iso, 'Europe/London'), 'Wednesday, October 28 at 3:00 pm United Kingdom Time');
  assert.equal(formatTime(iso, 'America/New_York'), 'Wednesday, October 28 at 11:00 am Eastern Time');
  assert.equal(toZonedIso(iso, 'Europe/London'), '2026-10-28T15:00:00+00:00');
  assert.equal(toZonedIso(iso, 'America/New_York'), '2026-10-28T11:00:00-04:00');
  // A week earlier both are on summer time and the gap is the usual 5 hours.
  assert.equal(toZonedIso('2026-10-21T15:00:00Z', 'Europe/London'), '2026-10-21T16:00:00+01:00');
  assert.equal(toZonedIso('2026-10-21T15:00:00Z', 'America/New_York'), '2026-10-21T11:00:00-04:00');
  // And a week later both have left it: the gap is 5 hours again.
  assert.equal(formatTime('2026-11-04T15:00:00Z', 'America/New_York'), 'Wednesday, November 4 at 10:00 am Eastern Time');
});

test('wallParts reads the zone calendar day, weekday and offset (no UTC leakage)', () => {
  // 01:00 UTC Saturday is still Friday evening in Los Angeles.
  const p = wallParts('2026-10-10T01:00:00Z', 'America/Los_Angeles');
  assert.equal(p.date, '2026-10-09');
  assert.equal(p.hm, '18:00');
  assert.equal(p.isoWeekday, 5);
  assert.equal(p.offset, '-07:00');
  assert.equal(wallParts('2026-10-10T01:00:00Z', 'Asia/Kolkata').offset, '+05:30');
});

test('parseInstant demands an explicit offset', () => {
  assert.equal(parseInstant('2026-10-09T20:30:00Z'), Date.UTC(2026, 9, 9, 20, 30));
  assert.throws(() => parseInstant('2026-10-09T20:30:00'), /offset/);
  assert.throws(() => parseInstant('Friday'), /offset/);
});
