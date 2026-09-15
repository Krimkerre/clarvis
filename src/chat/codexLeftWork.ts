import { buildOnRefusal, offeredTasks, type LeftTask, type LeftWork } from '../engine/codex/leftTasks';
import { offerAnswer } from './offerAnswer';

/**
 * **Build on Codex's earlier work, or start fresh**: asked before a Codex task when earlier Codex work was left on its
 * branch (plan.md M15, "Build on Codex's earlier work"; the owner's decision of 15 Sep 2026, "Ask each time").
 *
 * **What happened without it.** Found live on 15 Sep 2026: Codex built a greeter on its own branch, the owner answered
 * "Leave it there", and the follow-up ("Also add a --shout option…") started a new Codex task on a new branch from
 * `master`. Codex never saw its own greeter and wrote a second one beside it, and one more idle task was left in RAVIS.
 *
 * **The rules, as the owner set them:**
 * - asked only for a Codex task, and only when `leftTasks.findLeftWork` finds work left on a branch that still exists,
 *   isn't merged, and whose idle task Clarvis holds a key to that RAVIS accepts;
 * - **Build on `<branch>`** for at most three of them: the one the window is on first, then the most recent. Then
 *   **Start fresh from `<branch>`**, naming the branch a fresh task really starts from, never a literal `main`;
 * - typing works like the buttons. "build on it", "continue" or "that branch" build on the first one listed; "fresh",
 *   "start fresh" or "new branch" start fresh. A typed answer is never a task for Codex. Anything else typed is the
 *   message it is, and the question goes away;
 * - unanswered, stopped, or dropped by a mode switch: nothing runs;
 * - in Unattended nothing is asked. Codex builds on the branch the window is on when that is left Codex work, and
 *   otherwise starts fresh, with one line saying which;
 * - building on a branch the window isn't on is refused, in plain words, while the owner has uncommitted changes the
 *   switch would carry along (`leftTasks.buildOnRefusal`).
 *
 * vscode-free: `RunSession.whereCodexWorks` hands in the finding, the chat's question and the checkout's changes.
 */

/** What the Codex task does: start fresh as it always has, build on an earlier task, or nothing at all. */
export type CodexWhere = { kind: 'fresh' } | { kind: 'build_on'; task: LeftTask } | { kind: 'nothing' };

const FRESH: CodexWhere = { kind: 'fresh' };
const NOTHING: CodexWhere = { kind: 'nothing' };

export function buildOnLabel(branch: string): string {
  return `Build on ${branch}`;
}

export function startFreshLabel(branch: string): string {
  return `Start fresh from ${branch}`;
}

/** The buttons: one **Build on** per offered task, then **Start fresh**. */
export function leftWorkChoices(offered: readonly LeftTask[], startsFrom: string): { label: string; detail: string }[] {
  const buildOn = offered.map((task) => ({
    label: buildOnLabel(task.branch),
    detail: `${task.onBranch ? "The branch you're on" : 'Switches to that branch'}. Codex adds to its earlier work and keeps that conversation`,
  }));
  return [...buildOn, { label: startFreshLabel(startsFrom), detail: `A new Codex task on a new branch from ${startsFrom}. The earlier work stays where it is` }];
}

/** The line before the buttons. `found` is every left task, which can be more than the three offered. */
export function leftWorkQuestion(offered: readonly LeftTask[], found: number, trunk: string, startsFrom: string): string {
  const choice = `Build on it, and Codex adds to that work and keeps its earlier conversation, or start fresh on a new branch from \`${startsFrom}\`.`;
  if (found === 1) return `Codex's earlier work is still on \`${offered[0].branch}\`, not merged into \`${trunk}\`. ${choice}`;
  const shown = found > offered.length ? ` The ${offered.length} most recent are below.` : '';
  return `Codex left earlier work on ${found} branches that aren't merged into \`${trunk}\`.${shown} ${choice.replace('Build on it', 'Build on one')}`;
}

export const LEFT_WORK_LINES = {
  unattendedBuildOn: (branch: string) => `Unattended, so I didn't ask: Codex builds on \`${branch}\`, the branch you're on, where its earlier work is.`,
  unattendedFresh: (startsFrom: string, offered: readonly LeftTask[]) =>
    `Unattended, so I didn't ask: Codex starts fresh on a new branch from \`${startsFrom}\`. Its earlier work stays on ${offered.length === 1 ? `\`${offered[0].branch}\`` : 'its branches'}.`,
} as const;

/**
 * Words that mean one of the two ways, anchored to the start by `offerAnswer`: "build on it" builds on, "build on it
 * later?" is a question and not an answer.
 */
const BUILD_ON_WORDS = ['build on( it| that| this| (it|that|this|the) branch)?', 'continue( on( it| that| there)?| there| it| that)?', '(on |use )?(that|this|the same) branch'];
const FRESH_WORDS = ['(start )?fresh', 'start (a )?(fresh|new)( one| task)?', 'start over', '(a |on a )?new branch'];

/**
 * The longest a typed answer may be. The words aren't passed to Codex, so a sentence that happens to start with
 * "continue" has to stay the message it is rather than be swallowed as an answer.
 */
const MOST_WORDS = 5;

/** The button a typed answer means, or undefined when it isn't an answer to this question. */
export function leftWorkChoice(typed: string, offered: readonly LeftTask[], startsFrom: string): string | undefined {
  if (saysOnly(typed, FRESH_WORDS)) return startFreshLabel(startsFrom);
  if (saysOnly(typed, BUILD_ON_WORDS) && offered.length > 0) return buildOnLabel(offered[0].branch);
  return undefined;
}

/**
 * The question's own words, short. Not the shared yes: "ok" or "do it" doesn't say which of the two ways, so it is left
 * to be read as a message.
 */
function saysOnly(typed: string, words: readonly string[]): boolean {
  const short = typed.trim().split(/\s+/).length <= MOST_WORDS;
  return short && offerAnswer(typed, words) === 'yes' && offerAnswer(typed) !== 'yes';
}

export interface LeftWorkHost {
  /** The left Codex work in this folder (`leftTasks.findLeftWork`). */
  find(): Promise<LeftWork>;
  /** The chat is in Unattended now: nothing is asked. */
  unattended(): boolean;
  /** Shows the buttons and waits: the label chosen or typed, or undefined when unanswered, stopped or dropped. */
  ask(choices: { label: string; detail?: string }[], accepts: (typed: string) => string | undefined): Promise<string | undefined>;
  /** Writes a line in the chat. */
  note(line: string): Promise<void>;
  /** The checkout's modified, staged and untracked files, read only when building on another branch. */
  dirty(): Promise<string[]>;
  log(line: string): void;
}

/** Where a Codex task goes: asked, picked for Unattended, or fresh as today when there is nothing to build on. */
export async function whereCodexWorks(host: LeftWorkHost): Promise<CodexWhere> {
  const found = await host.find();
  const offered = offeredTasks(found.tasks);
  if (offered.length === 0 || !found.startsFrom || !found.trunk) return FRESH;
  const picked = host.unattended()
    ? await unattendedPick(host, offered, found.startsFrom)
    : await asked(host, offered, found.tasks.length, { trunk: found.trunk, startsFrom: found.startsFrom });
  return picked.kind === 'build_on' ? switchChecked(host, picked.task, found.headBranch) : picked;
}

/** Unattended answers questions itself: the branch the window is on when that is left work, otherwise fresh. */
async function unattendedPick(host: LeftWorkHost, offered: readonly LeftTask[], startsFrom: string): Promise<CodexWhere> {
  const here = offered.find((task) => task.onBranch);
  await host.note(here ? LEFT_WORK_LINES.unattendedBuildOn(here.branch) : LEFT_WORK_LINES.unattendedFresh(startsFrom, offered));
  host.log(`codex left work: Unattended, ${here ? `building on ${here.branch} (${here.sessionId})` : 'starting fresh'} without asking`);
  return here ? { kind: 'build_on', task: here } : FRESH;
}

async function asked(host: LeftWorkHost, offered: readonly LeftTask[], found: number, names: { trunk: string; startsFrom: string }): Promise<CodexWhere> {
  await host.note(leftWorkQuestion(offered, found, names.trunk, names.startsFrom));
  const answer = await host.ask(leftWorkChoices(offered, names.startsFrom), (typed) => leftWorkChoice(typed, offered, names.startsFrom));
  if (answer === startFreshLabel(names.startsFrom)) {
    host.log(`codex left work: start fresh from ${names.startsFrom}, the earlier tasks left idle`);
    return FRESH;
  }
  const task = offered.find((candidate) => buildOnLabel(candidate.branch) === answer);
  if (!task) {
    host.log('codex left work: the question went unanswered, was stopped or was dropped, so nothing runs');
    return NOTHING;
  }
  host.log(`codex left work: building on ${task.branch} (${task.sessionId})`);
  return { kind: 'build_on', task };
}

/** Building on another branch, refused while the owner has uncommitted work the switch would carry along. */
async function switchChecked(host: LeftWorkHost, task: LeftTask, headBranch: string | undefined): Promise<CodexWhere> {
  const refusal = buildOnRefusal(headBranch, task.branch, task.onBranch ? [] : await host.dirty());
  if (!refusal) return { kind: 'build_on', task };
  host.log(`codex left work: not switching to ${task.branch}, the checkout has uncommitted changes`);
  await host.note(refusal);
  return NOTHING;
}
