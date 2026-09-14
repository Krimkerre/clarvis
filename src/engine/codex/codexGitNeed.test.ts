import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adviseOnGit } from '../../agent/branchNames';
import { CODEX_NEEDS_GIT, codexGitNeed, codexNeedsGitLine, offersGitSetup } from './codexGitNeed';

/**
 * What Codex's git refusal says, and when it offers **Set up git here** (plan.md M15, "Codex offers to set git up").
 * The guards: a button offered where it can only fail (no git on the machine, the Git extension off), and Clarvis's
 * own engine's "I can still snapshot files" advice told to someone whose Codex task did not start at all.
 */

const HEAD = '3f9c2e1d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e';

test('a folder that is not a repository, on a machine with git, is offered git setup and told so plainly', () => {
  const need = codexGitNeed({ repository: false, headCommit: undefined, problem: 'no-repository' });

  assert.equal(need, 'no-repository');
  assert.equal(offersGitSetup(need), true);
  assert.equal(codexNeedsGitLine(need, adviseOnGit('no-repository').message), `${CODEX_NEEDS_GIT} This folder isn't a git repository yet.`);
});

test('a repository with no commit yet is offered git setup too: the first commit is what it lacks', () => {
  const need = codexGitNeed({ repository: true, headCommit: undefined, problem: undefined });

  assert.equal(need, 'no-commit');
  assert.equal(offersGitSetup(need), true);
  assert.equal(codexNeedsGitLine(need, undefined), `${CODEX_NEEDS_GIT} This folder's git repository has no commits yet.`);
});

test('no git on the machine is told how to get it, with no button that could only fail', () => {
  const need = codexGitNeed({ repository: false, headCommit: undefined, problem: 'no-binary' });
  const line = codexNeedsGitLine(need, adviseOnGit('no-binary', 'darwin').message, 'darwin');

  assert.equal(need, 'no-binary');
  assert.equal(offersGitSetup(need), false);
  assert.match(line, /Git isn't installed on this machine\. On a Mac, `xcode-select --install` in Terminal is the shortest route\. Once it's installed, ask for the task again\.$/);
  assert.doesNotMatch(line, /snapshot/, "Clarvis's own engine's fallback is not Codex's");
});

test("the Git extension switched off, or a branch that failed in a real repository, keeps its own reason and offers nothing", () => {
  const off = codexGitNeed({ repository: false, headCommit: undefined, problem: 'no-extension' });
  const failedBranch = codexGitNeed({ repository: true, headCommit: HEAD, problem: undefined });
  const advice = adviseOnGit('no-extension').message;

  assert.deepEqual([off, failedBranch], ['other', 'other']);
  assert.equal(offersGitSetup(off), false);
  assert.equal(codexNeedsGitLine(off, advice), `${CODEX_NEEDS_GIT} ${advice}`);
  assert.equal(codexNeedsGitLine(failedBranch, undefined), CODEX_NEEDS_GIT);
});
