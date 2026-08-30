import assert from 'node:assert/strict';
import test from 'node:test';

import { isTaskTerminal } from './isTaskTerminal';

const running = (...names: string[]) => new Set(names);

test('a terminal already identified as a task terminal stays identified', () => {
  // Ordering-proof, and the only rule that holds for a reused terminal: the
  // shell execution starts before the task event there.
  assert.equal(isTaskTerminal('anything', true, running()), true);
});

test('a terminal named after a running task is one', () => {
  // The rule that was missing. Measured under code-server: one task run produced
  // both an `outcome task` and an `outcome terminal` line, 3 ms apart, because
  // the host had already named the task's terminal when its execution started.
  assert.equal(isTaskTerminal('stage9-task-probe', false, running('stage9-task-probe')), true);
});

test('an unnamed terminal while a task runs is one', () => {
  // The host that has not named it yet — the case the original rule covered.
  assert.equal(isTaskTerminal('', false, running('build')), true);
});

test('an unnamed terminal with no task running is not one', () => {
  // Otherwise every shell that starts before its first command would be swallowed.
  assert.equal(isTaskTerminal('', false, running()), false);
});

test('a user terminal is not a task terminal', () => {
  assert.equal(isTaskTerminal('zsh', false, running('build')), false);
});

test('a terminal named after a task that has finished is not one', () => {
  // `runningTaskNames` is emptied on end, so the name stops matching. Without
  // this the terminal a task left behind would swallow every command typed into
  // it afterwards — which `taskTerminals` does deliberately, and only because
  // that set is what VS Code hands back for a genuine task reuse.
  assert.equal(isTaskTerminal('build', false, running()), false);
});
