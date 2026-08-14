import * as vscode from 'vscode';

/**
 * Workspace Trust, enforced where it can actually stop something.
 *
 * VS Code asks whether you trust a folder before you open it, because a repository is
 * data written by someone else: its settings, its tasks and its build scripts all run
 * on your machine. An extension that edits files and runs shell commands has to
 * respect that answer, or the question was theatre.
 *
 * **Declared in `package.json` and enforced here.** The manifest says Clarvis reads
 * and answers in an untrusted folder but never runs commands or edits files. Written
 * on its own, that sentence is a claim; `restrictedConfigurations` is enforced by the
 * editor, and this half was not enforced by anything until it was checked. A stated
 * guarantee nothing implements is worse than an admitted gap, which is the rule this
 * file exists to stop breaking.
 *
 * In the tool layer rather than in `AgentRunner`, with the workspace boundary, the
 * deny-list and the checkpoint: a coordinator can be talked around, and code that
 * refuses cannot.
 */

/** Thrown so the model sees a refusal it can report, not a crash. */
export class UntrustedWorkspaceError extends Error {
  constructor(action: string) {
    super(
      `This folder is open in Restricted Mode, so I can't ${action}. ` +
        'If it is yours and you trust it, use "Workspaces: Manage Workspace Trust" and try again.'
    );
    this.name = 'UntrustedWorkspaceError';
  }
}

/**
 * Refuses anything that changes the machine, in a folder nobody has vouched for.
 *
 * Reading is deliberately still allowed: answering "what does this file do?" about an
 * untrusted repository is the safe half of the product, and the half most likely to
 * be what you opened it for.
 */
export function requireTrust(action: string): void {
  if (!vscode.workspace.isTrusted) throw new UntrustedWorkspaceError(action);
}
