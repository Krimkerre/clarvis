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

/** Whether every step in the plan is ticked — the milestone is genuinely finished. */
export function milestoneComplete(planText: string): boolean {
  const steps = planText.split('\n').map((line) => STEP_LINE.exec(line)).filter(Boolean);
  return steps.length > 0 && steps.every((match) => match![2].toLowerCase() === 'x');
}
