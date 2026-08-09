import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchNameFor, isAgentBranch, adviseOnGit } from '../branchNames';

test('a task becomes a readable, prefixed branch name', () => {
  assert.equal(branchNameFor('Fix the failing test'), 'clarvis/fix-the-failing-test');
});

test('characters git rejects never reach a branch name', () => {
  // Every one of these fails at commit time rather than at creation time, which would
  // put the failure several minutes into a run, after files were already edited.
  const name = branchNameFor('fix: ~weird^ name?! with [brackets] .. and spaces');

  assert.ok(!/[~^:?*[\]\\ ]/.test(name), name);
  assert.ok(!name.includes('..'), name);
  assert.ok(!name.endsWith('.'), name);
  assert.ok(!name.endsWith('-'), name);
  assert.ok(!name.includes('//'), name);
});

test('an empty or symbol-only task still produces a usable name', () => {
  assert.equal(branchNameFor('!!!'), 'clarvis/task');
  assert.equal(branchNameFor(''), 'clarvis/task');
});

test('long tasks are truncated without a trailing dash', () => {
  const name = branchNameFor('a'.repeat(200));

  assert.ok(name.length < 70, name);
  assert.ok(!name.endsWith('-'), name);
});

test('a repeated task gets a new branch rather than resuming an old one', () => {
  // Second attempts are normal — the first is often abandoned half-done. Reusing the
  // name would either fail or silently continue work the user meant to discard.
  const existing = ['clarvis/fix-the-test'];

  assert.equal(branchNameFor('fix the test', existing), 'clarvis/fix-the-test-2');
  assert.equal(
    branchNameFor('fix the test', [...existing, 'clarvis/fix-the-test-2']),
    'clarvis/fix-the-test-3'
  );
});

test("Clarvis's own branches are identifiable", () => {
  assert.equal(isAgentBranch('clarvis/fix-thing'), true);
  assert.equal(isAgentBranch('main'), false);
  assert.equal(isAgentBranch('feature/clarvis-ui'), false);
});

test('git advice names the actual cause, not a generic failure', () => {
  // §4.6: 'git init' and 'install git' are different problems, and a user told the
  // wrong one goes looking in the wrong place.
  const noRepo = adviseOnGit('no-repository');
  const noExtension = adviseOnGit('no-extension');

  assert.match(noRepo.message, /isn't a git repository/);
  assert.equal(noRepo.action, 'Run git init');
  assert.match(noExtension.message, /Git extension/);
  assert.notEqual(noRepo.message, noExtension.message);
});

test('every git problem still offers a way to continue', () => {
  // Falling back to checkpoint-only keeps the agent usable; refusing to run because
  // git is absent would make the whole feature conditional on a tool it does not need.
  for (const problem of ['no-repository', 'no-extension'] as const) {
    assert.match(adviseOnGit(problem).message, /snapshot/);
  }
});
