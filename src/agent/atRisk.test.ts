import test from 'node:test';
import assert from 'node:assert/strict';
import { atRiskPaths } from './atRisk';

const change = (fsPath: string) => ({ uri: { fsPath } });

test('modified, staged and untracked files are all at risk', () => {
  // Staged is as much the user\'s as unstaged, and a file git has never seen is the
  // one thing git definitely cannot give back.
  const paths = atRiskPaths({
    workingTreeChanges: [change('/p/a.ts')],
    indexChanges: [change('/p/b.ts')],
    untrackedChanges: [change('/p/c.ts')],
  });

  assert.deepEqual(paths.sort(), ['/p/a.ts', '/p/b.ts', '/p/c.ts']);
});

test('a file both staged and modified is snapshotted once', () => {
  // Copying it twice would make the second copy the one restored — the wrong half of
  // the change, silently.
  const paths = atRiskPaths({
    workingTreeChanges: [change('/p/a.ts')],
    indexChanges: [change('/p/a.ts')],
  });

  assert.deepEqual(paths, ['/p/a.ts']);
});

test('a clean tree has nothing at risk', () => {
  // Everything committed is already recoverable from git. Snapshotting it would be
  // copying the workspace to guard against something it is already guarded from.
  assert.deepEqual(atRiskPaths({}), []);
  assert.deepEqual(atRiskPaths({ workingTreeChanges: [] }), []);
});

test('older Git extensions that omit untrackedChanges still work', () => {
  // They fold untracked files into workingTreeChanges instead of reporting them
  // separately, so the absent array must not be an error.
  assert.deepEqual(atRiskPaths({ workingTreeChanges: [change('/p/new.ts')] }), ['/p/new.ts']);
});
