import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_ROTATE_EVENT_COUNT,
  isContextOverflowError,
  shouldRotateHome,
} from '../src/core/orchestrator.js';

test('isContextOverflowError: matches the observed provider wordings', () => {
  assert.equal(isContextOverflowError('CONTEXT_WINDOW_EXCEEDED pi-ai detected context overflow for model "deepseek-v4-flash-0731"'), true);
  assert.equal(isContextOverflowError('pi-ai detected context overflow for model "gemini-3.8-flash"'), true);
  assert.equal(isContextOverflowError('context overflow'), true);
});

test('isContextOverflowError: unrelated turn errors do not trigger rotation', () => {
  assert.equal(isContextOverflowError('decision: whenIdle timeout'), false);
  assert.equal(isContextOverflowError('NO_ADAPTER'), false);
  assert.equal(isContextOverflowError('prompt variable "{{model}}" has no value'), false);
  assert.equal(isContextOverflowError(''), false);
});

test('shouldRotateHome: fires at the threshold, not below', () => {
  assert.equal(shouldRotateHome({ eventCount: HOME_ROTATE_EVENT_COUNT - 1 }), false);
  assert.equal(shouldRotateHome({ eventCount: HOME_ROTATE_EVENT_COUNT }), true);
  assert.equal(shouldRotateHome({ eventCount: 10, threshold: 10 }), true);
  assert.equal(shouldRotateHome({ eventCount: 9, threshold: 10 }), false);
});
