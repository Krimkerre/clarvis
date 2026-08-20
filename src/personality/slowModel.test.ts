import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldTell, slowModelLine, SlowModelWatch, TELL_AFTER_TIMEOUTS } from './slowModel';

test('one missed deadline is a blip, not a pattern', () => {
  // Measured: a cold JIT load in LM Studio took 5.3s against a 5s deadline, on a
  // model that is quick once warm. Announcing on the first miss would fire every
  // time someone switches model.
  const watch = new SlowModelWatch();
  assert.equal(watch.missedDeadline(), false);
});

test('the second missed deadline earns the telling', () => {
  const watch = new SlowModelWatch();
  watch.missedDeadline();
  assert.equal(watch.missedDeadline(), true);
});

test('it is said once, however many more are missed', () => {
  const watch = new SlowModelWatch();
  watch.missedDeadline();
  assert.equal(watch.missedDeadline(), true);

  for (let i = 0; i < 10; i++) {
    assert.equal(watch.missedDeadline(), false, 'nagging is the failure this guards against');
  }
});

test('the count keeps rising after the telling, for the log', () => {
  const watch = new SlowModelWatch();
  for (let i = 0; i < 5; i++) watch.missedDeadline();
  assert.equal(watch.count, 5);
});

test('shouldTell needs both the threshold and a first time', () => {
  assert.equal(shouldTell(TELL_AFTER_TIMEOUTS, false), true);
  assert.equal(shouldTell(TELL_AFTER_TIMEOUTS - 1, false), false);
  assert.equal(shouldTell(TELL_AFTER_TIMEOUTS, true), false, 'already told');
});

test('the line names the provider and the model, and offers no button', () => {
  const line = slowModelLine('LM Studio', 'phi-4-mini-instruct');
  assert.match(line, /LM Studio/);
  assert.match(line, /phi-4-mini-instruct/);
  // The consequence the user actually noticed comes before the cause.
  assert.ok(line.indexOf('written lines') < line.indexOf('taking longer'));
  // Says nothing is broken -- the fallback is the design working, not a failure.
  assert.match(line, /Nothing is broken/);
});
