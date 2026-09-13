import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveInWorkspace, PathRefused } from '../agent/tools/workspacePaths';

/**
 * The workspace-containment boundary (Phase 1's fix — see plan.md), exercised
 * against the real `vscode.workspace.workspaceFolders` a live host provides,
 * rather than a string standing in for one. Unit tests already cover the pure
 * logic exhaustively; this confirms it is wired to the real thing.
 *
 * **Why this grew on 30 August 2026.** Stage 9 tried to settle the containment
 * matrix cell by asking the agent, in chat, to read a file outside the
 * workspace. Three attempts never reached the gate: an absolute path arrived at
 * the tool with its leading slash gone — `toolRegistry.ts` tells the model
 * "paths are relative to the workspace root", so a compliant one relativises
 * before calling — and two other phrasings produced no tool call at all. The
 * refusal that came back was a plain not-found, which looks exactly like a
 * containment refusal from the outside and is not one.
 *
 * So the cases below are the ones chat cannot produce, and the assertions check
 * the *reason*, never just that something was thrown. A test that accepts any
 * rejection would have passed against the not-found this pass mistook for a
 * pass.
 */
suite('workspace containment, against a real workspace folder', () => {
  const root = () => {
    const found = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    assert.ok(found, 'no workspace folder open — check .vscode-test.mjs workspaceFolder');
    return found;
  };

  /** Asserts the gate refused *for containment*, not for absence. */
  const refusedAsOutside = async (requested: string, why: string) => {
    await assert.rejects(
      () => resolveInWorkspace(root(), requested),
      (error: unknown) => {
        assert.ok(error instanceof PathRefused, `${why}: threw ${String(error)}, not PathRefused`);
        assert.equal(error.reason, 'outside-workspace', why);
        return true;
      },
      why
    );
  };

  test('a path inside the opened workspace resolves', async () => {
    const resolved = await resolveInWorkspace(root(), '.gitkeep');
    assert.equal(resolved, path.resolve(root(), '.gitkeep'));
  });

  test('a relative path climbing out is refused as outside, not as missing', async () => {
    await refusedAsOutside(path.join('..', 'outside.txt'), 'a `../` escape');
  });

  test('an absolute path outside the workspace is refused as outside', async () => {
    // The case the chat surface cannot produce, because the model relativises
    // it first. `path.resolve(root, '/abs')` returns `/abs` — so this is the one
    // input that reaches `isInside()` with something genuinely outside.
    await refusedAsOutside(path.join(os.tmpdir(), 'clarvis-containment-probe.txt'), 'an absolute path');
  });

  test('an absolute path *inside* the workspace still resolves', async () => {
    // The mirror of the case above, so the rule cannot be satisfied by refusing
    // every absolute path — which would be containment by accident.
    const inside = path.resolve(root(), '.gitkeep');
    assert.equal(await resolveInWorkspace(root(), inside), inside);
  });

  test('a symlink pointing out of the workspace is refused', async () => {
    // The second `isInside()`, after realpath. Nothing textual about this path
    // is suspicious — it sits in the workspace root — so only resolving the link
    // catches it. Skipped rather than failed where symlinks cannot be created,
    // because that is a property of the filesystem and not of the gate.
    //
    // **Named for this run alone.** On 13 Sep VS Code 1.137 ran this suite in two extension
    // hosts at once against the same folder. With fixed names, one host's cleanup deleted the
    // link the other was still checking — and a missing path inside the workspace resolves —
    // so the gate read as broken when only the fixture was shared.
    const unique = `${process.pid}-${Date.now()}`;
    const target = path.join(os.tmpdir(), `clarvis-containment-target-${unique}.txt`);
    const link = path.resolve(root(), `clarvis-containment-link-${unique}`);
    await fs.writeFile(target, 'outside the workspace root\n');
    try {
      await fs.symlink(target, link);
    } catch {
      await fs.rm(target, { force: true });
      return;
    }

    try {
      await refusedAsOutside(path.basename(link), 'a symlink leading out');
    } finally {
      await fs.rm(link, { force: true });
      await fs.rm(target, { force: true });
    }
  });

  test('a missing file inside the workspace resolves, because the gate is about place', async () => {
    // The distinction this whole suite exists for, and the first draft of this
    // test asserted it wrongly — expecting a rejection and getting none.
    //
    // `resolveInWorkspace` does not stat anything: it decides *where* a path is,
    // and a path inside the root resolves whether or not a file is there. The
    // not-found arrives later, from `readFile`. That separation is exactly why
    // the two failures are distinguishable at all — and why the chat pass, which
    // saw only the second, could not have been seeing the first.
    const missing = 'no-such-file-here.txt';
    assert.equal(await resolveInWorkspace(root(), missing), path.resolve(root(), missing));
  });
});
