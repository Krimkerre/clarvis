import * as vscode from 'vscode';
import { MilestoneState, milestoneSteps, nextMilestone, planTitle, readMilestones } from './planUpdate';

/**
 * The milestone this workspace is part-way through, if there is one.
 *
 * **Read from `plan.md` every time, never remembered.** The plan outlives the window,
 * the session and the machine; the user may have ticked something off by hand since,
 * which is their document's prerogative. Anything held in memory would be a second,
 * quieter source of truth that disagrees with the file the moment either changes.
 */
export interface PendingBuild {
  milestone: MilestoneState;
  projectName: string;
  steps: string[];
  /** Every milestone in the plan, so a task can say which of them this is. */
  milestones: MilestoneState[];
  /**
   * Whether anything in this plan has been built already.
   *
   * Not the same question as "is this milestone part-way through", and conflating the
   * two is what left a finished milestone 3 looking like an untouched project.
   */
  started: boolean;
}

export async function pendingBuild(): Promise<PendingBuild | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;

  const planText = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'plan.md')).then(
    (bytes) => Buffer.from(bytes).toString('utf8'),
    () => undefined
  );
  if (!planText) return undefined;

  const milestone = nextMilestone(planText);
  if (!milestone) return undefined;

  const milestones = readMilestones(planText);

  return {
    milestone,
    milestones,
    projectName: planTitle(planText),
    steps: milestoneSteps(planText, milestone.number),
    started: milestones.some((entry) => entry.done > 0),
  };
}

/**
 * The same, but only when this project has actually been built in.
 *
 * A freshly approved plan with nothing ticked anywhere is not work in progress, and
 * offering to continue it every time the window opens is the nagging §6 exists to
 * prevent.
 *
 * **The test used to be `milestone.done > 0` — progress inside the *next* milestone —
 * and that is a different question.** Found live: milestones 1 to 3 finished, milestone
 * 4 untouched, and reopening the window offered nothing at all; the build had to be
 * restarted by hand with "start milestone 3 from plan.md". Finishing a milestone is the
 * single most likely moment to close a window, and it was the one moment this could not
 * see. Any progress anywhere in the plan means someone is building this.
 */
export async function interruptedBuild(): Promise<PendingBuild | undefined> {
  const pending = await pendingBuild();
  return pending?.started ? pending : undefined;
}
