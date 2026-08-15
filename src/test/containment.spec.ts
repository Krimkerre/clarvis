import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveInWorkspace, PathRefused } from '../agent/tools/workspacePaths';

/**
 * The workspace-containment boundary (Phase 1's fix — see plan.md), exercised
 * against the real `vscode.workspace.workspaceFolders` a live host provides,
 * rather than a string standing in for one. Unit tests already cover the pure
 * logic exhaustively; this just confirms it's wired to the real thing.
 */
suite('workspace containment, against a real workspace folder', () => {
  test('a path inside the opened workspace resolves', async () => {
    const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    assert.ok(root, 'no workspace folder open — check .vscode-test.mjs workspaceFolder');

    const resolved = await resolveInWorkspace(root, '.gitkeep');
    assert.equal(resolved, path.resolve(root, '.gitkeep'));
  });

  test('a path outside the opened workspace is refused', async () => {
    const root = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    assert.ok(root);

    await assert.rejects(() => resolveInWorkspace(root, path.join(root, '..', 'outside.txt')), PathRefused);
  });
});
