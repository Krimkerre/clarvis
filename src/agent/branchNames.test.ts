import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationDecision, isRealBase, startingBase } from './branchNames';

// Where a new task's branch starts, shared by `AgentBranch.begin` and the build-on-or-start-fresh question before a Codex
// task (plan.md M15), so the question's **Start fresh from …** names the branch the task really starts from.
test('a fresh task starts from HEAD when it is a real base, else the remembered base, else main, master or develop: never a literal main', () => {
  assert.equal(startingBase('feature', false, 'main', ['main', 'feature']), 'feature');
  assert.equal(startingBase('clarvis/greeter', false, 'master', ['master', 'clarvis/greeter']), 'master');
  assert.equal(startingBase('clarvis/greeter', false, undefined, ['master', 'clarvis/greeter']), 'master');
  assert.equal(startingBase('clarvis/greeter', false, 'release-gone', ['develop', 'clarvis/greeter']), 'develop');
  assert.equal(startingBase('master', true, undefined, []), undefined, 'an unborn master is nowhere to start from');
  assert.equal(startingBase(undefined, false, undefined, ['clarvis/greeter']), undefined);
});

// F10's second edge: a brand-new repository (git init, zero commits) reports HEAD as
// "master" even though nothing has ever been committed there — an unborn ref, not a
// real place to fold work back into.

test('an ordinary branch with real commits is a real base', () => {
  assert.equal(isRealBase('main', false), true);
});

test('an unborn HEAD is never a real base, whatever it is named', () => {
  assert.equal(isRealBase('master', true), false);
});

test('an agent branch is never a real base, born or not', () => {
  assert.equal(isRealBase('clarvis/some-task', false), false);
});

// M15 C3 (review B2): a task switched between engines, or taken over, carries on on its own branch — at the
// commit the other engine saved, or a descendant of it — and never starts a new branch beside that work.

const SAVED = '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';
const LATER = '1111111111111111111111111111111111111111';
const BRANCHES = ['main', 'clarvis/add-utc'];

test('the saved branch at the saved commit, or at a commit after it, is continued', () => {
  assert.deepEqual(continuationDecision('clarvis/add-utc', BRANCHES, SAVED, SAVED, true), { kind: 'continue', branch: 'clarvis/add-utc' });
  assert.deepEqual(continuationDecision('clarvis/add-utc', BRANCHES, LATER, SAVED, true), { kind: 'continue', branch: 'clarvis/add-utc' });
});

test('a branch moved away from the saved work, a missing branch, or nothing saved is refused, saying why', () => {
  const cases: [Parameters<typeof continuationDecision>, string, RegExp][] = [
    [['clarvis/add-utc', BRANCHES, LATER, SAVED, false], 'moved_away', /no longer contains the saved work \(commit 9a8b7c6\)/],
    [['clarvis/add-utc', ['main'], undefined, SAVED, false], 'missing', /isn't in this repository any more/],
    [['clarvis/add-utc', BRANCHES, undefined, SAVED, false], 'missing', /isn't in this repository any more/],
    [[undefined, BRANCHES, SAVED, SAVED, true], 'nothing_saved', /no saved branch/],
    [['clarvis/add-utc', BRANCHES, SAVED, undefined, true], 'nothing_saved', /no saved branch/],
  ];
  for (const [args, reason, advice] of cases) {
    const decision = continuationDecision(...args);
    assert.equal(decision.kind === 'refuse' && decision.reason, reason, JSON.stringify(args));
    assert.match(decision.kind === 'refuse' ? decision.advice : '', advice);
  }
});
