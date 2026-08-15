/**
 * The problems in the file someone is actually looking at, said back to them.
 *
 * **Because "anything wrong in here?" had no answer.** The facts carried counts —
 * "3 error(s), 1 warning(s), most of them in weather.go" — which is enough to remark
 * on and useless to act on. Asked what was wrong, the best he could do was tell you how
 * many things were wrong, which is the shape of an answer without being one.
 *
 * Found during the first afternoon of following a book: a syntax error left in on
 * purpose produced silence, because §4.2's pattern memory only speaks at the third
 * occurrence in seven days. That silence is right for a colleague and wrong for someone
 * who cannot yet tell "fine" from "not looking" — and the fix is not to lower the
 * threshold and become a second linter, but to answer when asked.
 *
 * §4.6 already lists active-file diagnostics as part of the bounded context a reply may
 * use, so this fills a gap the plan had specified rather than opening a new surface.
 *
 * Pure: the reading of the editor happens in `WorkspaceFactsReader`, the wording here.
 */

/** One complaint, as the editor reports it. */
export interface OpenProblem {
  /** 1-based, because that is what the editor's gutter shows. */
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

export interface OpenProblems {
  /** Workspace-relative path of the file being looked at. */
  file: string;
  /** Worst first, capped — see `LISTED`. */
  items: OpenProblem[];
  /** How many were left out of `items`. */
  more: number;
}

/**
 * How many to name before saying "and N more".
 *
 * Five is enough to act on and short enough to read aloud. A file mid-refactor can
 * carry forty, and forty lines of squiggle in a conversation is a log, not an answer.
 */
export const LISTED = 5;

/**
 * Sorts and caps what the editor reported.
 *
 * Errors before warnings, then by line, so the first thing named is the first thing to
 * fix. A warning is never listed above an error even when it comes first in the file.
 */
export function summariseProblems(file: string, problems: readonly OpenProblem[]): OpenProblems | undefined {
  if (problems.length === 0) return undefined;

  const sorted = [...problems].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    return a.line - b.line;
  });

  return { file, items: sorted.slice(0, LISTED), more: Math.max(0, sorted.length - LISTED) };
}

/**
 * The lines handed to the model, or used verbatim when there is no model.
 *
 * The file is named on its own line because the answer is about *that* file, and a
 * reply that lists four errors without saying where they are is a reply that has to be
 * asked a second question.
 */
export function problemLines(problems: OpenProblems): string[] {
  return [
    `Open in the editor right now — ${problems.file}:`,
    ...problems.items.map((item) => `- line ${item.line}: ${item.message} (${item.severity})`),
    ...(problems.more > 0 ? [`- and ${problems.more} more`] : []),
  ];
}

/**
 * The answer when nothing is wrong, which has to be said rather than implied.
 *
 * Silence is what "not looking" looks like, and the whole reason this exists is that a
 * quiet Clarvis was indistinguishable from a broken one.
 */
export function nothingWrong(file: string | undefined): string {
  return file
    ? `Nothing in ${file} — the editor has no complaints about it as it stands.`
    : 'Nothing open to look at, and no complaints anywhere in the project.';
}
