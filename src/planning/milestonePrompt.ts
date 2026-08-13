import { InterviewState, knownFacts } from './interviewTopics';
import { FindingVerdict } from './verdictSummary';

/**
 * Turning an interview into actual build steps (M9d — §4.9).
 *
 * **The gap this closes.** Milestone one was assembled from the definition of done
 * plus every accepted finding's suggested fix — and a finding's fix is a
 * *clarification*: "Clarify whether v1 accepts user-provided words". Handed that as
 * a task, the agent read the plan, found nothing it could do, and stopped. A plan
 * that cannot be built from is not a plan; it is a summary of an interview.
 *
 * So the steps are asked for directly, as work: things that can be done and then
 * checked. The findings stay where they belong — as questions to settle, listed
 * apart from the work rather than mixed into it.
 */

/** Enough to be a real first milestone, few enough to be finished. */
const MIN_STEPS = 3;
const MAX_STEPS = 6;

export function milestonePrompt(state: InterviewState, accepted: FindingVerdict[] = []): string {
  // The user's own wording wins for a modified finding, same rule as everywhere else.
  const findings = accepted.map((verdict) =>
    verdict.status === 'modified'
      ? (verdict.reasoning ?? verdict.finding.what)
      : verdict.finding.suggestedResolution
  );

  return [
    'Here is everything established in a project-planning interview:',
    '',
    knownFacts(state),
    '',
    ...(findings.length > 0
      ? [
          'They also reviewed the plan and accepted these points:',
          ...findings.map((finding) => `- ${finding}`),
          '',
          // **Some of these are work and some are questions, and the difference is
          // the whole point.** Folding all of them in as steps is what emptied
          // milestone one before: "Clarify whether v1 accepts user-provided words" is
          // not something anyone can build. Dropping all of them loses the fixes the
          // user just agreed to. Only the model reading both can tell which is which.
          'Fold the ones that describe actual work into the steps below, in the place',
          'they belong in the order — a fix agreed before building starts is part of',
          'building, not a note about it. Leave out the ones that only ask a question',
          'to be settled; those are recorded separately and are not work.',
          '',
        ]
      : []),
    `Write the build steps for milestone one — ${MIN_STEPS} to ${MAX_STEPS} of them, in the order`,
    'they should be done.',
    '',
    'Each step is a piece of work someone can actually do and then check off — "Create',
    'the CLI entry point that takes a filename argument", not "Decide how the CLI',
    'should work". A step that asks a question rather than doing something belongs in',
    'the open questions, not here.',
    'Start with the smallest thing that runs end to end, then build outward from it.',
    'Stay inside what was described: no packaging or CI unless they were asked for.',
    '',
    // **Every step carries how to know it worked.** A checklist you can only tick by
    // believing yourself is not a checklist. The check is written now, with the step,
    // rather than after the code exists — by then it is a description of whatever got
    // built rather than a test of what was meant.
    'For each step, also give the check that proves it works: a command to run and what',
    'it should print, or a specific thing to do and what should happen. Concrete enough',
    'that someone else could run it and agree. Not "verify it works".',
    '',
    'Output one step per line, in exactly this format and nothing else — no numbering,',
    'no markdown:',
    'The step | the check that proves it works',
  ].join('\n');
}

/** One build step, with the check that proves it works. */
export interface MilestoneStep {
  step: string;
  /** How to know it worked. Absent when the model gave no check for this one. */
  check?: string;
}

/**
 * Parses the model's step list.
 *
 * Strips whatever numbering or bullet the model added anyway — the instruction not
 * to number them is obeyed most of the time, and a "1. " surviving into a checklist
 * that renders its own `- [ ]` looks like a mistake because it is one.
 *
 * A line with no check is kept rather than dropped: a step without its test is worth
 * less than one with it, and worth far more than nothing.
 */
export function parseMilestoneSteps(text: string): MilestoneStep[] {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^(\d+[.)]|[-*+])\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const [step, ...rest] = line.split('|').map((part) => part.trim());
      const check = rest.join(' | ').trim();
      return check ? { step, check } : { step };
    })
    .filter((parsed) => parsed.step.length > 0)
    .slice(0, MAX_STEPS);
}
