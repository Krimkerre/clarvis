import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { FIRST_COMMIT_MESSAGE, gitSaid, isIdentityProblem, setUpGit } from './gitSetup';

/**
 * Setting git up, with real git, in temporary folders only — never this repository (plan.md M15, "Codex offers to set
 * git up"). The guards, in the order someone would notice them missing: files swept into a "first commit" they never
 * chose; a folder left with an empty `.git` after a failed commit; a machine without git told to try a button that
 * can only fail; and a repository that already had history given a second "first" commit.
 *
 * Each test runs git with none of this machine's own git settings: a config file of its own, with or without a name
 * and email, so a failed commit is a real one and a passing one doesn't depend on who runs the suite.
 */

interface Folders {
  /** The project git is set up in. */
  root: string;
  /** Where the test's git config lives, outside the project. */
  home: string;
}

function folders(t: TestContext): Folders {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-git-setup-')));
  const root = path.join(base, 'project');
  const home = path.join(base, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);
  t.after(() => {
    // A test that made the project read-only hands it back writable first, so it can be removed.
    fs.chmodSync(root, 0o755);
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { root, home };
}

/** Git's environment: no GIT_* variables from the caller, and a config with a name and email, or one that refuses to guess them. */
function gitEnv(home: string, identity: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && key !== 'EMAIL') env[key] = value;
  }
  const config = path.join(home, identity ? 'with-identity' : 'without-identity');
  const user = identity ? '[user]\n\tname = Clarvis test\n\temail = clarvis-test@example.invalid\n' : '[user]\n\tuseConfigOnly = true\n';
  fs.writeFileSync(config, `${user}[commit]\n\tgpgsign = false\n`);
  return { ...env, HOME: home, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1' };
}

function git(root: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8' }).trim();
}

const quiet = () => undefined;

test('a folder without git gets git init and one empty first commit, on the branch git chose, and its files stay uncommitted', async (t) => {
  const { root, home } = folders(t);
  const env = gitEnv(home, true);
  fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello")\n');

  const result = await setUpGit(root, { log: quiet, env });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ok);
  assert.equal(result.madeFirstCommit, true);
  // Whatever init.defaultBranch says, read back rather than assumed.
  assert.equal(result.branch, git(root, env, 'symbolic-ref', '--short', 'HEAD'));
  assert.equal(git(root, env, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(root, env, 'log', '-1', '--format=%s'), FIRST_COMMIT_MESSAGE);
  assert.equal(git(root, env, 'ls-tree', '-r', 'HEAD'), '', 'the first commit is empty');
  assert.equal(git(root, env, 'status', '--porcelain'), '?? hello.py', "the person's file is theirs, not committed");
});

test('a repository with no commit yet gets its first commit, and a file already staged stays staged rather than committed', async (t) => {
  const { root, home } = folders(t);
  const env = gitEnv(home, true);
  git(root, env, 'init', '--quiet');
  fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello")\n');
  git(root, env, 'add', 'hello.py');

  const result = await setUpGit(root, { log: quiet, env });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(git(root, env, 'ls-tree', '-r', 'HEAD'), '', 'nothing staged was swept into the first commit');
  assert.equal(git(root, env, 'diff', '--cached', '--name-only'), 'hello.py');
});

test('a repository that already has a commit is left as it is: no second first commit', async (t) => {
  const { root, home } = folders(t);
  const env = gitEnv(home, true);
  git(root, env, 'init', '--quiet');
  git(root, env, 'commit', '--quiet', '--allow-empty', '-m', 'their own start');

  const result = await setUpGit(root, { log: quiet, env });

  assert.deepEqual(result.ok && [result.madeFirstCommit], [false]);
  assert.equal(git(root, env, 'rev-list', '--count', 'HEAD'), '1');
  assert.equal(git(root, env, 'log', '-1', '--format=%s'), 'their own start');
});

test('no git on the machine: says how to get it, and nothing is made in the folder', async (t) => {
  const { root, home } = folders(t);

  const result = await setUpGit(root, { log: quiet, env: gitEnv(home, true), git: path.join(home, 'no-such-git'), platform: 'darwin' });

  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.reason, 'no-binary');
  assert.match(result.line, /^Git isn't installed on this machine/);
  assert.match(result.line, /xcode-select --install/);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('a first commit git refuses for want of a name and email is taken back out, and says how to fix it', async (t) => {
  const { root, home } = folders(t);
  fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello")\n');

  const result = await setUpGit(root, { log: quiet, env: gitEnv(home, false) });

  assert.ok(!result.ok, JSON.stringify(result));
  assert.equal(result.reason, 'commit-failed');
  assert.match(result.line, /^Git doesn't know your name and email yet, so it couldn't make the first commit\./);
  assert.match(result.line, /I took the half-made git setup back out, so the folder is as it was\./);
  assert.match(result.line, /git config --global user\.name "Your Name"/);
  assert.equal(fs.existsSync(path.join(root, '.git')), false, 'no half-set-up folder is left behind');
  assert.deepEqual(fs.readdirSync(root), ['hello.py'], "the person's files are untouched");
});

test('a first commit refused in a folder that was already a repository leaves that .git alone', async (t) => {
  const { root, home } = folders(t);
  const env = gitEnv(home, false);
  git(root, env, 'init', '--quiet');

  const result = await setUpGit(root, { log: quiet, env });

  assert.ok(!result.ok);
  assert.equal(result.reason, 'commit-failed');
  assert.match(result.line, /The folder was already a git repository, so I left it as it was\./);
  assert.equal(fs.existsSync(path.join(root, '.git')), true);
});

test('a git init that fails leaves nothing behind and quotes what git said', async (t) => {
  if (process.getuid?.() === 0) return t.skip('a read-only folder is writable to root');
  const { root, home } = folders(t);
  fs.chmodSync(root, 0o555);

  const result = await setUpGit(root, { log: quiet, env: gitEnv(home, true) });

  assert.ok(!result.ok, JSON.stringify(result));
  assert.equal(result.reason, 'init-failed');
  assert.match(result.line, /^Git couldn't be set up in this folder \(git said: ".+"\)\. Nothing in the folder was changed\.$/);
  assert.equal(fs.existsSync(path.join(root, '.git')), false);
});

test('a git init that fails after writing part of a .git has that .git taken back out', async (t) => {
  // A stand-in git that does what a git init interrupted part-way would: makes the folder, then fails.
  const { root, home } = folders(t);
  const halfway = path.join(home, 'git-that-fails-halfway');
  fs.writeFileSync(halfway, '#!/bin/sh\nmkdir .git\necho "fatal: simulated failure part-way through" >&2\nexit 1\n', { mode: 0o755 });

  const result = await setUpGit(root, { log: quiet, env: gitEnv(home, true), git: halfway });

  assert.ok(!result.ok, JSON.stringify(result));
  assert.equal(result.reason, 'init-failed');
  assert.match(result.line, /git said: "simulated failure part-way through"\)\. Nothing in the folder was changed\.$/);
  assert.equal(fs.existsSync(path.join(root, '.git')), false, 'no half-set-up folder is left behind');
});

test('a folder that has gone away is not mistaken for a machine without git', async (t) => {
  const { root, home } = folders(t);

  const result = await setUpGit(path.join(root, 'deleted'), { log: quiet, env: gitEnv(home, true) });

  assert.deepEqual(!result.ok && result.reason, 'no-folder');
});

test("git's words: its fatal line is quoted without the prefix, and a missing name or email is recognised", () => {
  assert.equal(gitSaid('hint: something\nfatal: cannot mkdir .git: Permission denied\n'), 'cannot mkdir .git: Permission denied');
  assert.equal(gitSaid('just one line\n'), 'just one line');
  assert.equal(gitSaid(''), 'nothing');
  assert.equal(isIdentityProblem('Author identity unknown\n\n*** Please tell me who you are.'), true);
  assert.equal(isIdentityProblem('fatal: no email was given and auto-detection is disabled'), true);
  assert.equal(isIdentityProblem('error: gpg failed to sign the data'), false);
});
