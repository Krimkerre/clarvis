import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingChoice } from './PendingChoice';

function harness() {
  const offered: { label: string }[][] = [];
  const pending = new PendingChoice((items) => offered.push(items as { label: string }[]));
  return { pending, offered };
}

const YES_NO = [{ label: 'Do it' }, { label: 'Skip this step' }];

test('the answer comes back as the label that was offered', async () => {
  const { pending } = harness();

  const answer = pending.ask(YES_NO);
  pending.supply('Do it');

  assert.equal(await answer, 'Do it');
});

test('case and numbers both reach the right option', async () => {
  // People type "1" because the panel used to number these, and "do it" because
  // capitals are not how anyone answers a question in a chat box.
  const { pending } = harness();

  const lower = pending.ask(YES_NO);
  pending.supply('do it');
  assert.equal(await lower, 'Do it');

  const numbered = pending.ask(YES_NO);
  pending.supply('2');
  assert.equal(await numbered, 'Skip this step');
});

test('typing something else comes back as itself', async () => {
  // The buttons are the fast path, not the only one: "no, use the other library" is
  // an answer no button could have carried.
  const { pending } = harness();

  const answer = pending.ask(YES_NO);
  pending.supply('no, do the other one');

  assert.equal(await answer, 'no, do the other one');
});

test('buttons appear on the ask and are cleared on the answer', async () => {
  const { pending, offered } = harness();

  const answer = pending.ask(YES_NO);
  assert.deepEqual(offered[0], YES_NO);

  pending.supply('Do it');
  await answer;
  assert.deepEqual(offered[1], []);
});

test('cancelling resolves rather than leaving the run hung', async () => {
  // Every caller treats undefined as "no answer", so a stopped run unwinds through
  // paths that already exist instead of waiting forever on a panel that has gone.
  const { pending } = harness();

  const answer = pending.ask(YES_NO);
  pending.cancel();

  assert.equal(await answer, undefined);
  assert.equal(pending.isWaiting, false);
});

test('a second question does not strand the first', async () => {
  const { pending } = harness();

  const first = pending.ask(YES_NO);
  const second = pending.ask(YES_NO);
  pending.supply('Do it');

  assert.equal(await first, undefined);
  assert.equal(await second, 'Do it');
});

test('a message with nothing waiting is dropped, not queued', async () => {
  // Queueing would answer a later question with an earlier message.
  const { pending } = harness();
  pending.supply('Do it');

  const answer = pending.ask(YES_NO);
  pending.supply('Skip this step');

  assert.equal(await answer, 'Skip this step');
});

test('a question with nothing to nudge about stays silent', async () => {
  // Not every caller blocks a build, and the ones that do not have no business
  // talking to an empty room.
  const spoken: string[] = [];
  const pending = new PendingChoice(() => {}, (line) => spoken.push(line));

  const answer = pending.ask(YES_NO);
  pending.supply('Do it');
  await answer;

  assert.deepEqual(spoken, []);
});

test('answering stops the reminders that were queued', async () => {
  // The timer outlives the question otherwise, and a nudge about a step that already
  // ran is worse than no nudge at all.
  const spoken: string[] = [];
  const pending = new PendingChoice(() => {}, (line) => spoken.push(line));

  const answer = pending.ask(YES_NO, 'Write main.go');
  pending.supply('Do it');
  await answer;

  // Nothing pending means nothing left to fire; verified by the process exiting rather
  // than hanging on a stray timer, which node:test will fail on.
  assert.equal(pending.isWaiting, false);
  assert.deepEqual(spoken, []);
});

test('a pending question can be answered from outside, as a mode change does', () => {
  // Switching to Unattended mid-run has to release the question already on the table.
  // Found live: the mode changed with a step waiting, and the button still had to be
  // pressed — which looks exactly like the switch not working.
  const pending = new PendingChoice(() => {});
  const answered = pending.ask(YES_NO, 'Edit plan.md');

  assert.equal(pending.isWaiting, true);
  pending.supply('Do it');

  return answered.then((answer) => {
    assert.equal(answer, 'Do it');
    assert.equal(pending.isWaiting, false);
  });
});
