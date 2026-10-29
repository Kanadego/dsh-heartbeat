// H-88 (2026-10-29): "today" is a human day. The rhythm ring, the ledger's
// aging cutoff and the export filenames all used `toISOString().slice(0,10)`,
// i.e. a UTC day, so in UTC+8 the day rolled over at 08:00 local and every
// daily budget reset mid-morning. One shared local key now serves them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localDayKey } from '../src/core/time-window.js';

test('localDayKey reports the local calendar day', () => {
  assert.equal(localDayKey(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
  assert.equal(localDayKey(new Date(2026, 11, 31, 23, 30)), '2026-12-31');
  assert.equal(localDayKey(new Date(2026, 6, 4, 12, 0)), '2026-07-04'); // month is 1-based
});

test('localDayKey pads month and day', () => {
  assert.equal(localDayKey(new Date(2026, 2, 9, 9, 0)), '2026-03-09');
});
