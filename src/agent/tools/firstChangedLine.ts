/**
 * Where a change landed, for pointing an editor at it.
 *
 * Pure and `vscode`-free for the usual reason: this is the part worth testing, and
 * it lived inside `editTools.ts` where a test could not reach it past the import.
 */

/**
 * The first line where two versions of a file diverge.
 *
 * Deliberately the crudest possible diff: a real one would find the smallest set of
 * changes, and all this needs is somewhere honest to point the cursor. A trailing
 * append answers with the end of the old file, which is exactly right.
 */
export function firstChangedLine(before: string, after: string): number {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');

  const shared = Math.min(oldLines.length, newLines.length);
  for (let line = 0; line < shared; line++) {
    if (oldLines[line] !== newLines[line]) return line;
  }

  // No difference in the shared prefix, so the change is whatever came after it.
  return shared === newLines.length ? Math.max(shared - 1, 0) : shared;
}

