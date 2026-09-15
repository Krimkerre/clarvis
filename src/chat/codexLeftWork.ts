import type { LeftTask } from '../engine/codex/leftTasks';
import { leftWorkChoicesFor, whereWorkGoes, type LeftWorkHost as SharedHost, type LeftWorkWords, type Where } from './leftWork';

export { buildOnLabel, leftWorkChoice, startFreshLabel } from './leftWork';

/**
 * **Build on Codex's earlier work, or start fresh**: asked before a Codex task when earlier Codex work was left on its
 * branch (plan.md M15, "Build on Codex's earlier work"; the owner's decision of 15 Sep 2026, "Ask each time").
 *
 * **What happened without it.** Found live on 15 Sep 2026: Codex built a greeter on its own branch, the owner answered
 * "Leave it there", and the follow-up ("Also add a --shout option…") started a new Codex task on a new branch from
 * `master`. Codex never saw its own greeter and wrote a second one beside it, and one more idle task was left in RAVIS.
 *
 * **The rules are the question's for both engines** (`leftWork.ts`): at most three **Build on**, the window's branch
 * first; typed answers; nothing runs when unanswered; Unattended's pick; the switch check. What is Codex's here:
 * - the left work is idle Codex tasks, found through RAVIS (`leftTasks.findLeftWork`);
 * - the words. **Build on** picks that Codex task back up, so Codex adds to its work and keeps its earlier conversation
 *   (`CodexRunCore.buildOn`).
 *
 * vscode-free: `RunSession.whereCodexWorks` hands in the finding, the chat's question and git.
 */

/** What the Codex task does: start fresh as it always has, build on an earlier task, or nothing at all. */
export type CodexWhere = Where<LeftTask>;

export type LeftWorkHost = SharedHost<LeftTask>;

export const LEFT_WORK_LINES = {
  unattendedBuildOn: (branch: string) => `Unattended, so I didn't ask: Codex builds on \`${branch}\`, the branch you're on, where its earlier work is.`,
  unattendedFresh: (startsFrom: string, offered: readonly LeftTask[]) =>
    `Unattended, so I didn't ask: Codex starts fresh on a new branch from \`${startsFrom}\`. Its earlier work stays on ${offered.length === 1 ? `\`${offered[0].branch}\`` : 'its branches'}.`,
} as const;

/** The line before the buttons. `found` is every left task, which can be more than the three offered. */
export function leftWorkQuestion(offered: readonly LeftTask[], found: number, trunk: string, startsFrom: string): string {
  const choice = `Build on it, and Codex adds to that work and keeps its earlier conversation, or start fresh on a new branch from \`${startsFrom}\`.`;
  if (found === 1) return `Codex's earlier work is still on \`${offered[0].branch}\`, not merged into \`${trunk}\`. ${choice}`;
  const shown = found > offered.length ? ` The ${offered.length} most recent are below.` : '';
  return `Codex left earlier work on ${found} branches that aren't merged into \`${trunk}\`.${shown} ${choice.replace('Build on it', 'Build on one')}`;
}

export const CODEX_LEFT_WORK_WORDS: LeftWorkWords<LeftTask> = {
  logPrefix: 'codex left work',
  subject: 'Codex',
  question: leftWorkQuestion,
  buildOnDetail: (task) => `${task.onBranch ? "The branch you're on" : 'Switches to that branch'}. Codex adds to its earlier work and keeps that conversation`,
  startFreshDetail: (startsFrom) => `A new Codex task on a new branch from ${startsFrom}. The earlier work stays where it is`,
  unattendedBuildOn: LEFT_WORK_LINES.unattendedBuildOn,
  unattendedFresh: LEFT_WORK_LINES.unattendedFresh,
  named: (task) => `${task.branch} (${task.sessionId})`,
};

/** The buttons: one **Build on** per offered task, then **Start fresh**. */
export function leftWorkChoices(offered: readonly LeftTask[], startsFrom: string): { label: string; detail: string }[] {
  return leftWorkChoicesFor(CODEX_LEFT_WORK_WORDS, offered, startsFrom);
}

/** Where a Codex task goes: asked, picked for Unattended, or fresh as today when there is nothing to build on. */
export function whereCodexWorks(host: LeftWorkHost): Promise<CodexWhere> {
  return whereWorkGoes(host, CODEX_LEFT_WORK_WORDS);
}
