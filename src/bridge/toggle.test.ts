import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOGGLE_LINES, toggleBridge, type TogglePorts } from './toggle';

function ports(start: boolean, { confirm = true, reload = true, sticks = true } = {}) {
  let value = start;
  const seen = { asked: [] as string[], written: [] as boolean[], told: [] as string[], reloaded: 0 };
  const it: TogglePorts = {
    enabled: () => value,
    write: async (next) => {
      seen.written.push(next);
      if (sticks) value = next;
    },
    confirm: async (question, _detail, action) => {
      seen.asked.push(`${question} [${action}]`);
      return confirm;
    },
    offerReload: async () => reload,
    reload: async () => void seen.reloaded++,
    tell: (text) => seen.told.push(text),
  };
  return { it, seen };
}

test('off → on: asked first, the user setting written, said in the chat, and the window reloaded when chosen', async () => {
  // Attended session, 17 Sep 2026: code-server's settings screen hides machine-scoped settings.
  const { it, seen } = ports(false);
  await toggleBridge(it);
  assert.deepEqual(seen.asked, ['Turn the Bridge on? [Turn On]']);
  assert.deepEqual(seen.written, [true]);
  assert.deepEqual(seen.told, [TOGGLE_LINES.on]);
  assert.equal(seen.reloaded, 1);
});

test('on → off, without reloading now', async () => {
  const { it, seen } = ports(true, { reload: false });
  await toggleBridge(it);
  assert.deepEqual([seen.asked, seen.written, seen.told, seen.reloaded], [['Turn the Bridge off? [Turn Off]'], [false], [TOGGLE_LINES.off], 0]);
});

test('declined: nothing written', async () => {
  const { it, seen } = ports(false, { confirm: false });
  await toggleBridge(it);
  assert.deepEqual([seen.written, seen.told], [[], []]);
});

test('a write that did not take is said, and no reload is offered as if it had', async () => {
  const { it, seen } = ports(false, { sticks: false });
  await toggleBridge(it);
  assert.deepEqual([seen.told, seen.reloaded], [[TOGGLE_LINES.notTaken], 0]);
});
