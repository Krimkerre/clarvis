import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, migrateInto, parseState, withValue } from './machineState';

/**
 * The rules for the values kept on this machine rather than in the browser (20 September 2026).
 *
 * The two that moved decide what happens to somebody's branches — where a run is merged back to,
 * and the file list "Start fresh" commits — so these pin the one failure that costs a branch: a
 * window writing back a value it loaded before another window changed it.
 */

test('a write replaces one key and keeps every other as the file had it', () => {
  const onDisk = withValue(withValue(emptyState('/p'), 'clarvis.agent.baseBranch', 'main'),
                           'clarvis.agent.lastRun', { files: ['a.ts'] });

  // The window that has been running since before `baseBranch` changed, writing its run record.
  const after = withValue(onDisk, 'clarvis.agent.lastRun', { files: ['b.ts'] });

  assert.equal(after.values['clarvis.agent.baseBranch'], 'main',
    "a whole-file write would have carried this window's stale base branch back over the other's");
  assert.deepEqual(after.values['clarvis.agent.lastRun'], { files: ['b.ts'] });
});

test('setting nothing deletes, so "never set" and "cleared" are one state', () => {
  const after = withValue(withValue(emptyState('/p'), 'clarvis.agent.baseBranch', 'main'),
                          'clarvis.agent.baseBranch', undefined);

  assert.equal('clarvis.agent.baseBranch' in after.values, false);
  assert.equal(after.values['clarvis.agent.baseBranch'], undefined);
});

test('what is only in the old store is copied across, key by key', () => {
  const held: Record<string, unknown> = { 'clarvis.agent.baseBranch': 'main', 'clarvis.chat.current': 'not ours' };
  const onDisk = withValue(emptyState('/p'), 'clarvis.agent.lastRun', { files: ['already here'] });

  const { state, moved } = migrateInto(onDisk, ['clarvis.agent.baseBranch', 'clarvis.agent.lastRun'],
                                       (key) => held[key]);

  assert.deepEqual(moved, ['clarvis.agent.baseBranch'], 'only what the file was missing');
  assert.equal(state.values['clarvis.agent.baseBranch'], 'main');
  assert.deepEqual(state.values['clarvis.agent.lastRun'], { files: ['already here'] },
    'a file that already holds one key is not overwritten by the other key’s absence');
  assert.equal('clarvis.chat.current' in state.values, false, 'nothing it does not own moves');
});

test('nothing to move leaves the file alone, so an ordinary load writes nothing', () => {
  const { state, moved } = migrateInto(emptyState('/p'), ['clarvis.agent.baseBranch'], () => undefined);

  assert.deepEqual(moved, []);
  assert.deepEqual(state, emptyState('/p'));
});

test('a file half-written, hand-edited or from an older build reads as no value at all', () => {
  assert.deepEqual(parseState('nonsense', '/p'), emptyState('/p'));
  assert.deepEqual(parseState({ folder: '/p', values: ['not an object'] }, '/p'), emptyState('/p'));
  assert.deepEqual(parseState({ values: { a: 1 } }, '/p'), { folder: '/p', values: { a: 1 } });
  assert.equal(parseState({ folder: '/elsewhere', values: {} }, '/p').folder, '/elsewhere',
    'the workspace it was written for travels with it, so a moved folder is recognisable');
});
