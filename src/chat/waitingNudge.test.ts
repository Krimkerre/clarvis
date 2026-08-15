import test from 'node:test';
import assert from 'node:assert/strict';
import { nudgeDelay, nudgeLine } from './waitingNudge';

test('the first nudge is soon enough to save a build', () => {
  // A parked run costs the whole build, so this is not the place for patience.
  const first = nudgeDelay(1)!;

  assert.ok(first >= 30_000 && first <= 60_000, `${first}ms`);
});

test('each nudge waits longer than the last', () => {
  assert.ok(nudgeDelay(2)! > nudgeDelay(1)!);
  assert.ok(nudgeDelay(3)! > nudgeDelay(2)!);
});

test('it gives up rather than repeating forever', () => {
  // Someone who has not answered in five minutes has left the desk, and a voice
  // repeating itself into an empty room is what gets a product uninstalled.
  assert.equal(nudgeDelay(4), undefined);
  assert.equal(nudgeDelay(0), undefined);
});

test('total patience is minutes, not seconds or hours', () => {
  const total = [1, 2, 3].reduce((sum, attempt) => sum + (nudgeDelay(attempt) ?? 0), 0);

  assert.ok(total > 3 * 60_000 && total < 10 * 60_000, `${total}ms`);
});

test('each line escalates in what it says, not in temper', () => {
  const lines = [1, 2, 3].map((attempt) => nudgeLine(attempt, 'Write src/main.go'));

  // The question always comes with it: heard from another room, "still waiting" alone
  // is not enough to act on.
  for (const line of lines) assert.match(line, /Write src\/main\.go/);

  assert.match(lines[1], /parked/);
  assert.match(lines[2], /stop asking/);
  // Rule 4: the situation is nobody's fault, and none of these is cross about it.
  for (const line of lines) assert.doesNotMatch(line, /\byou (still )?(haven't|have not|didn't)\b/i);
});
