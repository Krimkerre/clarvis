import * as vscode from 'vscode';
import { MilestoneState, milestoneSteps, nextMilestone } from './planUpdate';

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

  return {
    milestone,
    // The plan's own title, which is the project name planning chose.
    projectName: /^#\s+(.+)$/m.exec(planText)?.[1]?.trim() ?? 'this project',
    steps: milestoneSteps(planText, milestone.number),
  };
}

/**
 * The same, but only when work has actually started.
 *
 * A freshly approved plan with nothing ticked is not an interrupted build, and
 * offering to continue it every time the window opens is the nagging §6 exists to
 * prevent. Some progress and something left is the narrow case that honestly means
 * "you were in the middle of this".
 */
export async function interruptedBuild(): Promise<PendingBuild | undefined> {
  const pending = await pendingBuild();
  return pending && pending.milestone.done > 0 ? pending : undefined;
}
