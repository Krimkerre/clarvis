import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { canonicalRelative, resolveInWorkspace } from './workspacePaths';
import { EditPlan, planReplace, planWrite } from './editPlan';

/**
 * Changing files.
 *
 * Everything lands through a `WorkspaceEdit` rather than `fs.writeFile`, which is not
 * a stylistic choice: it puts the change in **VS Code's own undo stack**, so a user
 * who dislikes what the agent did presses Cmd-Z in the editor they already have open,
 * rather than learning a Clarvis-specific undo. It also means open dirty buffers are
 * updated instead of being silently overwritten on the next save — the failure that
 * loses work.
 *
 * The *decisions* live in `editPlan.ts` and are pure; this file is the part that must
 * talk to VS Code.
 */

export interface EditOutcome {
  /** Workspace-relative, for the run log and the model's own record. */
  file: string;
  changedLines: number;
  created: boolean;
}

/**
 * Replaces one unambiguous occurrence in a file.
 *
 * Reads through the *document* rather than from disk when the file is open, so an
 * unsaved buffer is what gets matched. Matching against stale disk contents and then
 * writing over the buffer is how an agent quietly discards someone's typing.
 */
export async function applyEdit(
  root: string | undefined,
  requested: string,
  find: string,
  replace: string
): Promise<EditOutcome> {
  const target = await resolveInWorkspace(root, requested);
  const uri = vscode.Uri.file(target);
  const current = await currentText(uri);

  if (current === undefined) {
    throw new Error(`\`${requested}\` doesn't exist yet. Write it first if that's the intent.`);
  }

  const plan = planReplace(current, find, replace);
  await commit(uri, current, plan);

  // Canonical, not as-requested: see canonicalRelative. A case-different spelling
  // edits the right file and then fails to commit it.
  return {
    file: await canonicalRelative(root!, target),
    changedLines: plan.changedLines,
    created: false,
  };
}

/** Writes a whole file, creating it and any missing directories. */
export async function writeFile(
  root: string | undefined,
  requested: string,
  contents: string
): Promise<EditOutcome> {
  const target = await resolveInWorkspace(root, requested);
  const uri = vscode.Uri.file(target);
  const current = await currentText(uri);
  const plan = planWrite(current, contents);

  if (current === undefined) {
    // Parent directories are created here rather than through the WorkspaceEdit, whose
    // createFile does not make intermediate folders.
    await fs.mkdir(path.dirname(target), { recursive: true });
  }

  await commit(uri, current, plan);

  return {
    file: await canonicalRelative(root!, target),
    changedLines: plan.changedLines,
    created: current === undefined,
  };
}

/**
 * The text as the user would see it: the open buffer if there is one, else disk.
 *
 * Returns undefined when the file does not exist, which the callers treat differently
 * — an edit refuses, a write creates.
 */
async function currentText(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === uri.fsPath);
  if (open) return open.getText();

  try {
    return await fs.readFile(uri.fsPath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Applies a planned change through VS Code.
 *
 * One full-range replace rather than a set of line edits: the plan already knows the
 * final text, and a whole-document replacement is atomic in the undo stack — a single
 * Cmd-Z restores the file, instead of unwinding an edit at a time.
 */
async function commit(uri: vscode.Uri, current: string | undefined, plan: EditPlan): Promise<void> {
  const edit = new vscode.WorkspaceEdit();

  if (current === undefined) {
    edit.createFile(uri, { overwrite: false, contents: Buffer.from(plan.next, 'utf8') });
  } else {
    const document = await vscode.workspace.openTextDocument(uri);
    const whole = new vscode.Range(
      document.positionAt(0),
      document.positionAt(document.getText().length)
    );
    edit.replace(uri, whole, plan.next);
  }

  const applied = await vscode.workspace.applyEdit(edit);
  if (!applied) {
    throw new Error('The editor refused that change. Something else may have the file locked.');
  }

  // Saved deliberately: an agent that leaves twenty dirty buffers behind has made the
  // user's next action "review and save twenty files", and a build run by a later step
  // would see the old contents on disk.
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty) await document.save();

  await reveal(document);
}

/**
 * Brings the file just changed into view, so a run can be watched rather than
 * reconstructed from a summary afterwards.
 *
 * **Focus is never taken.** `preserveFocus` keeps the cursor wherever the user left
 * it — an agent that yanked the editor mid-sentence every time it touched a file
 * would be unusable while it works, which is precisely when you want to watch it.
 * `preview: true` reuses the one tab as the run moves from file to file instead of
 * leaving thirty behind.
 *
 * Best effort throughout: a file that cannot be shown is not a failed edit, and
 * throwing here would undo work that has already landed on disk.
 */
async function reveal(document: vscode.TextDocument): Promise<void> {
  try {
    await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.One,
    });
  } catch {
    // Nothing to do about it, and nothing worth failing the edit over.
  }
}
