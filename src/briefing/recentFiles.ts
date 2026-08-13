/**
 * A fixed-size record of the files most recently saved, newest first.
 *
 * **Persisted across sessions**, and it has to be: the briefing is delivered a second
 * after launch, so a session-only buffer would be empty at precisely the moment it's
 * read. "What was I working on" is a question about the *last* sitting, not this one.
 * (M4's build notes originally said session-only — that was wrong, and would have
 * shipped a line that never appeared.)
 *
 * Deliberately free of any vscode import so the ordering and capping logic stays
 * testable without an extension host; persistence is the caller's job.
 */
/**
 * Paths that are never "what you were working on".
 *
 * VS Code saves `COMMIT_EDITMSG` when you commit through the Source Control view, so
 * committing put *git's own scratch file* at the top of the list — and the briefing
 * duly reported "last edits were to plan.md, README.md, and a commit message". Seen in
 * a real session, which is the only way this was ever going to be noticed.
 *
 * Everything under `.git/` goes the same way: rebase state, merge messages, hooks
 * being edited by a tool. None of it is the user's work.
 */
const NEVER_RECORD = [/[\\/]\.git[\\/]/, /COMMIT_EDITMSG$/, /MERGE_MSG$/, /TAG_EDITMSG$/, /[\\/]node_modules[\\/]/];

/** Whether a saved file is the user's work rather than a tool's paperwork. */
export function isWorthRemembering(path: string): boolean {
  return !NEVER_RECORD.some((pattern) => pattern.test(path));
}

export class RecentFiles {
  private paths: string[];

  constructor(private readonly capacity = 5, initial: readonly string[] = []) {
    this.paths = initial.slice(0, capacity);
  }

  /**
   * Records a save. Re-saving a file already in the list moves it to the front rather
   * than duplicating it — otherwise saving one file six times erases the memory of
   * everything else, which is exactly what happens while debugging.
   */
  record(path: string): void {
    if (!isWorthRemembering(path)) return;

    const existing = this.paths.indexOf(path);
    if (existing !== -1) this.paths.splice(existing, 1);

    this.paths.unshift(path);
    if (this.paths.length > this.capacity) this.paths.length = this.capacity;
  }

  /** Most recently saved first. A copy, so callers can't mutate the buffer. */
  list(): string[] {
    return [...this.paths];
  }
}
