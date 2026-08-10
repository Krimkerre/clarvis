import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, modeSpec, canEdit } from './modes';

test('only auto and agent may change files', () => {
  // The reason the setting exists. If this ever inverts, a "chat only" mode starts
  // editing a codebase — the exact failure the user asked to be able to prevent.
  assert.equal(canEdit('auto'), true);
  assert.equal(canEdit('agent'), true);
  assert.equal(canEdit('chat'), false);
  assert.equal(canEdit('plan'), false);
});

test('an unknown mode falls back to auto rather than to nothing', () => {
  // A typo in settings must not leave Clarvis inert with no explanation.
  assert.equal(modeSpec('nonsense').id, 'auto');
  assert.equal(modeSpec('').id, 'auto');
});

test('every mode says plainly what it will and will not do', () => {
  for (const mode of MODES) {
    assert.ok(mode.short.length > 0 && mode.short.length <= 6, mode.id);
    assert.ok(mode.detail.length > 20, mode.id);
  }
});
