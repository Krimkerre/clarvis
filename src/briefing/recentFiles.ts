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
 *
 * **And `settings.json`, which Clarvis writes himself.** Changing the chat mode,
 * enabling voice or storing an engine all call `config.update()`, VS Code saves the
 * file, and the save arrives here like any other. So a session where the user touched
 * nothing at all opened with "settings.json was the last thing you touched" — his own
 * paperwork, handed back as their work. Reported live, and the same shape as the
 * commit-message bug: a tool's file counted as a person's.
 */
const NEVER_RECORD = [
  /[\\/]\.git[\\/]/,
  /COMMIT_EDITMSG$/,
  /MERGE_MSG$/,
  /TAG_EDITMSG$/,
  /[\\/]node_modules[\\/]/,
  // The workspace's editor config, and the global one — which lives outside any
  // workspace, under the editor's own User directory. Deliberately not a bare
  // `settings.json` rule: a project that ships its own config file of that name is
  // the user's work, and excluding it would trade one wrong answer for another.
  /[\\/]\.vscode[\\/]/,
  /[\\/]Code[\\/]User[\\/]/,
  // code-server keeps the same file under its own name. Named here for the case with
  // no folder open; with one, the rule below already refuses anything outside it.
  /[\\/]code-server[\\/]User[\\/]/,
];

/**
 * Whether a saved file is the user's work rather than a tool's paperwork.
 *
 * **Inside the project, when the project is known.** Found on 12 September 2026: in
 * code-server the editor's own settings live under `code-server/User/`, which the
 * `Code/User` rule above never matched, so every time Clarvis wrote a setting the
 * briefing greeted the next window with "You were last in settings.json" — about a
 * project with nothing open. Naming each editor's folder is a list that is always one
 * editor short; "what you were working on" in this project is a file in this project,
 * so a path outside every workspace folder is not recorded at all. With no folder
 * open there is nothing to be inside, and only the named rules apply.
 */
export function isWorthRemembering(path: string, roots: readonly string[] = []): boolean {
  if (NEVER_RECORD.some((pattern) => pattern.test(path))) return false;
  return roots.length === 0 || roots.some((root) => isInside(path, root));
}

/** Whether `path` is `root` or below it — `/proj-other` is not inside `/proj`. */
function isInside(path: string, root: string): boolean {
  const base = root.replace(/[\\/]+$/, '');
  return path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}\\`);
}

export class RecentFiles {
  private paths: string[];

  constructor(
    private readonly capacity = 5,
    initial: readonly string[] = [],
    /** The workspace folders a remembered file has to be inside, when there are any. */
    private readonly roots: readonly string[] = []
  ) {
    this.paths = initial.slice(0, capacity);
  }

  /**
   * Records a save. Re-saving a file already in the list moves it to the front rather
   * than duplicating it — otherwise saving one file six times erases the memory of
   * everything else, which is exactly what happens while debugging.
   */
  record(path: string): void {
    if (!isWorthRemembering(path, this.roots)) return;

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
