import test from 'node:test';
import assert from 'node:assert/strict';
import { explainHeldBack, planCommit } from '../dirtyAtStart';

test('a file the user was already editing is never committed by the run', () => {
  // The live failure this comes from: uncommitted edits sat in sum.js, the user asked
  // for the failing test to be fixed, and the agent edited and committed that same
  // file. The commit was correctly scoped to its own paths — the paths just overlapped.
  const plan = planCommit(['sum.js', 'sum.test.js'], ['sum.js']);

  assert.deepEqual(plan.commit, ['sum.test.js']);
  assert.deepEqual(plan.heldBack, ['sum.js']);
});

test('an untouched dirty file is irrelevant to the plan', () => {
  // The user having work in flight elsewhere is not a reason to hold back anything the
  // run actually did.
  const plan = planCommit(['app.js'], ['notes.md', 'README.md']);

  assert.deepEqual(plan.commit, ['app.js']);
  assert.deepEqual(plan.heldBack, []);
});

test('a clean tree at the start commits everything the run touched', () => {
  const plan = planCommit(['a.ts', 'b.ts'], []);

  assert.deepEqual(plan.commit, ['a.ts', 'b.ts']);
  assert.deepEqual(plan.heldBack, []);
});

test('nothing is said when nothing was held back', () => {
  // An empty sentence is worse than no sentence — the closing line is already short.
  assert.equal(explainHeldBack([]), undefined);
});

test('what was held back is named, not counted', () => {
  // "One file was left out" invites the question whose answer is the only useful part.
  const said = explainHeldBack(['sum.js'])!;

  assert.match(said, /sum\.js/);
  assert.match(said, /unsaved/);
});
