import { StepResult } from './planUpdate';

/**
 * Reading a run's own report into a set of step results.
 *
 * Pure and `vscode`-free for the usual reason: this is the part worth testing, and it
 * started inside `recordMilestone.ts` where the import wall kept a test from reaching
 * it at all.
 *
 * **The report, not the code.** What matters is what the agent said it did and what
 * its checks printed. Inspecting the files afterwards would be a second opinion about
 * work already described, and one that cannot tell a step that was finished from a
 * step that merely looks finished.
 */

export const TIMEOUT_MS = 15000;
export const MAX_RESPONSE_CHARS = 4000;

/** How long the report can be before it is worth trimming rather than sending whole. */
const MAX_SUMMARY_CHARS = 4000;

export function recordMilestonePrompt(planText: string, summary: string): string {
  return [
    "Here is a project's plan.md:",
    '',
    planText.slice(0, 8000),
    '',
    'And here is what the agent reported after working on it:',
    '',
    summary.slice(0, MAX_SUMMARY_CHARS),
    '',
    'For each build step in the plan, say whether the report shows it finished, and',
    'what its check produced if the report says.',
    '',
    'Output one line per step, in exactly this format and nothing else:',
    'the step text | done or not done | what the check produced, or - if the report does not say',
    '',
    'Copy the step text exactly as it appears in the plan. Only mark a step done if the',
    'report actually says it was done — a step nobody mentioned is not done, and a',
    'check that failed is "not done" with the failure as its result. Do not invent an',
    'outcome for a check that was never run.',
  ].join('\n');
}

/** Parses `step | done | result` lines. Anything malformed is dropped, not guessed at. */
export function parseStepResults(text: string): StepResult[] {
  return text
    .split('\n')
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts) => parts.length >= 2 && parts[0].length > 0)
    .map(([step, state, ...rest]) => {
      const result = rest.join(' | ').trim();
      return {
        step,
        done: /^(done|yes|true|complete)/i.test(state),
        result: result && result !== '-' ? result : undefined,
      };
    });
}

