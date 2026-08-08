import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusyTracker, Outcome } from './BusyTracker';

/**
 * Records everything a tracker emits, so each test can assert on the exact
 * sequence of events rather than just the final state.
 */
function recordEvents(tracker: BusyTracker) {
  const busyChanges: boolean[] = [];
  const outcomes: Outcome[] = [];
  tracker.onBusyChange((busy) => busyChanges.push(busy));
  tracker.onOutcome((outcome) => outcomes.push(outcome));
  return { busyChanges, outcomes };
}

test('reports busy on first start and idle on last end', () => {
  const tracker = new BusyTracker();
  const { busyChanges } = recordEvents(tracker);

  tracker.start('a', 'task', 'build');
  tracker.end('a', 0);

  assert.deepEqual(busyChanges, [true, false]);
});

test('stays busy while overlapping jobs are still running', () => {
  // The M3 checklist case: start a task, run a terminal command before it
  // finishes, and confirm ending just one doesn't report idle prematurely.
  const tracker = new BusyTracker();
  const { busyChanges } = recordEvents(tracker);

  tracker.start('task', 'task', 'slow build');
  tracker.start('cmd', 'terminal', 'echo hi');
  tracker.end('cmd', 0);

  assert.deepEqual(busyChanges, [true], 'no idle while the task is still running');

  tracker.end('task', 0);

  assert.deepEqual(busyChanges, [true, false], 'idle only once everything finished');
});

test('reports each repeated failure separately', () => {
  // Three identical failing runs must produce three distinct outcomes, each with
  // its own exit code — no coalescing, no dropped events.
  const tracker = new BusyTracker();
  const { outcomes } = recordEvents(tracker);

  for (const attempt of ['first', 'second', 'third']) {
    tracker.start(attempt, 'terminal', 'npm test');
    tracker.end(attempt, 1);
  }

  assert.equal(outcomes.length, 3);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.exitCode),
    [1, 1, 1]
  );
});

test('ignores an end for an id that was never started', () => {
  // This is what makes debug-session dedup work: wireBusyTracker skips start() for
  // a nested child session, so the child's end() must be a harmless no-op.
  const tracker = new BusyTracker();
  const { busyChanges, outcomes } = recordEvents(tracker);

  tracker.end('never-started', 0);

  assert.deepEqual(busyChanges, []);
  assert.deepEqual(outcomes, []);
});

test('ignores a duplicate start for the same id', () => {
  const tracker = new BusyTracker();
  const { busyChanges } = recordEvents(tracker);

  tracker.start('a', 'task', 'build');
  tracker.start('a', 'task', 'build');
  tracker.end('a', 0);

  assert.deepEqual(busyChanges, [true, false], 'one end still clears the busy state');
});

test('passes the source, label, and exit code through to the outcome', () => {
  const tracker = new BusyTracker();
  const { outcomes } = recordEvents(tracker);

  tracker.start('a', 'terminal', 'npm run build');
  tracker.end('a', 2);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].source, 'terminal');
  assert.equal(outcomes[0].label, 'npm run build');
  assert.equal(outcomes[0].exitCode, 2);
});

test('reports an undefined exit code rather than assuming success', () => {
  // Debug sessions end without an exit code. Consumers must be able to tell that
  // apart from a genuine zero, so it has to survive as undefined.
  const tracker = new BusyTracker();
  const { outcomes } = recordEvents(tracker);

  tracker.start('session', 'debug', 'Probe Debug Target');
  tracker.end('session', undefined);

  assert.equal(outcomes[0].exitCode, undefined);
  assert.notEqual(outcomes[0].exitCode, 0);
});

test('measures how long a job ran', async () => {
  const tracker = new BusyTracker();
  const { outcomes } = recordEvents(tracker);

  tracker.start('a', 'task', 'build');
  await new Promise((resolve) => setTimeout(resolve, 20));
  tracker.end('a', 0);

  assert.ok(
    outcomes[0].durationMs >= 15,
    `expected a measurable duration, got ${outcomes[0].durationMs}ms`
  );
});
