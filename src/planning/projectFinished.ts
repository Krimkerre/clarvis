import { MilestoneState, readMilestones } from './planUpdate';

/**
 * Noticing that a project is finished, and saying so.
 *
 * **Nothing said this out loud.** The last milestone ticked produced "plan.md updated —
 * every milestone in the plan is now ticked off" in a *notification*, which is where
 * things go to be missed, and then silence. Found live at the end of project 2, where
 * the closing line was instead "Milestone 5, if there is one, is a separate
 * conversation" — a finished project described as an open question.
 *
 * A build that cannot tell you it is done is a build you have to check on, and checking
 * on it is the work this was supposed to remove.
 *
 * Pure: it reads a plan and returns what to say about it.
 */

export interface FinishedProject {
  name: string;
  milestones: MilestoneState[];
  steps: number;
}

/**
 * The project, if every step of every milestone is ticked. Otherwise `undefined`.
 *
 * A plan with no milestones at all is not a finished project — it is an empty
 * document, and congratulating someone on it would be the kind of false claim §2.2
 * exists to prevent.
 */
export function finishedProject(planText: string): FinishedProject | undefined {
  const milestones = readMilestones(planText);
  if (milestones.length === 0) return undefined;

  const steps = milestones.reduce((sum, entry) => sum + entry.total, 0);
  if (steps === 0) return undefined;
  if (!milestones.every((entry) => entry.done === entry.total)) return undefined;

  return {
    name: /^#\s+(.+)$/m.exec(planText)?.[1]?.trim() ?? 'this project',
    milestones,
    steps,
  };
}

/**
 * What he says when the last step is ticked.
 *
 * A list rather than a paragraph, and the milestones by name: "it is done" is worth
 * very little on its own, and the useful part is *what* is done, which is the thing
 * they can now go and use.
 *
 * No congratulation and no exclamation mark — §2 rule 1. The facts are the point, and
 * the aside afterwards is written separately, by the model, as it is everywhere else.
 */
export function finishedLines(project: FinishedProject): string[] {
  return [
    `${project.name} is finished — every milestone in the plan is ticked off.`,
    '',
    ...project.milestones.map((entry) => `${entry.number}. ${entry.title} (${entry.total} step${entry.total === 1 ? '' : 's'})`),
    '',
    `${project.milestones.length} milestones, ${project.steps} steps, all checked against their own tests.`,
    'The plan has the results next to each step if you want to see what was actually run.',
  ];
}
