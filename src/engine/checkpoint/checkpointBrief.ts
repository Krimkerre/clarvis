/**
 * What the next engine is told about a task it is carrying on (plan.md M15, C3; design §6.2).
 *
 * **Two shapes, for two starts.**
 * - `renderCheckpoint` goes after the task's own brief when an engine starts on it fresh: Clarvis's own engine
 *   after a switch from Codex, or a new Codex session that can't resume its old thread.
 * - `catchUpText` is the design's catch-up, for a Codex thread that already knows the task and only needs to
 *   hear what happened while it was stopped: the idle session's `catch_up` turn, or a resumed thread.
 *
 * **Uncertain operations are never an instruction.** What was under way when the task stopped — a command that
 * was cut off, a file change nobody saw finish — appears only under "check before repeating", and never as a
 * step or the next action. Nothing here, or anywhere in the switch, runs it again (design §6.4).
 *
 * **What the owner said comes with it.** Every note not yet delivered is in both shapes, marked as taking
 * priority, and is marked delivered only once the next engine has started with it (review H8).
 *
 * **Questions are not answered for anyone.** An approval or question that was open is listed as unanswered;
 * the next engine asks again if it still needs to.
 *
 * Pure.
 */

import type { CheckRecord, DiffStat, TaskCheckpoint } from './taskCheckpoint';
import { undeliveredFeedback } from './taskCheckpoint';

const ENGINE_NAMES = { clarvis: "Clarvis's own engine", codex: 'Codex' } as const;

export const UNCERTAIN_HEADING = 'Not done, or not known to be done — check before repeating any of it, and never repeat it blindly:';
export const FEEDBACK_HEADING = 'What the owner said meanwhile, not yet acted on (it takes priority over the plan):';

/** The part of a fresh brief that carries the checkpoint. */
export function renderCheckpoint(checkpoint: TaskCheckpoint): string {
  const sections = [
    carryingOn(checkpoint),
    whereItGot(checkpoint),
    listed('Steps not done yet:', checkpoint.plan.uncheckedSteps),
    listed('Checks this work must pass:', checkpoint.requirements.checks),
    listed('Not part of this task:', checkpoint.requirements.exclusions),
    listed('Already considered and turned down — do not bring these back:', checkpoint.requirements.rejected),
    listed('Files changed so far:', changedLines(checkpoint)),
    listed('Checks already run:', checkpoint.checks.map(checkLine)),
    listed(FEEDBACK_HEADING, undeliveredFeedback(checkpoint)),
    listed(
      'Questions asked before the switch and never answered (nothing was answered for you; ask again if you still need to):',
      checkpoint.unresolvedQuestions.map((question) => question.summary)
    ),
    listed(UNCERTAIN_HEADING, uncertainLines(checkpoint)),
    'Re-read any file before you edit it: the other engine may have changed it.',
  ];
  return sections.filter((section): section is string => section !== undefined).join('\n\n');
}

/** The design's catch-up for a Codex thread that was stopped while another engine worked (design §6.2 step 6). */
export function catchUpText(checkpoint: TaskCheckpoint, now: { headCommit: string; diffStat: DiffStat[] }): string {
  const since = checkpoint.codexSession?.sawHeadCommit;
  const changes = since ? `Changes since commit ${short(since)} (now ${short(now.headCommit)})` : `Changes on the task's branch (now ${short(now.headCommit)})`;
  return [
    'While you were stopped, another engine worked on this project.',
    `${changes}: ${orNone(now.diffStat.map(diffLine), 'none')}.`,
    `Checks: ${orNone(checkpoint.checks.map(checkLine), 'none run')}.`,
    `Not done and uncertain: ${orNone(uncertainLines(checkpoint), 'nothing')} — check before repeating.`,
    `Open questions: ${orNone(checkpoint.unresolvedQuestions.map((question) => question.summary), 'none')}.`,
    `What the user said meanwhile: ${orNone(undeliveredFeedback(checkpoint), 'nothing')}.`,
    'Re-read any file before editing it.',
  ].join(' ');
}

function carryingOn(checkpoint: TaskCheckpoint): string {
  const who = ENGINE_NAMES[checkpoint.engine];
  const { branch, headCommit } = checkpoint.git;
  const where = branch && headCommit ? ` Its work so far is committed on \`${branch}\` at ${short(headCommit)}; carry on there.` : ' Its work so far is in the project.';
  return `You are carrying on a task that ${who} started in this project.${where}`;
}

function whereItGot(checkpoint: TaskCheckpoint): string | undefined {
  const { milestone, nextAction } = checkpoint.plan;
  const at = milestone ? `Where it got to: milestone ${milestone.index}, "${milestone.title}".` : '';
  const next = nextAction ? ` Next: ${nextAction}` : '';
  return at || next ? `${at}${next}`.trim() : undefined;
}

function listed(heading: string, items: readonly string[]): string | undefined {
  return items.length === 0 ? undefined : [heading, ...items.map((item) => `- ${item}`)].join('\n');
}

function changedLines(checkpoint: TaskCheckpoint): string[] {
  const stats = new Map(checkpoint.git.diffStat.map((stat) => [stat.path, stat]));
  return checkpoint.changedFiles.map((file) => {
    const stat = stats.get(file);
    return stat ? diffLine(stat) : file;
  });
}

function diffLine(stat: DiffStat): string {
  return `${stat.path} (+${stat.added} −${stat.removed})`;
}

function checkLine(check: CheckRecord): string {
  const ended = check.exitCode === null ? 'ended without an exit code' : check.exitCode === 0 ? 'passed' : `failed (exit ${check.exitCode})`;
  return `\`${check.command}\` ${ended}`;
}

function uncertainLines(checkpoint: TaskCheckpoint): string[] {
  return checkpoint.uncertainOperations.map((operation) => `${operation.kind === 'command' ? 'command' : 'file change'}: ${operation.summary} (${operation.state === 'failed' ? 'failed' : 'may or may not have happened'})`);
}

function orNone(items: readonly string[], none: string): string {
  return items.length === 0 ? none : items.join('; ');
}

function short(commit: string): string {
  return commit.slice(0, 7);
}
