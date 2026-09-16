import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TaskNote } from '../bridge/activity';
import { NervisTaskTrack, TRACKED_TASK_KEY, mintTaskId } from './nervisTaskTrack';

/**
 * `clarvis.task.*` for a task NERVIS handed over (the owner's decision of 16 Sep 2026): picked up, building,
 * paused, built — remembered per workspace, since NERVIS's file is gone once planning has begun.
 */

const ID = 'nt_0123456789abcdef';

function tracked(mint = () => 'nt_ffffffffffffffff') {
  const memory = new Map<string, unknown>();
  const told: TaskNote[] = [];
  const store = {
    get: (key: string) => memory.get(key),
    update: async (key: string, value: unknown) => void (value === undefined ? memory.delete(key) : memory.set(key, value)),
  };
  return { track: new NervisTaskTrack(store, (note) => told.push(note), mint), told, memory };
}

const said = (told: TaskNote[]) => told.map((n) => [n.phase, n.stage ?? n.outcome]);

test('a handover is followed from pickup through building and pauses to built', async () => {
  const { track, told, memory } = tracked();
  await track.pickedUp(ID);
  await track.building();
  await track.paused();
  await track.building();
  await track.finished();

  assert.deepEqual(said(told), [
    ['started', 'planning'], ['started', 'building'], ['started', 'paused'], ['started', 'building'], ['completed', 'built'],
  ]);
  assert.ok(told.every((note) => note.taskId === ID), 'every event names the handover NERVIS wrote');
  assert.equal(memory.has(TRACKED_TASK_KEY), false, 'a built task is no longer followed');
});

test('a stage told twice is one stage, and the same handover offered again is the same pickup', async () => {
  const { track, told } = tracked();
  await track.pickedUp(ID);
  await track.pickedUp(ID);
  await track.building();
  await track.building();
  assert.deepEqual(said(told), [['started', 'planning'], ['started', 'building']]);
});

test('the stage outlives the window: a new tracker reads what the last one remembered', async () => {
  const first = tracked();
  await first.track.pickedUp(ID);
  await first.track.building();
  const told: TaskNote[] = [];
  const again = new NervisTaskTrack(
    { get: (key) => first.memory.get(key), update: async (key, value) => void first.memory.set(key, value) },
    (note) => told.push(note)
  );
  assert.deepEqual(again.current(), { id: ID, stage: 'building' });
  await again.paused();
  assert.deepEqual(said(told), [['started', 'paused']]);
});

test('with no handover, plan runs and a finished project say nothing', async () => {
  const { track, told } = tracked();
  await track.building();
  await track.paused();
  await track.finished();
  assert.deepEqual(told, []);
});

test('a handover without an id, or with one not in NERVIS’s shape, gets one here', async () => {
  const { track, told } = tracked();
  await track.pickedUp(undefined);
  assert.equal(told[0].taskId, 'nt_ffffffffffffffff');
  await track.pickedUp('nt_<img>');
  assert.equal(told.length, 1, 'the minted id is the same pickup');
  assert.match(mintTaskId(), /^nt_[0-9a-f]{16}$/);
  assert.notEqual(mintTaskId(), mintTaskId());
});

test('something unreadable in memory is no task', () => {
  const { track, memory } = tracked();
  memory.set(TRACKED_TASK_KEY, { id: 'a sentence, not an id', stage: 'building' });
  assert.equal(track.current(), undefined);
});
