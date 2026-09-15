import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationBase, continuationDecision, freshStartRefusal, isRealBase, startingBase } from './branchNames';

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

// **Start fresh means fresh** (plan.md M15, "Build on Clarvis's own earlier work"): after the owner chose it, a task that
// can't start at the starting branch never falls back to stacking on the `clarvis/*` branch the window is on.
test("after Start fresh, a task that can't start at the starting branch is refused rather than stacked on a clarvis branch; otherwise nothing changes", () => {
  assert.equal(
    freshStartRefusal(true, 'clarvis/greeter', 'master'),
    "I couldn't start fresh from `master`, and starting on `clarvis/greeter` instead would build on that work, which you chose not to. Nothing was done. If something in the folder needs committing or putting aside, doing that lets a fresh start work."
  );
  assert.match(freshStartRefusal(true, 'clarvis/greeter', undefined) ?? '', /^I couldn't start fresh from the starting branch, and starting on `clarvis\/greeter`/);
  assert.equal(freshStartRefusal(false, 'clarvis/greeter', 'master'), undefined, "without Start fresh, today's fallback stays");
  assert.equal(freshStartRefusal(true, 'feature', 'master'), undefined, 'from a real branch there is no earlier run to stack on');
  assert.equal(freshStartRefusal(true, undefined, 'master'), undefined, 'nor from a detached HEAD');
});

// A Build on of Clarvis's own engine names the base its question offered (plan.md M15), so the landing question offers the
// project's own trunk in either editor, whatever each editor remembers.
test('a continued task counts as started from the base a Build on names, when that is a real branch here; otherwise the remembered base, as before', () => {
  assert.equal(continuationBase('production', ['production', 'main', 'clarvis/x'], 'main'), 'production');
  assert.equal(continuationBase('production', ['production', 'clarvis/x'], undefined), 'production', 'a trunk none of main, master or develop');
  assert.equal(continuationBase('clarvis/x', ['main', 'clarvis/x'], undefined), 'main', 'never a clarvis branch');
  assert.equal(continuationBase('gone', ['master'], undefined), 'master', 'a branch that no longer exists');
  assert.equal(continuationBase(undefined, ['develop', 'release'], 'release'), 'release', 'without one named, the remembered base');
});
