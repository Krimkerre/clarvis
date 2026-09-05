import * as assert from 'assert';
import * as vscode from 'vscode';
import { MARKER, TASK_FILE } from '../planning/nervisHandoff';
import { clearNervisTask, waitingNervisTask } from '../planning/nervisTaskFile';

/**
 * Reading and deleting the handoff file, against a real workspace (E-C8).
 *
 * **The half that had no test at all.** `nervisHandoff.ts` is pure and thoroughly
 * covered; `nervisTaskFile.ts` is the half that needs an editor, and reverifying E-C8
 * against §14.8 found it exercised by nothing — a test of the parser is not a test of
 * the reader, and the reader is what decides whether a task is ever seen.
 *
 * Written as a host test rather than with a stubbed `vscode.workspace.fs` because the
 * two things worth proving are both properties of the real API: that a file NERVIS
 * wrote is found in the folder actually open, and that clearing it really removes it —
 * a stub would agree with whatever this file assumed.
 */
suite('the NERVIS handoff file, against a real workspace', () => {
  const uri = () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'no workspace folder open — check .vscode-test.mjs workspaceFolder');
    return vscode.Uri.joinPath(folder.uri, TASK_FILE);
  };

  const write = async (body: string) =>
    vscode.workspace.fs.writeFile(uri(), Buffer.from(body, 'utf8'));

  /** Left behind by a failing test, so the next one starts from nothing. */
  teardown(async () => {
    await vscode.workspace.fs.delete(uri()).then(undefined, () => undefined);
  });

  test('a task NERVIS wrote is found in the open workspace', async () => {
    await write(
      `${MARKER}\n\n# Task from NERVIS\n\nAdd a retry to the uploader.\n\n---\n` +
        'Asked on 2026-09-05 09:00 UTC in conversation `c-91`.\n'
    );

    const found = await waitingNervisTask();

    assert.ok(found, 'the file is in the workspace root and was not read back');
    assert.equal(found.task, 'Add a retry to the uploader.');
    assert.equal(found.askedOn, '2026-09-05 09:00 UTC');
    assert.equal(found.conversation, 'c-91');
  });

  test('a file without the marker is somebody else’s document', async () => {
    // The offer exists to say where a task came from. A file the user wrote themselves
    // and happened to name `clarvis-task.md` must not be announced as another
    // program's work — which is why the marker is matched, not the filename.
    await write('# Task from NERVIS\n\nSomething I typed myself.\n\n---\n');

    assert.equal(await waitingNervisTask(), undefined);
  });

  test('nothing waiting reads as nothing, not as an error', async () => {
    assert.equal(await waitingNervisTask(), undefined);
  });

  test('clearing removes the file, so the same task is not offered again', async () => {
    await write(`${MARKER}\n\n# Task from NERVIS\n\nOne thing.\n\n---\n`);
    assert.ok(await waitingNervisTask());

    await clearNervisTask();

    assert.equal(await waitingNervisTask(), undefined);
    await assert.rejects(() => Promise.resolve(vscode.workspace.fs.stat(uri())));
  });

  test('clearing nothing is not an error', async () => {
    // It runs on the decline path too, and a window opened twice would otherwise throw
    // on a file the first one already took away.
    await clearNervisTask();
  });
});
