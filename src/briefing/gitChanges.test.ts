import test from 'node:test';
import assert from 'node:assert/strict';
import { splitChanges, UNTRACKED } from './gitChanges';

/**
 * The Git extension's shape is not in `@types/vscode`, and this host proved it varies:
 * an untracked file appeared in `workingTreeChanges` *and* in `untrackedChanges`. Both
 * arrangements are covered here, because the cost of getting it wrong is Clarvis telling
 * someone they have uncommitted work when they do not.
 */

test('untracked files are never counted as uncommitted changes', () => {
  // The live failure: a clean tree with one stray note, announced as "one file
  // uncommitted" about a file the user had never edited.
  const state = {
    workingTreeChanges: [{ status: UNTRACKED }],
    untrackedChanges: [{ status: UNTRACKED }],
  };

  assert.deepEqual(splitChanges(state), { tracked: 0, untracked: 1 });
});

test('older hosts, which fold untracked into the working tree', () => {
  const state = { workingTreeChanges: [{ status: UNTRACKED }, { status: 5 }] };

  assert.deepEqual(splitChanges(state), { tracked: 1, untracked: 1 });
});

test('real edits still count', () => {
  const state = { workingTreeChanges: [{ status: 5 }, { status: 6 }] };

  assert.deepEqual(splitChanges(state), { tracked: 2, untracked: 0 });
});

test('an empty state is clean, not unknown', () => {
  assert.deepEqual(splitChanges({}), { tracked: 0, untracked: 0 });
});
