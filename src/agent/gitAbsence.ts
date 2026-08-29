/**
 * Why the Git extension is not there, when it is not there.
 *
 * `vscode-free`, so the fast suite can reach it — the line it replaces lives in
 * `BranchFlowWatcher`, which imports `vscode`.
 *
 * Written after watching Clarvis log *"branch flow: no Git extension, not
 * watching"* under code-server with a perfectly good git on PATH and
 * `vscode.git` shipped in the install. Both true statements; neither actionable.
 * The actual cause was Workspace Trust: code-server opens a folder in Restricted
 * Mode by default, and VS Code's own dialog says extensions are activated only
 * *"In a Trusted Folder"* — so `getExtension('vscode.git')` returns nothing and
 * every branch, worktree, checkpoint and undo flow silently does not run.
 *
 * "No Git extension" sends somebody to install one. "This folder is not trusted"
 * sends them to the button that fixes it.
 */
export function gitAbsenceReason(trusted: boolean): string {
  if (!trusted) {
    return 'branch flow: this folder is not trusted, so the Git extension is switched off — ' +
      'trust it to get branch, checkpoint and undo back';
  }
  return 'branch flow: no Git extension, not watching';
}
