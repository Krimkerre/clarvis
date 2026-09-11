import { normaliseStepText } from '../planning/planUpdate';
/**
 * Knowing which build step a run is on, while it is on it.
 *
 * A long milestone showed narration and nothing else: plenty of activity, no sense of
 * position. `plan.md` is the checklist, but it is a file, written at plan time and
 * updated once at the end — so during the twenty minutes that matter, the one thing
 * the user could not see was how far through they were.
 *
 * **A marker in the model's own output, parsed out before anyone sees it.** The same
 * mechanism `replyState.ts` uses to carry a facial expression, and for the same
 * reasons: a tool call is unavailable on this path and a second request would double
 * the cost of every step to learn something the model already knows. The agent is
 * told to announce each step as it begins; this finds those announcements and removes
 * them from the text.
 */

/** The marker, anywhere in a line of its own. Case-insensitive: models vary. */
const STEP_TAG = /^[ \t]*STEP:[ \t]*(.+?)[ \t]*$/gim;

/** What a run has announced so far. */
export interface StepProgress {
  /** Steps announced, in order, oldest first. */
  announced: string[];
  /** The text with every marker removed. */
  text: string;
}

/**
 * Pulls step announcements out of a fragment of narration.
 *
 * Returns the cleaned text as well as what it found, because the caller needs both:
 * one goes to the terminal, the other to the progress display. A fragment with no
 * marker comes back untouched, which is the overwhelmingly common case.
 */
export function readStepMarkers(text: string): StepProgress {
  const announced: string[] = [];

  const cleaned = text.replace(STEP_TAG, (_, step: string) => {
    announced.push(step.trim());
    return '';
  });

  return { announced, text: cleaned };
}

/**
 * Which planned step an announcement refers to, by position in the list.
 *
 * **Matched loosely, and never guessed.** The model rewords steps — dropping a
 * trailing clause, changing "the" to "a" — and an exact match would find nothing the
 * moment it did. But a wrong match moves the progress bar to the wrong place, which
 * is worse than not moving it, so an announcement that matches nothing returns
 * `undefined` and the display holds where it was.
 */
export function matchStep(announced: string, steps: string[]): number | undefined {
  const target = normaliseStepText(announced);
  if (!target) return undefined;

  const exact = steps.findIndex((step) => normaliseStepText(step) === target);
  if (exact !== -1) return exact;

  // One contains the other: "Create the CLI entry point" announced as "Create the CLI
  // entry point that takes a filename" is plainly the same step.
  const contained = steps.findIndex((step) => {
    const candidate = normaliseStepText(step);
    return candidate.includes(target) || target.includes(candidate);
  });

  return contained === -1 ? undefined : contained;
}

/**
 * Whether a reply was nothing but step announcements.
 *
 * The one case where a reply with no tool calls is not the model saying it has finished:
 * it named the step it was starting and stopped there (found live, 11 September 2026).
 */
export function onlyAnnounced(text: string): boolean {
  const { announced, text: rest } = readStepMarkers(text);
  return announced.length > 0 && rest.trim() === '';
}
