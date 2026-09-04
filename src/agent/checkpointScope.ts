import * as crypto from 'crypto';

/**
 * Which checkpoint belongs to which window.
 *
 * **One installation, several windows, one checkpoint.** `Checkpoint` kept both its
 * record and its file copies in installation-wide storage: a single
 * `clarvis.agent.checkpoint` key, and a single `checkpoint/` directory. Two windows open
 * on two projects therefore shared one undo, and `begin()` clears the store at the start
 * of every run — so starting a run in the second window silently destroyed the first
 * window's ability to undo. Nothing reported it: the record still existed, its entries
 * still named files, and the copies those entries pointed at were gone.
 *
 * Scoping by workspace is what makes the two independent. The record moves to
 * `workspaceState`, which VS Code already keys per workspace, and the copies move into a
 * subdirectory named by this function.
 */

/** A window with no folder open. Named rather than empty, so it reads as a place. */
export const NO_WORKSPACE = 'no-workspace';

/**
 * A stable, filesystem-safe directory name for one workspace root.
 *
 * **A hash rather than the path itself.** A workspace root can contain characters no
 * filesystem wants in a directory name, can be longer than a path component may be, and
 * on a shared machine names things the person might not want written into a second
 * location. A hash is none of those and is still stable across restarts, which is the
 * only property the store needs — nothing ever has to read the path back out of it.
 *
 * Truncated to sixteen characters. Collision here would mean two workspaces sharing a
 * checkpoint directory, which is the bug this fixes; sixteen hex characters is 64 bits,
 * and a person with enough open projects to trouble that has other problems.
 */
export function scopeFor(root: string | undefined): string {
  if (!root) return NO_WORKSPACE;
  return crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
}
