import * as vscode from 'vscode';

/**
 * The first repository the built-in Git extension knows about, activating it if it has
 * not started yet.
 *
 * **Activating rather than giving up is the whole point of the shared version.** During
 * Clarvis's own activation the Git extension's `isActive` is still false, and a caller
 * that checks it and returns `undefined` sees no repository in a folder that plainly is
 * one — `BranchFlowWatcher` carries the scar tissue for that ("checking it and giving
 * up is how the watcher came to never run at all"). Two files had already written this
 * function identically, byte for byte; a third place to fix it was one keystroke away.
 *
 * **Generic over the repository shape on purpose.** The Git extension's API is untyped,
 * and every caller here declares only the slice of it that it actually touches — a
 * narrower contract than one shared `GitRepository` interface listing every field
 * anybody uses. That segregation is worth keeping, so the shape is the caller's to name
 * and only the fetching lives here.
 *
 * Returns `undefined` for all three "no repository" causes alike: extension absent, not
 * activatable, or no repository scanned yet. Callers that need to tell those apart do it
 * themselves (`AgentBranch.diagnoseGit`).
 */
export async function firstGitRepository<Repository>(): Promise<Repository | undefined> {
  const extension = vscode.extensions.getExtension<GitExports<Repository>>('vscode.git');
  if (!extension) return undefined;

  const exports = extension.isActive ? extension.exports : await extension.activate();
  return exports?.getAPI?.(1)?.repositories?.[0];
}

/** The one method of the Git extension's exports that anything here calls. */
interface GitExports<Repository> {
  getAPI(version: 1): { repositories: Repository[] };
}
