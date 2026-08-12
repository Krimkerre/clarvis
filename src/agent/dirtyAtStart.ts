/**
 * Keeping the user's work-in-progress out of the agent's commit.
 *
 * §4.6 already says never `git add -A`, and the run only ever stages the paths it
 * touched. That is not enough on its own, and a live session showed why: the user had
 * uncommitted edits in `sum.js`, asked for the failing test to be fixed, and the agent
 * edited and committed **the same file**. The commit was correctly scoped to its own
 * paths, and it still swept up work that was not its own — because "its own paths" and
 * "the user's paths" overlapped.
 *
 * So the rule is about *time*, not about scope: a file that was already modified when
 * the run started belongs to the user, whatever the run then does to it. Those stay
 * uncommitted, and the run says so rather than quietly leaving them behind.
 *
 * Pure, because the interesting part is the set arithmetic and the honesty of the
 * report, neither of which needs a repository to test.
 */

export interface CommitPlan {
  /** Paths this run may commit. */
  commit: string[];
  /**
   * Paths held back because the user was already editing them.
   *
   * Named rather than counted: "one file was left out" invites the question, and the
   * answer is the only thing that lets someone check the work.
   */
  heldBack: string[];
}

/**
 * Splits what a run touched into what it may commit and what it must not.
 *
 * Comparison is on the exact strings both sides already use — workspace-relative paths
 * produced by `canonicalRelative` — so case-different spellings of the same file are
 * already reconciled before they arrive here.
 */
export function planCommit(touched: string[], dirtyAtStart: string[]): CommitPlan {
  const theirs = new Set(dirtyAtStart);

  return {
    commit: touched.filter((path) => !theirs.has(path)),
    heldBack: touched.filter((path) => theirs.has(path)),
  };
}

/**
 * What to tell the user about the files that were held back.
 *
 * Undefined when there is nothing to say, so the caller adds no sentence rather than an
 * empty one. The wording states the situation and stops: their edit and the run's edit
 * are now in the same file, and only they can say what to do about that.
 */
export function explainHeldBack(heldBack: string[]): string | undefined {
  if (heldBack.length === 0) return undefined;

  const list = heldBack.join(', ');
  return heldBack.length === 1
    ? `You already had uncommitted changes in ${list}, so I left it out of my commit — your edits and mine are both sitting in it, unsaved.`
    : `You already had uncommitted changes in ${list}, so I left them out of my commit — your edits and mine are both sitting in those files, unsaved.`;
}
