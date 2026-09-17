import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOTHING_TO_UNDO, undoLastRun, type UndoPorts, type UndoRecord, type UndoResult } from './undoCommand';

function ports(record: UndoRecord | undefined, result: UndoResult, answer = true) {
  const seen = { notified: [] as string[], told: [] as string[], undone: 0, asked: [] as string[] };
  const it: UndoPorts = {
    stored: () => record,
    confirm: async (question, detail) => {
      seen.asked.push(`${question} ${detail}`);
      return answer;
    },
    undo: async () => {
      seen.undone++;
      return result;
    },
    phrase: async (_purpose, fallback) => fallback,
    notify: (kind, text) => seen.notified.push(`${kind}: ${text}`),
    tell: (text) => seen.told.push(text),
  };
  return { it, seen };
}

const clean: UndoResult = { restored: 1, deleted: 0, failed: [] };

test('nothing to undo is said in the chat too, and plainly', async () => {
  // Attended session, 17 Sep 2026: the corner notification went unseen in code-server.
  for (const record of [undefined, { task: 'a Codex task', entries: [] }]) {
    const { it, seen } = ports(record, clean);
    await undoLastRun(it);
    assert.deepEqual(seen.told, [NOTHING_TO_UNDO]);
    assert.deepEqual(seen.notified, [`info: ${NOTHING_TO_UNDO}`]);
    assert.equal(seen.undone, 0);
  }
});

test("an undo's result is said in the chat as well as in a notification", async () => {
  const { it, seen } = ports({ task: 'add a comment', entries: [{}], startedOn: 'main' }, clean);
  await undoLastRun(it);
  assert.equal(seen.undone, 1);
  assert.match(seen.asked[0], /1 file\(s\) go back.*put back on `main`/);
  assert.deepEqual(seen.told, ['Undone: restored 1 file(s), removed 0.']);
  assert.deepEqual(seen.notified, ['info: Undone: restored 1 file(s), removed 0.']);
});

test('a partial undo is a warning, and a branch it could not leave is said plainly', async () => {
  const { it, seen } = ports({ task: 't', entries: [{}, {}] }, { restored: 1, deleted: 0, failed: ['b.ts'], stuckOn: 'main' });
  await undoLastRun(it);
  assert.equal(seen.notified.length, 1);
  assert.match(seen.notified[0], /^warning: Undone: restored 1 file\(s\), removed 0, and failed on b\.ts\. You are still on the run's branch/);
  assert.equal(seen.told[0], seen.notified[0].slice('warning: '.length));
});

test('declining the question changes nothing and says nothing', async () => {
  const { it, seen } = ports({ task: 't', entries: [{}] }, clean, false);
  await undoLastRun(it);
  assert.deepEqual([seen.undone, seen.told.length, seen.notified.length], [0, 0, 0]);
});
