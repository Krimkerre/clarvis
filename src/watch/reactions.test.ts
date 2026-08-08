import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reactionTo } from './reactions';
import { Outcome } from './BusyTracker';

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return {
    id: 'a',
    source: 'task',
    label: 'build',
    exitCode: 0,
    durationMs: 5000,
    ...overrides,
  };
}

test('a clean exit is met with quiet approval', () => {
  assert.equal(reactionTo(outcome({ exitCode: 0 })), 'impressed');
});

test('a failed build is genuinely alarming', () => {
  assert.equal(reactionTo(outcome({ exitCode: 1 })), 'surprised');
  assert.equal(reactionTo(outcome({ exitCode: 127 })), 'surprised');
});

test('work with no exit code is treated as skeptical, not alarming', () => {
  // A debug session ending, or a task the user cancelled themselves. Neither is a
  // failure, so neither earns the alarm face.
  assert.equal(reactionTo(outcome({ exitCode: undefined })), 'judging');
});
