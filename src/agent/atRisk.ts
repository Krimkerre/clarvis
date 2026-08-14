/**
 * What a shell command could destroy that nothing else could give back.
 *
 * **The asymmetry this closes.** Every write through the edit tools calls
 * `Checkpoint.capture` with the path it is about to change, so an edit has always
 * been undoable. A command names no paths — `rm -rf src` goes through `runCommand`,
 * touches nothing the checkpoint knows about, and was the one thing the agent could
 * do that undo could not reverse. Which is exactly why the deny-list had to be
 * perfect, and exactly why a deny-list never can be.
 *
 * Pure, so the arithmetic can be tested without a repository: what is at risk is what
 * git has no copy of.
 */

/** One entry as the editor's Git extension reports it. */
export interface Change {
  uri: { fsPath: string };
}

/**
 * Files at risk: modified, staged, and never seen by git at all.
 *
 * Everything else in a repository is already recoverable from git itself, so
 * snapshotting it would be copying the workspace to protect against a thing the
 * workspace is already protected from.
 *
 * Deduplicated: a file can be staged *and* modified, and copying it twice would
 * make the second copy the one restored — the wrong half of the change.
 */
export function atRiskPaths(state: {
  workingTreeChanges?: Change[];
  indexChanges?: Change[];
  untrackedChanges?: Change[];
}): string[] {
  const all = [
    ...(state.workingTreeChanges ?? []),
    ...(state.indexChanges ?? []),
    ...(state.untrackedChanges ?? []),
  ].map((change) => change.uri.fsPath);

  return [...new Set(all)];
}
