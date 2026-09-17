import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeSlot } from './slot';

function handle() {
  const it = { stopped: false, release: () => undefined as void, stop: () => new Promise<void>((resolve) => (it.release = resolve)).then(() => void (it.stopped = true)) };
  return it;
}

test("stopping waits for the Bridge's own stop, deregistration included", async () => {
  // Attended session, 17 Sep 2026: deactivate did not wait, so NERVIS never heard the window had gone.
  const bridge = handle();
  const slot = new BridgeSlot(async () => bridge, () => undefined);
  slot.launch();

  let settled = false;
  const stopping = slot.stop().then(() => (settled = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'still waiting on the deregistration');

  bridge.release();
  await stopping;
  assert.equal(bridge.stopped, true);
});

test('a start that came to nothing — an untrusted folder — can be tried again, and a running one is not started twice', async () => {
  const bridge = handle();
  const answers = [undefined, bridge];
  let starts = 0;
  const slot = new BridgeSlot(async () => {
    starts++;
    return answers.shift();
  }, () => undefined);

  slot.launch();
  await new Promise((resolve) => setImmediate(resolve));
  slot.launch();
  await new Promise((resolve) => setImmediate(resolve));
  slot.launch();

  assert.equal(starts, 2);
});

test('a failed start is logged, not thrown, and nothing starts after the slot is stopped', async () => {
  const lines: string[] = [];
  let starts = 0;
  const slot = new BridgeSlot(async () => {
    starts++;
    throw new Error('port in use');
  }, (line) => lines.push(line));

  slot.launch();
  await slot.stop();
  slot.launch();

  assert.equal(starts, 1);
  assert.deepEqual(lines, ['bridge: could not start (port in use)']);
});

test('stopping a slot that never started resolves at once', async () => {
  await new BridgeSlot(async () => undefined, () => undefined).stop();
});
