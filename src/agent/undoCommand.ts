/**
 * **Clarvis: Undo Last Agent Run**, as a sequence the fast suite can drive.
 *
 * **Said in the chat as well as in a notification.** A notification in the corner is easy to
 * miss, in code-server most of all: the owner ran the command, saw nothing, and concluded it had
 * done nothing, when it had said "There is nothing to undo" (attended session, 17 September
 * 2026). The later successful undo was called "quiet" for the same reason. The chat is where the
 * person is already looking, so the outcome goes there too.
 *
 * vscode-free: the host hands in the checkpoint, the dialogs and the chat.
 */

export interface UndoRecord {
  task: string;
  entries: readonly unknown[];
  startedOn?: string;
}

export interface UndoResult {
  restored: number;
  deleted: number;
  failed: string[];
  stuckOn?: string;
}

export interface UndoPorts {
  stored(): UndoRecord | undefined;
  /** The modal question; true when the person chose to undo. */
  confirm(question: string, detail: string): Promise<boolean>;
  undo(): Promise<UndoResult>;
  /** Voice's rewrite of a line, keeping the given figures; the written line when there is no voice. */
  phrase(purpose: 'report' | 'warn', fallback: string, keep?: string[]): Promise<string>;
  notify(kind: 'info' | 'warning', text: string): void;
  /** A line in the Clarvis chat. */
  tell(text: string): void;
}

/** What there was to undo. Plain, so it arrives at once rather than after a rewrite. */
export const NOTHING_TO_UNDO =
  "There is nothing to undo: the last run left no copies to put back. A Codex task's work is also on its own branch, and asking Codex to undo it works too.";

export async function undoLastRun(ports: UndoPorts): Promise<void> {
  const record = ports.stored();
  if (!record || record.entries.length === 0) {
    ports.notify('info', NOTHING_TO_UNDO);
    ports.tell(NOTHING_TO_UNDO);
    return;
  }

  const confirmed = await ports.confirm(
    `Undo the last run — "${record.task}"?`,
    `${record.entries.length} file(s) go back to how they were before it started. ` +
      'Anything you changed since then in those files goes too.' +
      (record.startedOn ? ` You will be put back on \`${record.startedOn}\`.` : '')
  );
  if (!confirmed) return;

  const result = await ports.undo();
  const failed = result.failed.length > 0;
  const summary =
    (await ports.phrase(
      failed ? 'warn' : 'report',
      `Undone: restored ${result.restored} file(s), removed ${result.deleted}` +
        (failed ? `, and failed on ${result.failed.join(', ')}.` : '.'),
      [String(result.restored), String(result.deleted)]
    )) +
    // Said plainly rather than phrased: being left somewhere you did not expect is
    // the kind of thing a joke would bury.
    (result.stuckOn
      ? ` You are still on the run's branch — I could not switch back to \`${result.stuckOn}\` with unsaved changes in the way.`
      : '');

  // A partial restore is a warning, not an information message: half undone is a state
  // someone needs to look at rather than be reassured about.
  ports.notify(failed ? 'warning' : 'info', summary);
  ports.tell(summary);
}
