// Quiet-hours helpers (v2.2 panel entry): pure functions, no sandbox needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeHhMm, resolveQuietHours } from '../src/config/quiet-hours.js';

const CURRENT = { start: '01:30', end: '06:30' };

test('quiet-hours: normalizeHhMm accepts strict HH:MM boundaries', () => {
  assert.equal(normalizeHhMm('00:00'), '00:00');
  assert.equal(normalizeHhMm('23:59'), '23:59');
  assert.equal(normalizeHhMm('01:30'), '01:30');
});

test('quiet-hours: normalizeHhMm rejects every non-conforming shape', () => {
  assert.equal(normalizeHhMm('24:00'), null); // hour out of range
  assert.equal(normalizeHhMm('1:30'), null); // single-digit hour
  assert.equal(normalizeHhMm('01:60'), null); // minute out of range
  assert.equal(normalizeHhMm('0130'), null); // missing separator
  assert.equal(normalizeHhMm(''), null);
  assert.equal(normalizeHhMm(' 01:30'), null); // surrounding whitespace
  assert.equal(normalizeHhMm(null), null);
  assert.equal(normalizeHhMm(undefined), null);
  assert.equal(normalizeHhMm(123), null);
  assert.equal(normalizeHhMm({ start: '01:30' }), null);
});

test('quiet-hours: resolveQuietHours uses both new values when both are valid', () => {
  assert.deepEqual(resolveQuietHours('07:00', '09:15', CURRENT), { start: '07:00', end: '09:15' });
});

test('quiet-hours: resolveQuietHours keeps current for the missing side', () => {
  assert.deepEqual(resolveQuietHours('07:00', undefined, CURRENT), { start: '07:00', end: '06:30' });
  assert.deepEqual(resolveQuietHours(undefined, '09:15', CURRENT), { start: '01:30', end: '09:15' });
  assert.deepEqual(resolveQuietHours(null, '09:15', CURRENT), { start: '01:30', end: '09:15' });
});

test('quiet-hours: resolveQuietHours returns null for any given-but-invalid value', () => {
  assert.equal(resolveQuietHours('24:00', '09:15', CURRENT), null);
  assert.equal(resolveQuietHours('07:00', '1:30', CURRENT), null);
  assert.equal(resolveQuietHours('', '09:15', CURRENT), null);
  assert.equal(resolveQuietHours(123, '09:15', CURRENT), null);
});

test('quiet-hours: resolveQuietHours returns current when neither value is given', () => {
  assert.deepEqual(resolveQuietHours(undefined, undefined, CURRENT), CURRENT);
  assert.deepEqual(resolveQuietHours(null, null, CURRENT), CURRENT);
  assert.deepEqual(resolveQuietHours(undefined, null, CURRENT), CURRENT);
});

test('quiet-hours: resolveQuietHours does not mutate current', () => {
  resolveQuietHours('07:00', undefined, CURRENT);
  assert.deepEqual(CURRENT, { start: '01:30', end: '06:30' });
});
