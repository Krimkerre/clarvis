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
