import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { setUpGitHere } from '../agent/gitOffer';
import { repositoryForFolder } from '../agent/repositoryForFolder';

/**
 * **Set up git here** against the real Git extension (plan.md M15, "Codex offers to set git up"). The setup itself is
 * unit-tested with real git (`gitSetup.test.ts`) and the offer through the chat's question (`codexGitSetup.test.ts`);
 * this checks the one part only an extension host has: once git is set up, the Git extension sees the repository and
 * its first commit — which is what a Codex branch is made through — before the task is carried on.
 *
 * In a temporary folder, never this repository, with a name and email of its own so the commit doesn't depend on the
 * machine running the suite.
 */
suite('setting git up for Codex in the extension host (M15)', () => {
  let base = '';
  const identity = {
    GIT_AUTHOR_NAME: 'Clarvis test',
    GIT_AUTHOR_EMAIL: 'clarvis-test@example.invalid',
    GIT_COMMITTER_NAME: 'Clarvis test',
    GIT_COMMITTER_EMAIL: 'clarvis-test@example.invalid',
  };
  const before: Record<string, string | undefined> = {};

  suiteSetup(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-git-setup-host-')));
    for (const [key, value] of Object.entries(identity)) {
      before[key] = process.env[key];
      process.env[key] = value;
    }
  });

  suiteTeardown(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('git is set up with a first commit the Git extension sees, and the folder’s files stay uncommitted', async function () {
    this.timeout(30_000);
    const root = path.join(base, 'codex test b');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'notes.md'), '# a folder without git\n');

    const result = await setUpGitHere(root, () => undefined);

    assert.ok(result.ok, JSON.stringify(result));
    assert.strictEqual(result.madeFirstCommit, true);
    assert.strictEqual(result.editorCaughtUp, true, 'the Git extension saw the first commit');
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const api = (await vscode.extensions.getExtension('vscode.git')?.activate())?.getAPI(1);
    assert.strictEqual(repositoryForFolder(api?.repositories as { rootUri?: { fsPath: string }; state: { HEAD?: { commit?: string } } }[], root)?.state.HEAD?.commit, head);
    assert.strictEqual(execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '?? notes.md');
  });
});
