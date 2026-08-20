import test from 'node:test';
import assert from 'node:assert/strict';
import { withDeadline } from './deadline';

test('work that finishes in time returns its own result', async () => {
  const result = await withDeadline(1000, async () => 'done', () => 'aborted');
  assert.equal(result, 'done');
});

test('the signal is not aborted when the work finishes in time', async () => {
  let seen: boolean | undefined;
  await withDeadline(1000, async (signal) => {
    seen = signal.aborted;
  }, () => undefined);
  assert.equal(seen, false);
});

// F23 -- losing the race used to leave the request running. The deadline must
// actually fire the signal, not merely stop the caller waiting.
test('the signal fires when the deadline passes', async () => {
  let aborted = false;

  const result = await withDeadline(
    10,
    (signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      }),
    () => 'fell back'
  );

  assert.equal(aborted, true, 'the work must be told to stop, not merely abandoned');
  assert.equal(result, 'fell back');
});

test('a real error still propagates rather than being read as a timeout', async () => {
  await assert.rejects(
    withDeadline(1000, async () => {
      throw new Error('provider exploded');
    }, () => 'fell back'),
    /provider exploded/
  );
});
