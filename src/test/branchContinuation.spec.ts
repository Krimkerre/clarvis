import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentBranch } from '../agent/AgentBranch';
import { CodexGitGlue } from '../engine/codex/codexGit';

/**
 * Branch continuation against the real Git extension (plan.md M15 C3; review B2). After Codex commits on `clarvis/x`,
 * Clarvis's own engine continues on `clarvis/x` — the commit present, the base still `main` — and a branch moved away
 * from the saved commit is refused. The decision is unit-tested (`branchNames.test.ts`, `gitFacts.test.ts`); this checks
 * `AgentBranch.continueOn` drives the Git extension the way those tests assume.
 *
 * The fixture repository is made in a temporary folder and put first among the workspace folders, because
 * `AgentBranch` works in the first folder only; it is removed again afterwards.
 */
suite('branch continuation in the extension host (M15 C3)', () => {
  let root = '';

  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();

  suiteSetup(async function () {
    this.timeout(30_000);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-continue-')));
    git('init', '--quiet', '--initial-branch=main');
    git('config', 'user.name', 'Clarvis test');
    git('config', 'user.email', 'clarvis-test@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello")\n');
    git('add', 'hello.py');
    git('commit', '--quiet', '-m', 'first');
    vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file(root) });
    const gitApi = (await vscode.extensions.getExtension('vscode.git')?.activate())?.getAPI(1);
    await gitApi?.openRepository(vscode.Uri.file(root));
  });

  suiteTeardown(() => {
    const index = vscode.workspace.workspaceFolders?.findIndex((folder) => folder.uri.fsPath === root) ?? -1;
    if (index >= 0) vscode.workspace.updateWorkspaceFolders(index, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("after Codex commits on clarvis/x, Clarvis's own engine continues on clarvis/x with the commit present and the base still main", async function () {
    this.timeout(30_000);
    git('checkout', '--quiet', '-b', 'clarvis/x');
    fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello, UTC")\n');
    git('commit', '--quiet', '-am', "Codex's work on the task (stopped for a switch)");
    const saved = git('rev-parse', 'HEAD');
    git('checkout', '--quiet', 'main');
    const memory = new Map<string, string>([['clarvis.agent.baseBranch', 'main']]);
    const branch = new AgentBranch(() => undefined, { get: (key) => memory.get(key), update: async (key, value) => void memory.set(key, value) });

    const isolation = await branch.continueOn({ branch: 'clarvis/x', headCommit: saved, theirs: [] });

    assert.deepStrictEqual([isolation.isolated, isolation.refused, branch.current, branch.previous], [true, undefined, 'clarvis/x', 'main']);
    assert.strictEqual(git('rev-parse', 'HEAD'), saved, 'the commit Codex saved is where the run carries on');
    assert.strictEqual(memory.get('clarvis.agent.baseBranch'), 'main', 'the base stays main');
  });

  test('a branch moved away from the saved commit is refused, and nothing is checked out', async function () {
    this.timeout(30_000);
    const saved = git('rev-parse', 'clarvis/x');
    git('checkout', '--quiet', 'main');
    git('branch', '--force', 'clarvis/x', 'main');
    const branch = new AgentBranch(() => undefined);

    const isolation = await branch.continueOn({ branch: 'clarvis/x', headCommit: saved, theirs: [] });

    assert.deepStrictEqual([isolation.isolated, isolation.refused], [false, true]);
    assert.match(isolation.advice ?? '', /no longer contains the saved work/);
    assert.strictEqual(git('symbolic-ref', '--short', 'HEAD'), 'main');
  });

  /**
   * **Build on** Codex's earlier work (plan.md M15, "Build on Codex's earlier work"; the owner's decision of 15 Sep 2026).
   * Which tasks are offered, the question and the turn are tested with real git and the fake RAVIS (`leftTasks.test.ts`,
   * `codexLeftWork.test.ts`, `runCore.test.ts`); this checks what only an extension host has: `CodexGitGlue.continueOn`
   * moves the window from the trunk to the branch Codex left, makes no new branch, says the work started from the trunk,
   * and commits Codex's next change there under the new request. In this suite, on its repository, because a run can
   * change the first workspace folder only once: a second spec doing so had its changes refused.
   */
  test('Build on: the window moves from main to the branch Codex left, with no new branch, and Codex’s next change is committed there under the new request', async function () {
    this.timeout(30_000);
    const greeter = 'clarvis/build-the-greeter';
    const shout = 'Also add a --shout option to greet.py that prints the greeting in capitals, with a test for it.';
    git('checkout', '--quiet', '-b', greeter, 'main');
    fs.writeFileSync(path.join(root, 'greet.py'), 'print("hello")\n');
    git('add', 'greet.py');
    git('commit', '--quiet', '-m', 'Codex: build the greeter');
    git('checkout', '--quiet', 'main');
    const tip = git('rev-parse', greeter);
    const branchesBefore = git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-build-on-storage-'));
    await gitCaughtUp(root, () => true);
    const glue = new CodexGitGlue(standInContext(storage), root, () => undefined);

    try {
      const continued = await glue.continueOn(greeter, tip, shout);

      assert.deepStrictEqual(continued, { ok: true, branch: greeter, headCommit: tip });
      assert.strictEqual(git('symbolic-ref', '--short', 'HEAD'), greeter, 'the checkout is on the branch Codex left');
      assert.strictEqual(git('for-each-ref', '--format=%(refname:short)', 'refs/heads'), branchesBefore, 'no new branch');
      assert.deepStrictEqual(glue.branches, { working: greeter, startedFrom: 'main' }, 'the landing question offers the trunk');

      fs.writeFileSync(path.join(root, 'greet.py'), 'import sys\nprint("HELLO" if "--shout" in sys.argv else "hello")\n');
      await gitCaughtUp(root, (state) => state.workingTreeChanges.some((change) => change.uri.fsPath === path.join(root, 'greet.py')));
      const saved = await glue.save({ summary: 'Added --shout.', stopped: false, files: ['greet.py'], branch: greeter });

      assert.ok(saved.ok && saved.committed, JSON.stringify(saved));
      assert.strictEqual(git('rev-parse', `${greeter}~1`), tip, "the new commit sits on Codex's earlier work");
      assert.ok(git('log', '-1', '--format=%B', greeter).includes(`Task: ${shout}`), 'the commit names the new request');
    } finally {
      git('checkout', '--quiet', 'main');
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });
});

/** Only what `CodexGitGlue` reads of the extension's context: the two mementos and a storage folder for undo copies. */
function standInContext(storage: string): vscode.ExtensionContext {
  return { workspaceState: memento(), globalState: memento(), globalStorageUri: vscode.Uri.file(storage) } as unknown as vscode.ExtensionContext;
}

function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
  } as vscode.Memento;
}

type RepositoryState = { HEAD?: { name?: string }; workingTreeChanges: { uri: vscode.Uri }[] };

/**
 * Refreshes the Git extension's view of the repository, waiting up to 10 s until `ready` holds, since the glue reads that
 * view and the commands above changed the repository behind its back.
 */
async function gitCaughtUp(root: string, ready: (state: RepositoryState) => boolean): Promise<void> {
  const api = (await vscode.extensions.getExtension('vscode.git')?.activate())?.getAPI(1);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const repository = api?.repositories.find((candidate: { rootUri: vscode.Uri }) => candidate.rootUri.fsPath === root);
    await repository?.status();
    const state = repository?.state as RepositoryState | undefined;
    const head = execFileSync('git', ['-C', root, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    if ((state && state.HEAD?.name === head && ready(state)) || Date.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
