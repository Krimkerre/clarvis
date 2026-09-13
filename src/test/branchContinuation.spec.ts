import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentBranch } from '../agent/AgentBranch';

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
});
