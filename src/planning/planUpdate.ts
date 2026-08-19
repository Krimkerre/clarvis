import { MilestoneStep } from './milestonePrompt';
/**
 * Writing a finished milestone back into `plan.md`.
 *
 * §0's Code Mode rule says the plan becomes a live checklist and each step is ticked
 * as it completes — which had never actually been implemented, so a plan approved on
 * Monday still read as entirely unbuilt on Friday. This is the part that does it.
 *
 * Pure and `vscode`-free, and deliberately so: it edits a document the user owns and
 * may have hand-edited since, so every rule about what it will and will not touch is
 * worth being able to test without an extension host.
 */

/** What happened when one step's check was run. */
export interface StepResult {
  /** The step text, as it appears in the plan. Matched loosely — see `markSteps`. */
  step: string;
  done: boolean;
  /** What the check actually printed or did. Absent when it was never run. */
  result?: string;
}

/** A step line in the plan: `- [ ] text` or `- [x] text`, at any indent. */
const STEP_LINE = /^(\s*)- \[([ xX])\] (.+)$/;

/** The result line that lives under a step, written unrun when the plan is drafted. */
const RESULT_LINE = /^\s*- Result:/;

/**
 * Loose enough to survive the model rewording a step slightly, strict enough not to
 * tick the wrong one: punctuation and case are ignored, everything else must match.
 * An exact-match rule ticked nothing at all the moment a step was reworded, and a
 * fuzzy one would tick a neighbouring step, which is worse than ticking none.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a line belongs to the step above it, by indent alone. */
function isSubLineOf(line: string, stepIndent: string): boolean {
  const indent = /^(\s*)/.exec(line)?.[1] ?? '';
  return line.trim().length > 0 && indent.length > stepIndent.length;
}

/**
 * Ticks the steps that are done and records what their checks produced.
 *
 * **Only steps it was told about, and only inside the checklist.** A step already
 * ticked stays ticked — re-running a milestone must not unmark work that was
 * finished — and anything the results do not mention is left exactly as it was,
 * including the user's own edits.
 */
export function markSteps(planText: string, results: StepResult[]): string {
  const lines = planText.split('\n');
  const output: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = STEP_LINE.exec(line);

    if (!match) {
      output.push(line);
      continue;
    }

    const [, indent, mark, text] = match;
    const result = results.find((candidate) => normalise(candidate.step) === normalise(text));

    if (!result) {
      output.push(line);
      continue;
    }

    // Already ticked stays ticked: a second run over the same milestone reports on
    // work that was finished the first time, and unticking it would be a lie.
    const ticked = mark.toLowerCase() === 'x' || result.done;
    output.push(`${indent}- [${ticked ? 'x' : ' '}] ${text}`);

    if (!result.result) continue;

    // **The result line is not the next line.** It sits below the check, which is
    // written between them — inserting directly under the step left "not run yet"
    // stranded beneath the answer that replaced it. Caught by its own test.
    //
    // So the step's sub-lines are walked through: anything indented past the step
    // belongs to it, the check passes through untouched, and the reserved result line
    // is the one that gets written over. A step whose result line was deleted by hand
    // gets a fresh one at the end of its block rather than nothing.
    let wrote = false;
    while (index + 1 < lines.length && isSubLineOf(lines[index + 1], indent)) {
      index++;
      if (RESULT_LINE.test(lines[index])) {
        output.push(`${indent}  - Result: ${result.result}`);
        wrote = true;
      } else {
        output.push(lines[index]);
      }
    }
    if (!wrote) output.push(`${indent}  - Result: ${result.result}`);
  }

  return output.join('\n');
}

/** A milestone heading in a rendered plan: `### Milestone 2 — Batch renaming`. */
const MILESTONE_HEADING = /^#{2,4}\s*Milestone\s+(\d+)\s*[—:-]\s*(.+)$/i;

/** What a plan says about one milestone's progress. */
export interface MilestoneState {
  number: number;
  title: string;
  done: number;
  total: number;
}

/**
 * Reads each milestone's progress straight out of the plan.
 *
 * **The plan is the source of truth, not memory.** A build resumed a week later, in a
 * new window, has no state to consult but the file — and the user may have ticked
 * something off by hand in the meantime, which is their document's prerogative.
 */
export function readMilestones(planText: string): MilestoneState[] {
  const milestones: MilestoneState[] = [];
  let current: MilestoneState | undefined;

  for (const line of planText.split('\n')) {
    const heading = MILESTONE_HEADING.exec(line.trim());
    if (heading) {
      current = { number: Number(heading[1]), title: heading[2].trim(), done: 0, total: 0 };
      milestones.push(current);
      continue;
    }

    const step = STEP_LINE.exec(line);
    if (!step || !current) continue;

    current.total++;
    if (step[2].toLowerCase() === 'x') current.done++;
  }

  return milestones;
}

/**
 * The step texts under one milestone, for the progress display.
 *
 * Every step, not only the unticked ones: "step 3 of 5" means the third of five, and
 * renumbering as work completes would make the bar march backwards.
 */
export function milestoneSteps(planText: string, number: number): string[] {
  const steps: string[] = [];
  let inside = false;

  for (const line of planText.split('\n')) {
    const heading = MILESTONE_HEADING.exec(line.trim());
    if (heading) {
      inside = Number(heading[1]) === number;
      continue;
    }

    const step = STEP_LINE.exec(line);
    if (inside && step) steps.push(step[3]);
  }

  return steps;
}

/** The first milestone with work left in it, or `undefined` when the plan is finished. */
export function nextMilestone(planText: string): MilestoneState | undefined {
  return readMilestones(planText).find((milestone) => milestone.done < milestone.total);
}

/**
 * Adds steps to a milestone that already exists in the plan.
 *
 * **Appended to the end of that milestone's list, never woven in.** Where new work
 * belongs among existing steps is a judgement about the project; guessing at it
 * would reorder a plan the user approved. Added at the end, in the order they were
 * agreed, it stays obvious what was there before and what arrived later.
 */
export function addSteps(planText: string, number: number, steps: readonly MilestoneStep[]): string {
  if (steps.length === 0) return planText;

  const lines = planText.split('\n');
  const output: string[] = [];
  let inside = false;
  let lastStepLine = -1;

  for (const line of lines) {
    if (MILESTONE_HEADING.exec(line.trim())) {
      // Leaving the milestone we were adding to: everything is already emitted, so
      // the new steps go in before this heading.
      if (inside && lastStepLine !== -1) {
        output.splice(lastStepLine + 1, 0, ...renderSteps(steps));
        lastStepLine = -1;
      }
      inside = Number(MILESTONE_HEADING.exec(line.trim())![1]) === number;
      output.push(line);
      continue;
    }

    output.push(line);
    // The last line belonging to this milestone's checklist, so trailing prose and
    // blank lines stay below the steps rather than above them.
    if (inside && (STEP_LINE.test(line) || isSubLineOf(line, ''))) lastStepLine = output.length - 1;
  }

  if (inside && lastStepLine !== -1) output.splice(lastStepLine + 1, 0, ...renderSteps(steps));

  return output.join('\n');
}

/**
 * A new milestone at the end of the plan.
 *
 * Numbered one past the highest already there — the numbering is what
 * `readMilestones` reads back to decide what comes next, so a duplicate would send
 * the build to the wrong place.
 */
export function appendMilestone(planText: string, title: string, steps: readonly MilestoneStep[]): string {
  if (steps.length === 0) return planText;

  const existing = readMilestones(planText);
  const number = existing.length > 0 ? Math.max(...existing.map((milestone) => milestone.number)) + 1 : 1;
  const lines = planText.split('\n');

  // Inserted after the last milestone's steps rather than at the end of the file,
  // which is where Decisions, Open Questions and Branch flow live.
  let insertAt = lines.length;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (STEP_LINE.test(lines[index]) || isSubLineOf(lines[index], '')) {
      insertAt = index + 1;
      break;
    }
  }

  lines.splice(insertAt, 0, '', `### Milestone ${number} — ${title}`, '', ...renderSteps(steps));
  return lines.join('\n');
}

function renderSteps(steps: readonly MilestoneStep[]): string[] {
  return steps.flatMap((step) => [
    `- [ ] ${step.step}`,
    ...(step.check ? [`  - Check: ${step.check}`, '  - Result: not run yet'] : []),
  ]);
}

/**
 * Whether every step in the plan is ticked — the whole plan, not one milestone.
 *
 * Kept for the "and that is the lot" case; `nextMilestone` is what decides whether
 * there is somewhere to go next.
 */
export function milestoneComplete(planText: string): boolean {
  const steps = planText.split('\n').map((line) => STEP_LINE.exec(line)).filter(Boolean);
  return steps.length > 0 && steps.every((match) => match![2].toLowerCase() === 'x');
}

/**
 * What to say when a run finishes, given whether there is a plan to record it in.
 *
 * **A run started from `NO-PLAN-NEEDED` has no plan.** That branch fired for the first
 * time on 19 Aug and the end of the run still asked *"shall I mark off what's done in
 * plan.md and record what the checks produced?"* — about a file the same conversation had
 * just decided not to write. Accepting did nothing at all: `recordMilestone` finds no plan
 * and returns. M8d's checklist already names this defect in another place, and the words
 * fit here exactly: **no button that would just fail.**
 *
 * The wording changes too, not only the buttons. "Milestone finished" is a claim about a
 * plan with milestones in it; a run with no plan behind it finished a task.
 */
export function milestoneSettledOffer(
  hasPlan: boolean,
  changed: number
): { message: string; actions: string[] } {
  const files = `${changed} file${changed === 1 ? '' : 's'} changed`;

  return hasPlan
    ? { message: `Milestone finished — ${files}.`, actions: ['Update the plan', 'Leave it'] }
    : { message: `Done — ${files}.`, actions: ['Right you are'] };
}

/** The question under it, when there is a plan worth offering to update. */
export function milestoneSettledDetail(hasPlan: boolean, summary: string): string {
  return hasPlan
    ? `${summary}\n\nShall I mark off what's done in plan.md and record what the checks produced?`
    : summary;
}
