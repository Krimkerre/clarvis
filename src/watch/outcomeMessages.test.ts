import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeMessage } from './outcomeMessages';
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

test('includes the label and duration', () => {
  const message = outcomeMessage(outcome({ label: 'build', durationMs: 5000 }));

  assert.match(message, /build/);
  assert.match(message, /5s/);
});

test('renders durations over a minute as minutes and seconds', () => {
  const message = outcomeMessage(outcome({ durationMs: 125_000 }));

  assert.match(message, /2m 5s/);
});

test('uses a different line pool for failures than successes', () => {
  // Sample repeatedly: the pools are picked at random, so a single call could
  // coincide by chance, but the two pools share no lines.
  const successLines = new Set(
    Array.from({ length: 50 }, () => outcomeMessage(outcome({ exitCode: 0 })))
  );
  const failureLines = new Set(
    Array.from({ length: 50 }, () => outcomeMessage(outcome({ exitCode: 1 })))
  );

  for (const line of successLines) {
    assert.ok(!failureLines.has(line), `"${line}" appeared in both pools`);
  }
});

test('treats a missing exit code as a failure, not a success', () => {
  // A cancelled task reports no exit code. It must not read as "all good".
  const cancelled = new Set(
    Array.from({ length: 50 }, () => outcomeMessage(outcome({ exitCode: undefined })))
  );
  const succeeded = new Set(
    Array.from({ length: 50 }, () => outcomeMessage(outcome({ exitCode: 0 })))
  );

  for (const line of cancelled) {
    assert.ok(!succeeded.has(line), `"${line}" was used for both cancelled and success`);
  }
});

test('collapses whitespace in a mangled label', () => {
  // Shell integration sometimes hands back the prompt and newlines glued onto the
  // command. The notification is one line — it must not contain raw newlines.
  const message = outcomeMessage(outcome({ label: 'echo hi\n╭─  ~/code   │ on master\n╰─' }));

  assert.ok(!message.includes('\n'), 'no raw newlines survive into the message');
  assert.match(message, /echo hi ╭─ ~\/code │ on master ╰─/);
});

test('truncates an overlong label', () => {
  const message = outcomeMessage(outcome({ label: 'x'.repeat(200) }));

  assert.ok(message.includes('…'), 'truncated labels are marked with an ellipsis');
  assert.ok(message.length < 150, `message stayed reasonable, got ${message.length} chars`);
});
