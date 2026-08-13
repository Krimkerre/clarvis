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
    'Stay inside what was described above: no tests, no packaging, no CI unless they',
    'were actually asked for.',
    '',
    'Output the steps alone, one per line, no numbering and no markdown.',
  ].join('\n');
}

/**
 * Parses the model's step list.
 *
 * Strips whatever numbering or bullet the model added anyway — the instruction not
 * to number them is obeyed most of the time, and a "1. " surviving into a checklist
 * that renders its own `- [ ]` looks like a mistake because it is one.
 */
export function parseMilestoneSteps(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^(\d+[.)]|[-*+])\s*/, '').trim())
    .filter(Boolean)
    .slice(0, MAX_STEPS);
}
