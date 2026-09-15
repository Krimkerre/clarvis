import type { LeftRunTask } from '../agent/leftRuns';
import { whereWorkGoes, type LeftWorkHost, type LeftWorkWords, type Where } from './leftWork';

/**
 * **Build on Clarvis's own earlier work, or start fresh**: asked before a task of Clarvis's own engine when a run of that
 * engine left work on its branch (plan.md M15, "Build on Clarvis's own earlier work"; the owner's decision of 15 Sep
 * 2026, "Give Clarvis's own engine the same question").
 *
 * **The rules are the question's for both engines** (`leftWork.ts`). What is this engine's:
 * - the left work is its own runs, from the record in the git folder (`leftRuns.findLeftRuns`). A branch only Codex left
 *   isn't offered: that is the Codex question's, and moving a task between engines is **Clarvis: Switch Coding Engine**;
 * - **Build on** runs the new task on that branch, on top of the earlier work, and tells the model what that run was
 *   asked and said (`leftRuns.earlierWorkBrief`). There is no conversation to keep, unlike Codex;
 * - when the window is on that run's branch, the run's own uncommitted files are committed onto it first, with a line
 *   saying so (`leftRuns.earlierRunPort`);
 * - the words speak as Clarvis: "I", "my earlier work".
 *
 * vscode-free: `RunSession.whereClarvisWorks` hands in the finding, the chat's question and git.
 */

export type ClarvisWhere = Where<LeftRunTask>;

export type ClarvisLeftWorkHost = LeftWorkHost<LeftRunTask>;

export const CLARVIS_LEFT_WORK_LINES = {
  unattendedBuildOn: (branch: string) => `Unattended, so I didn't ask: I build on \`${branch}\`, the branch you're on, where my earlier work is.`,
  unattendedFresh: (startsFrom: string, offered: readonly LeftRunTask[]) =>
    `Unattended, so I didn't ask: I start fresh on a new branch from \`${startsFrom}\`. My earlier work stays on ${offered.length === 1 ? `\`${offered[0].branch}\`` : 'its branches'}.`,
} as const;

/** The line before the buttons. `found` is every left run, which can be more than the three offered. */
export function clarvisLeftWorkQuestion(offered: readonly LeftRunTask[], found: number, trunk: string, startsFrom: string): string {
  const choice = `Build on it, and this task runs on that branch, on top of that work, or start fresh on a new branch from \`${startsFrom}\`.`;
  if (found === 1) return `My earlier work is still on \`${offered[0].branch}\`, not merged into \`${trunk}\`. ${choice}`;
  const shown = found > offered.length ? ` The ${offered.length} most recent are below.` : '';
  return `I left earlier work on ${found} branches that aren't merged into \`${trunk}\`.${shown} ${choice.replace('Build on it', 'Build on one')}`;
}

export const CLARVIS_LEFT_WORK_WORDS: LeftWorkWords<LeftRunTask> = {
  logPrefix: 'left work',
  subject: 'I',
  question: clarvisLeftWorkQuestion,
  buildOnDetail: (task) => `${task.onBranch ? "The branch you're on" : 'Switches to that branch'}. This task goes on top of the earlier work`,
  startFreshDetail: (startsFrom) => `A new branch from ${startsFrom}. The earlier work stays where it is`,
  unattendedBuildOn: CLARVIS_LEFT_WORK_LINES.unattendedBuildOn,
  unattendedFresh: CLARVIS_LEFT_WORK_LINES.unattendedFresh,
  named: (task) => task.branch,
};

/** Where a task of Clarvis's own engine goes: asked, picked for Unattended, or fresh as today when nothing was left. */
export function whereClarvisWorks(host: ClarvisLeftWorkHost): Promise<ClarvisWhere> {
  return whereWorkGoes(host, CLARVIS_LEFT_WORK_WORDS);
}
