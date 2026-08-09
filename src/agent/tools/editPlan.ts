/**
 * Working out what an edit would do, before anything touches disk.
 *
 * Pure on purpose. The dangerous part of an editing tool is not the write — it is
 * deciding *where* to write, and getting that wrong silently. String replacement in
 * particular fails in three ways that all look like success:
 *   - the target appears more than once, so the wrong one is changed
 *   - the target does not appear at all, so nothing changes and the model believes
 *     otherwise
 *   - whitespace differs invisibly, producing the second case
 *
 * All three are decided here, against strings, so they can be tested without a
 * filesystem or an extension host.
 */

export type EditFailure = 'not-found' | 'ambiguous' | 'unchanged';

export interface EditPlan {
  /** The full text the file should end up with. */
  next: string;
  /** How many lines changed, for the run log. */
  changedLines: number;
}

export class EditRefused extends Error {
  constructor(
    readonly reason: EditFailure,
    message: string,
    /** How many times the target was found, when that is the problem. */
    readonly occurrences?: number
  ) {
    super(message);
    this.name = 'EditRefused';
  }
}

/**
 * Plans a single unambiguous replacement.
 *
 * **Refuses when the target appears more than once.** A model asking to replace
 * `return null;` in a file with nine of them has not said which, and picking the first
 * is a coin flip dressed up as an edit — the caller must include enough surrounding
 * context to be unique. This is the single most valuable rule in the file.
 */
export function planReplace(current: string, find: string, replace: string): EditPlan {
  if (find === '') {
    throw new EditRefused('not-found', 'An empty search string matches everywhere and means nothing.');
  }

  const occurrences = countOccurrences(current, find);

  if (occurrences === 0) {
    throw new EditRefused(
      'not-found',
      `I couldn't find that text. Check the exact spacing — I match literally, not approximately.`
    );
  }

  if (occurrences > 1) {
    throw new EditRefused(
      'ambiguous',
      `That text appears ${occurrences} times. Include enough of the surrounding lines to point at one of them.`,
      occurrences
    );
  }

  if (find === replace) {
    throw new EditRefused('unchanged', 'That edit would change nothing.');
  }

  const next = current.replace(find, replace);
  return { next, changedLines: countChangedLines(current, next) };
}

/** Plans a whole-file write, used for new files and full rewrites. */
export function planWrite(current: string | undefined, contents: string): EditPlan {
  if (current === contents) {
    throw new EditRefused('unchanged', 'That file already says exactly that.');
  }

  return { next: contents, changedLines: countChangedLines(current ?? '', contents) };
}

/** Literal, non-overlapping occurrences. No regex — the needle is user text. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);

  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }

  return count;
}

/**
 * A rough count of differing lines, for reporting what a step did.
 *
 * Deliberately not a real diff: this number appears in a log line, and a proper
 * LCS diff would be a lot of machinery to make "3 lines" slightly more accurate.
 */
function countChangedLines(before: string, after: string): number {
  // A trailing newline is a terminator, not a line: 'a\nb\n'.split('\n') yields a
  // phantom empty element, and comparing it shifts every count by one — so adding two
  // lines to a normally-terminated file reported three.
  const beforeLines = withoutTrailingBlank(before.split('\n'));
  const afterLines = withoutTrailingBlank(after.split('\n'));
  const shared = Math.min(beforeLines.length, afterLines.length);

  let changed = Math.abs(beforeLines.length - afterLines.length);
  for (let index = 0; index < shared; index++) {
    if (beforeLines[index] !== afterLines[index]) changed++;
  }

  return changed;
}

function withoutTrailingBlank(lines: string[]): string[] {
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
}
