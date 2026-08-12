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

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { canonicalRelative } from '../tools/workspacePaths';

test('a case-different spelling resolves to the name git uses', async () => {
  // Observed live: the model asked for "readme.md", macOS edited README.md happily,
  // and `git add readme.md` then failed — leaving a finished run uncommitted with no
  // obvious cause.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clarvis-case-')));
  await fs.writeFile(path.join(root, 'README.md'), '# Title\n');

  const canonical = await canonicalRelative(root, path.join(root, 'readme.md'));

  // On a case-insensitive filesystem this must come back as README.md; on a
  // case-sensitive one the lowercase file does not exist and the input stands.
  assert.ok(canonical === 'README.md' || canonical === 'readme.md', canonical);
});

test('a file that does not exist yet keeps the requested spelling', async () => {
  // Nothing on disk contradicts it, and refusing would break every file creation.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clarvis-case-')));

  assert.equal(await canonicalRelative(root, path.join(root, 'src', 'New.ts')), path.join('src', 'New.ts'));
});

test('a machine with no git is told how to get it, and offered no button', () => {
  // Without the binary the extension reports no repositories, which is indistinguishable
  // from an ordinary folder — so Clarvis offered to run `git init`, a button that could
  // only fail. The M8 checklist names this exact case.
  const mac = adviseOnGit('no-binary', 'darwin');
  const win = adviseOnGit('no-binary', 'win32');
  const linux = adviseOnGit('no-binary', 'linux');

  assert.equal(mac.action, undefined);
  assert.match(mac.message, /xcode-select --install/);
  assert.match(win.message, /git-scm\.com/);
  assert.match(linux.message, /apt install git|dnf install git/);

  // Whatever the platform, it says what still works — the run is not simply refused.
  for (const advice of [mac, win, linux]) {
    assert.match(advice.message, /snapshot/);
  }
});

test('an ordinary folder still gets the git init offer', () => {
  const advice = adviseOnGit('no-repository');

  assert.equal(advice.action, 'Run git init');
});

test('an accepted offer has a button, and a binary problem never gets one', () => {
  // Nothing turned adviseOnGit()'s `action` label into an actual button before now —
  // the offer never fired at all, on a folder with no .git and nothing else wrong.
  assert.equal(adviseOnGit('no-repository').action, 'Run git init');
  assert.equal(adviseOnGit('no-extension').action, 'Show me the extension');
  assert.equal(adviseOnGit('no-binary').action, undefined);
});
