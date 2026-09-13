import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RunFence } from '../engine/CodingRun';
import { mayCommitNow, mayWriteNow } from './lockFence';

/**
 * The fence where Clarvis's own engine writes. `AgentRunner` calls these before every writing tool call
 * and before its commit; a run that lost its project writes nothing at all.
 */

function fence(holds: boolean): RunFence & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    stillHolds: async (moment) => {
      asked.push(moment);
      return holds;
    },
    commandStarted: () => undefined,
    commandEnded: () => undefined,
  };
}

test('a writing tool call goes ahead only while the lock is held, and is checked as a tool moment', async () => {
  const holding = fence(true);
  const lost = fence(false);

  assert.equal(await mayWriteNow(holding, true), true);
  assert.equal(await mayWriteNow(lost, true), false);
  assert.deepEqual([holding.asked, lost.asked], [['tool'], ['tool']]);
});

test('reading is never fenced, and a run without a lock has nothing to lose', async () => {
  const lost = fence(false);

  assert.equal(await mayWriteNow(lost, false), true);
  assert.deepEqual(lost.asked, [], 'a read does not even ask');
  assert.equal(await mayWriteNow(undefined, true), true);
  assert.equal(await mayCommitNow(undefined), true);
});

test('a commit is checked as a commit moment, which heartbeats first, and a lost lock refuses it', async () => {
  const lost = fence(false);

  assert.equal(await mayCommitNow(lost), false);
  assert.deepEqual(lost.asked, ['commit']);
});
