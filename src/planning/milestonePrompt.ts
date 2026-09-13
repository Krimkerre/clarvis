import { InterviewState, knownFacts } from './interviewTopics';
import { agreedResolution, FindingVerdict, rejectionNote } from './verdictSummary';

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

/** Enough to be a real milestone, few enough to be finished. */
const MIN_STEPS = 2;
const MAX_STEPS = 6;

/**
 * Enough milestones to show where the project is going, few enough to be honest.
 *
 * Past three or four, a plan written before any code exists is guessing — and a
 * guess in a checklist is indistinguishable from a decision. The later ones are
 * deliberately allowed to be coarse; they get rewritten as the earlier ones land.
 */
const MAX_MILESTONES = 4;

export function milestonePrompt(
  state: InterviewState,
  accepted: FindingVerdict[] = [],
  /**
   * Findings the user turned down. **Passed in, not filtered out — F5.** These used to be
   * dropped before this prompt was built, so the planner never learned that a decision had
   * been made and planned the rejected thing anyway.
   */
  rejected: FindingVerdict[] = []
): string {
  // The user's own wording wins for a modified finding, same rule as everywhere else.
  const findings = accepted.map(agreedResolution);
  const turnedDown = rejected.map(rejectionNote);

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
    ...(turnedDown.length > 0
      ? [
          'They were also offered these and turned them down:',
          ...turnedDown.map((note) => `- ${note}`),
          '',
          // **A rejection is a decision, and the reason is often another one.** Found
          // live: "no separate file, embed compliments in script" was given as a reason
          // for dropping a finding, and it contradicted the data answer given earlier in
          // the same interview. Planning from the interview alone produced a first step
          // that created the file they had just said not to create.
          'Do not plan any of these. Where the reason states a decision, it was made',
          'after everything above and wins over anything it contradicts — including an',
          'earlier answer in the interview.',
          '',
        ]
      : []),
    `Break the work into up to ${MAX_MILESTONES} milestones, in the order they should be built.`,
    'Milestone one is the smallest thing that runs end to end and is worth showing',
    'someone. Each one after it adds something they asked for, and each is worth',
    `stopping at. Give each ${MIN_STEPS} to ${MAX_STEPS} steps.`,
    '',
    'Only what was actually described above. Do not invent a milestone for tests,',
    'packaging, deployment or documentation unless they asked for it.',
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
    // **A check has to be able to fail.** Found by reading the code from a finished
    // project: the step "call the API and parse the response" carried the check "it
    // prints temperature, chance of rain, windspeed and direction". It printed all
    // four. The rain figure was a hard 0 every time — a fallback that never matched —
    // and the check passed five separate times, including twice against the live API,
    // because it asked whether output appeared rather than whether it was right.
    'A check that only says output appears is not a check. "It prints the temperature"',
    'is satisfied by a program that prints a constant. Say what would make the output',
    'wrong: a value that must change when the input changes, a number that must match',
    'something knowable, two runs that must differ. If the only way to fail it is a',
    'crash, it is testing that the program runs, which you already know.',
    '',
    // **A check has to be runnable where it will be run.** Found live, 13 September 2026:
    // the plan's check "logging in … shows the user's job status and photos on a web page"
    // was run by starting the server and curling it, and the build sandbox allows no
    // listening port. The run found its way to testing the handler; the plan should have
    // asked for that in the first place.
    'Checks run where nothing can listen on a port or use the network. For anything that',
    'serves requests, write the check against its handler — "a test client posting the',
    'right password gets the status page, a wrong one gets 401" — not against a running server.',
    '',
    'Output nothing but the milestones and their steps, in exactly this shape — no',
    'numbering, no markdown, no blank-line rules to interpret:',
    'MILESTONE: what this one delivers, in a few words',
    'The step | the check that proves it works',
    'The next step | its check',
    'MILESTONE: what the next one delivers',
    'Its first step | its check',
  ].join('\n');
}

/** One build step, with the check that proves it works. */
export interface MilestoneStep {
  step: string;
  /** How to know it worked. Absent when the model gave no check for this one. */
  check?: string;
}

/** One milestone: what it delivers, and the steps that get there. */
export interface Milestone {
  title: string;
  steps: MilestoneStep[];
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

/**
 * Parses the model's milestones and their steps.
 *
 * **Steps before the first `MILESTONE:` line are kept, under a milestone of their
 * own.** A model that ignores the header and returns a flat list has still done the
 * useful part of the work, and throwing that away to punish a formatting mistake
 * would leave the plan empty — which is the failure this whole section exists to
 * prevent.
 */
export function parseMilestones(text: string): Milestone[] {
  const milestones: Milestone[] = [];
  let current: Milestone | undefined;

  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^(\d+[.)]|[-*+])\s*/, '').trim();
    if (!line) continue;

    const header = /^#*\s*MILESTONE:\s*(.+)$/i.exec(line);
    if (header) {
      if (milestones.length >= MAX_MILESTONES) break;
      current = { title: header[1].trim().replace(/[*_`]/g, ''), steps: [] };
      milestones.push(current);
      continue;
    }

    if (!current) {
      current = { title: 'v1', steps: [] };
      milestones.push(current);
    }
    if (current.steps.length >= MAX_STEPS) continue;
    current.steps.push(...parseMilestoneSteps(line));
  }

  return milestones.filter((milestone) => milestone.steps.length > 0);
}

/** What a milestone planning pass came to: the milestones, and why they cannot be trusted as complete, when they cannot. */
export interface PlannedMilestones {
  milestones: Milestone[];
  /**
   * Why there are none, or why the list may be missing some (M9i): no model, a timeout, a
   * failed call, or a reply with nothing in it that could be built and checked.
   */
  problem?: string;
}

/**
 * The model's milestones as a result: the usable ones, or why there are none (M9i).
 *
 * **A refusal is not a step.** "Sorry, I cannot produce milestones for this" has no header, so
 * `parseMilestones` keeps it as the only step of a milestone called v1 — the flat-list
 * leniency doing what it was built for, on input it was never meant to see — and it was drawn
 * into the plan and offered as a build. What tells work from prose is the check: every step is
 * asked for one, and a reply in which no step carries one has nothing that could be built and
 * then shown to work. A timeout keeps what arrived, and says the list may be short.
 */
export function milestonesFrom(text: string, timedOut: boolean): PlannedMilestones {
  const milestones = parseMilestones(text);
  const usable = milestones.some((milestone) => milestone.steps.some((step) => step.check));

  if (usable) return timedOut ? { milestones, problem: 'the model ran out of time' } : { milestones };
  if (timedOut) return { milestones: [], problem: 'the model ran out of time' };
  return {
    milestones: [],
    problem: text.trim()
      ? 'the reply had no step with a check, so nothing in it could be built and checked'
      : 'the model sent back nothing',
  };
}
