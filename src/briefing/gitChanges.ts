/**
 * Telling a stray file apart from unfinished work.
 *
 * Its own module, importing nothing from `vscode`, because that is what makes it
 * testable — and this is logic that was wrong twice in a row while looking obviously
 * right, which is the definition of something that needs a test rather than a reading.
 */

/**
 * Untracked files are not "uncommitted changes".
 *
 * The Git extension reports them inside `workingTreeChanges`, so a stray `.DS_Store` or
 * a scratch note made Clarvis open with "one file uncommitted" about a file the user had
 * never edited — sounding wrong about their own repository, which is worse than saying
 * nothing. Newer API versions expose `untrackedChanges` separately; older ones only tag
 * each change with a status, where `7` is UNTRACKED. Probed rather than assumed (§4.0),
 * because this shape comes from another extension's exports and is not in `@types/vscode`.
 */
export const UNTRACKED = 7;

export function splitChanges(state: {
  workingTreeChanges?: { status?: number }[];
  untrackedChanges?: { status?: number }[];
}): { tracked: number; untracked: number } {
  // **Filter first, always.** The first version trusted `untrackedChanges` to mean that
  // `workingTreeChanges` held only tracked files. It does not: this host reports the
  // same untracked file in both, so a clean tree with one stray note was announced as
  // "one file uncommitted" — about a file the user had never edited, which is the exact
  // complaint the split was meant to fix.
  const working = state.workingTreeChanges ?? [];
  const tracked = working.filter((change) => change.status !== UNTRACKED);

  // Whichever list actually holds them. Counted as a set of paths would be safer still,
  // but the API gives no stable identity here and a count is all anyone reads.
  const untracked = Math.max(
    working.length - tracked.length,
    state.untrackedChanges?.length ?? 0
  );

  return { tracked: tracked.length, untracked };
}
