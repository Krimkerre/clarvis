import * as vscode from 'vscode';

import { NervisTask, parseNervisTask, TASK_FILE } from './nervisHandoff';

/**
 * Touching the handoff file (E-C8). The parsing lives in `nervisHandoff.ts`,
 * which is testable; this is the half that needs a workspace.
 */

/**
 * The task waiting in this workspace, if NERVIS left one.
 *
 * Read from disk every time, never remembered — `pendingBuild`'s reasoning
 * applies exactly: the file outlives the window, and the user may have edited or
 * deleted it since, which is their document's prerogative.
 */
export async function waitingNervisTask(): Promise<NervisTask | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const text = await vscode.workspace.fs
    .readFile(vscode.Uri.joinPath(folder.uri, TASK_FILE))
    .then((bytes) => Buffer.from(bytes).toString('utf8'), () => undefined);
  return text ? parseNervisTask(text) : undefined;
}

/**
 * Drop the file once it has been taken up.
 *
 * Deleted rather than marked done: NERVIS writes one task at a time and
 * overwrites an unread one, so a file left behind would be offered again every
 * time the window opened — the nagging §6 exists to prevent.
 */
export async function clearNervisTask(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  await vscode.workspace.fs
    .delete(vscode.Uri.joinPath(folder.uri, TASK_FILE))
    .then(undefined, () => undefined);
}
