import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventChannel } from './eventChannel';

/** The hand-off between the Codex runner's own clock and the chat's: nothing lost, nothing late. */

async function drain<T>(channel: EventChannel<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of channel) items.push(item);
  return items;
}

test('items pushed before and while reading arrive in order, and close ends the read once they are out', async () => {
  const channel = new EventChannel<number>();
  channel.push(1);
  const reading = drain(channel);
  channel.push(2);
  await new Promise((resolve) => setTimeout(resolve, 5));
  channel.push(3);
  channel.close();

  assert.deepEqual(await reading, [1, 2, 3]);
});

test('what was pushed before the close is still read; what is pushed after it is not', async () => {
  const channel = new EventChannel<string>();
  channel.push('closing line');
  channel.close();
  channel.push('a late event from work winding down');

  assert.deepEqual(await drain(channel), ['closing line']);
});

test('a reader that stops early closes the channel behind it', async () => {
  const channel = new EventChannel<number>();
  channel.push(1);
  channel.push(2);
  for await (const item of channel) {
    assert.equal(item, 1);
    break;
  }
  assert.equal(channel.isClosed, true);
});

test('a channel is read once', () => {
  const channel = new EventChannel<number>();
  channel[Symbol.asyncIterator]();
  assert.throws(() => channel[Symbol.asyncIterator](), /read once/);
});
