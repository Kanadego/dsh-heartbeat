import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_ROTATE_EVENT_COUNT,
  isContextOverflowError,
  shouldRotateHome,
  shouldArchiveRotatedHome,
  buildEngineRoomAllowList,
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

test('shouldArchiveRotatedHome: archives a real, distinct previous home when enabled', () => {
  assert.equal(shouldArchiveRotatedHome({ old: 'session-a', realId: 'session-b', enabled: true }), true);
  // first boot (no saved home), identity no-op, and policy opt-out all skip
  assert.equal(shouldArchiveRotatedHome({ old: undefined, realId: 'session-b', enabled: true }), false);
  assert.equal(shouldArchiveRotatedHome({ old: null, realId: 'session-b', enabled: true }), false);
  assert.equal(shouldArchiveRotatedHome({ old: 'session-b', realId: 'session-b', enabled: true }), false);
  assert.equal(shouldArchiveRotatedHome({ old: 'session-a', realId: 'session-b', enabled: false }), false);
});

test('buildEngineRoomAllowList: compression tools only when globally present', () => {
  // bili absent: plain mask
  assert.deepEqual(buildEngineRoomAllowList(['ledger', 'bash']), ['web_search']);
  // bili tools present: auto-included in stable order
  assert.deepEqual(
    buildEngineRoomAllowList(['acp_status', 'compress', 'ledger']),
    ['web_search', 'compress', 'acp_status'],
  );
  // search_context is NEVER auto-added (dsh-acp same-name incident)
  assert.deepEqual(buildEngineRoomAllowList(['search_context']), ['web_search']);
  // config extras apply only when the tool exists, deduped
  assert.deepEqual(
    buildEngineRoomAllowList(['compress', 'webfetch'], ['compress', 'webfetch', ' ghost ']),
    ['web_search', 'compress', 'webfetch'],
  );
});
