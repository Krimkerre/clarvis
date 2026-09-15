import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { continuationDecision } from '../../agent/branchNames';
import { GitFacts, parseNumstat, parsePorcelain, parsePorcelainEntries } from './gitFacts';

/**
 * Git facts a switch relies on, read from real repositories in a temporary folder — and branch continuation
 * decided on real history (design §5.1, review B2): after Codex commits on `clarvis/x`, the other engine carries
 * on there, on the saved commit or a descendant of it, and refuses a branch moved away from it.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
}

async function withRepo(run: (root: string, facts: GitFacts) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-git-facts-')));
  try {
    git(root, 'init', '--quiet', '--initial-branch=main');
    for (const [key, value] of [
      ['user.name', 'Clarvis test'],
      ['user.email', 'clarvis-test@example.invalid'],
      ['commit.gpgsign', 'false'],
    ]) {
      git(root, 'config', key, value);
    }
    fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello")\n');
    git(root, 'add', 'hello.py');
    git(root, 'commit', '--quiet', '-m', 'first');
    await run(root, new GitFacts(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function commitFile(root: string, file: string, text: string, message: string): string {
  fs.writeFileSync(path.join(root, file), text);
  git(root, 'add', file);
  git(root, 'commit', '--quiet', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

test('head, tips, branches and ancestry, read from a real repository', () =>
  withRepo(async (root, facts) => {
    const main = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '--quiet', '-b', 'clarvis/add-utc');
    const codex = commitFile(root, 'hello.py', 'print("hello, UTC")\n', "Codex's work");

    assert.deepEqual(await facts.head(), { branch: 'clarvis/add-utc', commit: codex });
    assert.deepEqual([await facts.tip('main'), await facts.tip('clarvis/add-utc'), await facts.tip('clarvis/missing')], [main, codex, undefined]);
    assert.deepEqual((await facts.branches()).sort(), ['clarvis/add-utc', 'main']);
    assert.deepEqual([await facts.isAncestor(main, codex), await facts.isAncestor(codex, main), await facts.isAncestor('--all', codex)], [true, false, false]);
  }));

test('lines changed per file between commits, and every dirty path — staged, modified, untracked and renamed', () =>
  withRepo(async (root, facts) => {
    const first = git(root, 'rev-parse', 'HEAD');
    const second = commitFile(root, 'hello.py', 'print("hello")\nprint("again")\n', 'second');
    assert.deepEqual(await facts.diffStat(first, second), [{ path: 'hello.py', added: 1, removed: 0 }]);

    fs.writeFileSync(path.join(root, 'hello.py'), 'changed\n');
    fs.writeFileSync(path.join(root, 'notes.md'), 'untracked\n');
    commitFile(root, 'old.txt', 'x\n', 'third');
    git(root, 'mv', 'old.txt', 'new.txt');

    assert.deepEqual((await facts.dirty()).sort(), ['hello.py', 'new.txt', 'notes.md']);
  }));

test('a commit is made only on the branch it was told, and says why not otherwise', () =>
  withRepo(async (root, facts) => {
    git(root, 'branch', 'clarvis/add-utc');
    fs.writeFileSync(path.join(root, 'left-over.py'), 'x = 1\n');

    const refused = await facts.commitOnBranch('clarvis/add-utc', ['left-over.py'], 'leftovers');
    assert.deepEqual(refused, { ok: false, detail: 'HEAD is on main, not clarvis/add-utc' });
    assert.equal(git(root, 'status', '--porcelain'), '?? left-over.py', 'nothing was staged or committed');

    git(root, 'checkout', '--quiet', 'clarvis/add-utc');
    const committed = await facts.commitOnBranch('clarvis/add-utc', ['left-over.py'], 'leftovers');
    assert.deepEqual(committed, { ok: true, commit: git(root, 'rev-parse', 'HEAD') });
    assert.equal(git(root, 'log', '-1', '--format=%s'), 'leftovers');
  }));

test("after Codex commits on clarvis/x, the other engine continues on clarvis/x — at the saved commit or after it — and a branch moved away or deleted is refused", () =>
  withRepo(async (root, facts) => {
    const main = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '--quiet', '-b', 'clarvis/x');
    const saved = commitFile(root, 'hello.py', 'print("utc")\n', "Codex's work on the task (stopped for a switch)");
    const decide = async () => {
      const tip = await facts.tip('clarvis/x');
      return continuationDecision('clarvis/x', await facts.branches(), tip, saved, tip !== undefined && (await facts.isAncestor(saved, tip)));
    };

    assert.deepEqual(await decide(), { kind: 'continue', branch: 'clarvis/x' });
    assert.equal(await facts.isAncestor(main, saved), true, 'the base, main, is still what the task branched from');

    commitFile(root, 'README.md', 'by hand\n', 'the owner added a commit');
    assert.deepEqual(await decide(), { kind: 'continue', branch: 'clarvis/x' }, 'a descendant of the saved commit carries on');

    git(root, 'reset', '--quiet', '--hard', main);
    assert.equal((await decide()).kind === 'refuse' && (await decide() as { reason: string }).reason, 'moved_away');

    git(root, 'checkout', '--quiet', 'main');
    git(root, 'branch', '-D', 'clarvis/x');
    assert.equal((await decide()).kind === 'refuse' && (await decide() as { reason: string }).reason, 'missing');
  }));

test('the parsers: numstat with a binary file, porcelain with a rename and a copy', () => {
  assert.deepEqual(parseNumstat('12\t3\thello.py\n-\t-\tlogo.png\n'), [
    { path: 'hello.py', added: 12, removed: 3 },
    { path: 'logo.png', added: 0, removed: 0 },
  ]);
  assert.deepEqual(parsePorcelain('R  new.txt\0old.txt\0 M hello.py\0C  copy.txt\0orig.txt\0?? notes.md\0'), ['new.txt', 'hello.py', 'copy.txt', 'notes.md']);
  assert.deepEqual(parsePorcelainEntries('?? notes.md\0 M hello.py\0R  new.txt\0old.txt\0'), [
    { xy: '??', path: 'notes.md' },
    { xy: ' M', path: 'hello.py' },
    { xy: 'R ', path: 'new.txt' },
  ]);
});

// ── A branch switch with files in flight (plan.md M15, "Build on earlier work"; the owner's rule of 15 Sep 2026) ──────

test('the working tree as a switch sees it: tracked changes, untracked files one by one and as git shows them, and ignored files nowhere', () =>
  withRepo(async (root, facts) => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'build/\n');
    commitFile(root, '.gitignore', 'build/\n', 'ignore build');
    commitFile(root, 'staged.txt', 'first\n', 'staged base');
    fs.writeFileSync(path.join(root, 'hello.py'), 'changed\n');
    fs.writeFileSync(path.join(root, 'staged.txt'), 'staged\n');
    git(root, 'add', 'staged.txt');
    fs.writeFileSync(path.join(root, 'README.md'), 'untracked\n');
    fs.mkdirSync(path.join(root, '__pycache__'));
    fs.writeFileSync(path.join(root, '__pycache__', 'hello.cpython-312.pyc'), 'bytes');
    fs.writeFileSync(path.join(root, '__pycache__', 'other.pyc'), 'bytes');
    fs.mkdirSync(path.join(root, 'build'));
    fs.writeFileSync(path.join(root, 'build', 'out.txt'), 'ignored\n');

    const tree = await facts.workingTree();

    assert.deepEqual(tree && { changed: [...tree.changed].sort(), untracked: [...tree.untracked].sort(), shown: [...tree.shown].sort() }, {
      changed: ['hello.py', 'staged.txt'],
      untracked: ['README.md', '__pycache__/hello.cpython-312.pyc', '__pycache__/other.pyc'],
      shown: ['README.md', '__pycache__/'],
    });
    assert.equal(await new GitFacts(path.join(root, 'no-such-folder')).workingTree(), undefined, 'not knowing is not "nothing changed"');
  }));

test("a branch's files, and the subjects of the commits one branch has that another hasn't; a missing branch has none to list", () =>
  withRepo(async (root, facts) => {
    git(root, 'checkout', '--quiet', '-b', 'clarvis/greeter');
    fs.mkdirSync(path.join(root, 'src'));
    commitFile(root, 'src/greet.py', 'print("hi")\n', 'Build the greeter');
    commitFile(root, 'README.md', 'docs\n', 'Document it');

    assert.deepEqual((await facts.filesOn('clarvis/greeter'))?.sort(), ['README.md', 'hello.py', 'src/greet.py']);
    assert.deepEqual(await facts.filesOn('main'), ['hello.py']);
    assert.equal(await facts.filesOn('clarvis/missing'), undefined);
    assert.deepEqual(await facts.commitSubjects('main', 'clarvis/greeter'), ['Document it', 'Build the greeter']);
    assert.deepEqual(await facts.commitSubjects('main', 'clarvis/greeter', 1), ['Document it']);
    assert.deepEqual(await facts.commitSubjects('main', 'clarvis/missing'), []);
  }));
