/**
 * The conversation, as data.
 *
 * Pure and `vscode`-free so the cap and the ordering can be tested without a Memento
 * or an extension host — the two things most likely to be quietly wrong are "does the
 * cap actually drop the *oldest*" and "does a restored thread survive a shape change",
 * and neither needs VS Code to answer.
 */
export type Speaker = 'user' | 'clarvis';

export interface Turn {
  speaker: Speaker;
  text: string;
  at: number; // epoch ms
}

/**
 * How many turns are kept.
 *
 * Generous enough that a day's questions stay readable, bounded because
 * `workspaceState` is not a database and an unbounded thread would grow forever in a
 * long-lived workspace.
 */
export const MAX_TURNS = 50;

/** Appends a turn, dropping the oldest once the cap is passed. */
export function appendTurn(thread: Turn[], turn: Turn, max = MAX_TURNS): Turn[] {
  const next = [...thread, turn];
  return next.length > max ? next.slice(next.length - max) : next;
}
