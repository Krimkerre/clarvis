import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { findGitDir, gitDirForRelay } from './gitDir';

/** The git folder a lock file lives in and RAVIS is told about, found without running git. */

function withFolder(run: (root: string) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-git-dir-')));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a .git folder is the git folder', () =>
  withFolder((root) => {
    fs.mkdirSync(path.join(root, '.git'));
    assert.equal(findGitDir(root), path.join(root, '.git'));
  }));

test("a worktree's .git file points at its git folder, resolved against the checkout", () =>
  withFolder((root) => {
    const checkout = path.join(root, 'feature');
    const worktreeGit = path.join(root, 'main', '.git', 'worktrees', 'feature');
    fs.mkdirSync(checkout);
    fs.mkdirSync(worktreeGit, { recursive: true });
    fs.writeFileSync(path.join(checkout, '.git'), 'gitdir: ../main/.git/worktrees/feature\n');

    assert.equal(findGitDir(checkout), worktreeGit);
  }));

test('no git folder, or a .git file that points nowhere, is none; RAVIS is then told <root>/.clarvis', () =>
  withFolder((root) => {
    assert.equal(findGitDir(root), undefined);
    fs.writeFileSync(path.join(root, '.git'), 'not a pointer\n');
    assert.equal(findGitDir(root), undefined);
    fs.writeFileSync(path.join(root, '.git'), 'gitdir: ./missing\n');
    assert.equal(findGitDir(root), undefined);

    assert.equal(gitDirForRelay(root, undefined), path.join(root, '.clarvis'));
    assert.equal(gitDirForRelay(root, '/elsewhere/.git'), '/elsewhere/.git');
  }));
