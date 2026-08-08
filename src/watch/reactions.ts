import type { ButlerState } from '../panels/ButlerViewProvider';
import type { Outcome } from './BusyTracker';

/**
 * Picks the expression a finished job earns.
 *
 * Three cases, not two — the difference matters:
 *  - clean exit: quietly impressed
 *  - a real failure (nonzero exit): genuine alarm
 *  - no exit code at all: a debug session ending, or work the user cancelled
 *    themselves. Neither is a failure, and looking shocked at someone for stopping
 *    their own build would be obnoxious — so this stays merely skeptical.
 *
 * Lives in its own module, with only type-level imports, so it stays testable
 * without an extension host (importing anything that pulls in `vscode` would make
 * it unloadable outside VS Code).
 */
export function reactionTo(outcome: Outcome): ButlerState {
  if (outcome.exitCode === 0) return 'impressed';
  if (outcome.exitCode === undefined) return 'judging';
  return 'surprised';
}
