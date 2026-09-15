import {
  carriedLine,
  carriedNames,
  moveFor,
  offeredTasks,
  switchRefusal,
  switchRefusalLine,
  unreadableTreeLine,
  type LeftBranch,
  type LeftWorkFound,
  type Move,
} from '../agent/leftBranches';
import type { WorkingTree } from '../engine/checkpoint/gitFacts';
import { offerAnswer } from './offerAnswer';

/**
 * **Build on earlier work, or start fresh**: the question asked before a coding task when the engine that will do it left
 * earlier work on its branch (plan.md M15: "Build on Codex's earlier work", and "Build on Clarvis's own earlier work"; the
 * owner's decisions of 15 Sep 2026, "Ask each time" and "Give Clarvis's own engine the same question").
 *
 * **One question for both engines**, so their rules can't drift apart. The words are each engine's own
 * (`codexLeftWork.ts`, `clarvisLeftWork.ts`); everything else is here:
 * - asked only when the engine's own finder has work to offer: `leftTasks.findLeftWork` for Codex, and
 *   `leftRuns.findLeftRuns` for Clarvis's own engine. A branch only the other engine left isn't offered. Moving a task
 *   between engines is **Clarvis: Switch Coding Engine**;
 * - **Build on `<branch>`** for at most three, the branch the window is on first, then the most recent. Then **Start
 *   fresh from `<branch>`**, naming the branch a fresh task really starts from, never a literal `main`;
 * - typing works like the buttons. "build on it", "continue" or "that branch" build on the first one listed; "fresh",
 *   "start fresh" or "new branch" start fresh. At most five words, and a typed answer is never a task for the model.
 *   Anything else typed is the message it is, and the question goes away;
 * - unanswered, stopped, or dropped by a mode switch: nothing runs;
 * - in Unattended nothing is asked. The engine builds on the branch the window is on when that is left work, and
 *   otherwise starts fresh, with one line saying which;
 * - an answer that moves the checkout to another branch is checked first (`leftBranches.switchRefusal`): tracked changes,
 *   and untracked files the target has a file of the same name for, refuse in plain words; other untracked files come
 *   along, with a line naming them;
 * - Clarvis's own engine only (`EarlierRunPort`): when the window is on the branch its earlier run left, that run's own
 *   uncommitted files are committed onto that branch first, with a line saying so. That happens whether the answer builds
 *   on that branch or leaves it, so the earlier work never ends up split between that branch and the owner's own files.
 *
 * vscode-free: `RunSession` hands in the finding, the chat's question and git.
 */

/** What the task does: start fresh as it always has, build on earlier work, or nothing at all. */
export type Where<T> = { kind: 'fresh' } | { kind: 'build_on'; task: T } | { kind: 'nothing' };

type Picked<T> = Exclude<Where<T>, { kind: 'nothing' }>;

const FRESH = { kind: 'fresh' } as const;
const NOTHING = { kind: 'nothing' } as const;

export function buildOnLabel(branch: string): string {
  return `Build on ${branch}`;
}

export function startFreshLabel(branch: string): string {
  return `Start fresh from ${branch}`;
}

/** What one engine says in the question, and how its log lines start. */
export interface LeftWorkWords<T extends LeftBranch> {
  /** "codex left work", or "left work". */
  logPrefix: string;
  /** Who didn't start, in a refusal: "Codex", or "I". */
  subject: string;
  /** The line before the buttons. `found` is every left branch, which can be more than the three offered. */
  question(offered: readonly T[], found: number, trunk: string, startsFrom: string): string;
  buildOnDetail(task: T): string;
  startFreshDetail(startsFrom: string): string;
  unattendedBuildOn(branch: string): string;
  unattendedFresh(startsFrom: string, offered: readonly T[]): string;
  /** The work, as the log names it. */
  named(task: T): string;
}

/** The buttons: one **Build on** per offered branch, then **Start fresh**. */
export function leftWorkChoicesFor<T extends LeftBranch>(words: LeftWorkWords<T>, offered: readonly T[], startsFrom: string): { label: string; detail: string }[] {
  const buildOn = offered.map((task) => ({ label: buildOnLabel(task.branch), detail: words.buildOnDetail(task) }));
  return [...buildOn, { label: startFreshLabel(startsFrom), detail: words.startFreshDetail(startsFrom) }];
}

/**
 * Words that mean one of the two ways, anchored to the start by `offerAnswer`: "build on it" builds on, "build on it
 * later?" is a question and not an answer.
 */
const BUILD_ON_WORDS = ['build on( it| that| this| (it|that|this|the) branch)?', 'continue( on( it| that| there)?| there| it| that)?', '(on |use )?(that|this|the same) branch'];
const FRESH_WORDS = ['(start )?fresh', 'start (a )?(fresh|new)( one| task)?', 'start over', '(a |on a )?new branch'];

/**
 * The longest a typed answer may be. The words aren't passed to the model, so a sentence that happens to start with
 * "continue" has to stay the message it is rather than be swallowed as an answer.
 */
const MOST_WORDS = 5;

/** The button a typed answer means, or undefined when it isn't an answer to this question. */
export function leftWorkChoice(typed: string, offered: readonly LeftBranch[], startsFrom: string): string | undefined {
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

/** Clarvis's own engine's earlier run, when the window is on its branch: its own files as it left them, and those changed since. */
export interface EarlierRun {
  branch: string;
  /** The run's own uncommitted files, unchanged since it ended: committed onto its branch first. */
  saving: string[];
  /** The run's own files changed since it ended: they refuse a switch, and stay the owner's on that branch. */
  edited: string[];
}

/** Why the earlier run's files are committed now: to build on them there, before starting fresh, or before switching away. */
export type SavePurpose = { kind: 'build_on' } | { kind: 'fresh'; from: string } | { kind: 'switch'; to: string };

/** Clarvis's own engine's part (`leftRuns.earlierRunPort`). Codex has none: its work is committed when its task settles. */
export interface EarlierRunPort {
  /** Read now, not when the question was asked; undefined when the window isn't on a branch this engine's run left. */
  sort(): Promise<EarlierRun | undefined>;
  /** Commits `saving` on its branch. The line is for the chat; `ok` false means nothing runs. */
  save(earlier: EarlierRun, purpose: SavePurpose): Promise<{ ok: boolean; line?: string }>;
}

export interface LeftWorkHost<T extends LeftBranch> {
  /** The engine's own left work in this folder. */
  find(): Promise<LeftWorkFound<T>>;
  /** The chat is in Unattended now: nothing is asked. */
  unattended(): boolean;
  /** Shows the buttons and waits: the label chosen or typed, or undefined when unanswered, stopped or dropped. */
  ask(choices: { label: string; detail?: string }[], accepts: (typed: string) => string | undefined): Promise<string | undefined>;
  /** Writes a line in the chat. */
  note(line: string): Promise<void>;
  /** The checkout's changes (`GitFacts.workingTree`), read only when the answer moves the checkout. */
  tree(): Promise<WorkingTree | undefined>;
  /** The files on a branch (`GitFacts.filesOn`), read only when untracked files might clash with them. */
  filesOn(branch: string): Promise<string[] | undefined>;
  earlier?: EarlierRunPort;
  log(line: string): void;
}

/** Where a task goes: asked, picked for Unattended, or fresh as today when there is nothing to build on. */
export async function whereWorkGoes<T extends LeftBranch>(host: LeftWorkHost<T>, words: LeftWorkWords<T>): Promise<Where<T>> {
  const found = await host.find();
  const offered = offeredTasks(found.tasks);
  if (offered.length === 0 || !found.startsFrom || !found.trunk) return FRESH;
  const startsFrom = found.startsFrom;
  const picked = host.unattended()
    ? await unattendedPick(host, words, offered, startsFrom)
    : await asked(host, words, offered, found.tasks.length, { trunk: found.trunk, startsFrom });
  return picked.kind === 'nothing' ? picked : placed(host, words, picked, { headBranch: found.headBranch, startsFrom });
}

/** Unattended answers questions itself: the branch the window is on when that is left work, otherwise fresh. */
async function unattendedPick<T extends LeftBranch>(host: LeftWorkHost<T>, words: LeftWorkWords<T>, offered: readonly T[], startsFrom: string): Promise<Picked<T>> {
  const here = offered.find((task) => task.onBranch);
  await host.note(here ? words.unattendedBuildOn(here.branch) : words.unattendedFresh(startsFrom, offered));
  host.log(`${words.logPrefix}: Unattended, ${here ? `building on ${words.named(here)}` : 'starting fresh'} without asking`);
  return here ? { kind: 'build_on', task: here } : FRESH;
}

async function asked<T extends LeftBranch>(
  host: LeftWorkHost<T>,
  words: LeftWorkWords<T>,
  offered: readonly T[],
  found: number,
  names: { trunk: string; startsFrom: string }
): Promise<Where<T>> {
  await host.note(words.question(offered, found, names.trunk, names.startsFrom));
  const answer = await host.ask(leftWorkChoicesFor(words, offered, names.startsFrom), (typed) => leftWorkChoice(typed, offered, names.startsFrom));
  if (answer === startFreshLabel(names.startsFrom)) {
    host.log(`${words.logPrefix}: start fresh from ${names.startsFrom}, the earlier work left where it is`);
    return FRESH;
  }
  const task = offered.find((candidate) => buildOnLabel(candidate.branch) === answer);
  if (!task) {
    host.log(`${words.logPrefix}: the question went unanswered, was stopped or was dropped, so nothing runs`);
    return NOTHING;
  }
  host.log(`${words.logPrefix}: building on ${words.named(task)}`);
  return { kind: 'build_on', task };
}

/**
 * The answer, carried out as far as the chat's part goes: the switch checked, the earlier run's files committed, and the
 * files that come along named. Refused or failed: nothing runs.
 */
async function placed<T extends LeftBranch>(host: LeftWorkHost<T>, words: LeftWorkWords<T>, picked: Picked<T>, at: { headBranch?: string; startsFrom: string }): Promise<Where<T>> {
  const move = moveFor(picked.kind === 'build_on' ? picked.task.branch : undefined, at.headBranch, at.startsFrom);
  const port = host.earlier;
  const earlier = await port?.sort();
  if (move.switching && (await switchRefused(host, words, move, at.headBranch, earlier))) return NOTHING;
  if (port && earlier && !(await earlierSaved(host, port, earlier, purposeOf(picked, move)))) return NOTHING;
  if (move.switching) await carriedSaid(host);
  return picked;
}

async function switchRefused<T extends LeftBranch>(host: LeftWorkHost<T>, words: LeftWorkWords<T>, move: Move, headBranch: string | undefined, earlier: EarlierRun | undefined): Promise<boolean> {
  const tree = await host.tree();
  const onTarget = tree && (tree.untracked.length > 0 ? await host.filesOn(move.target) : []);
  if (!tree || !onTarget) {
    host.log(`${words.logPrefix}: the checkout's changes couldn't be read, so nothing runs`);
    await host.note(unreadableTreeLine(words.subject));
    return true;
  }
  const refusal = switchRefusal(tree, onTarget, earlier?.saving, earlier?.edited);
  if (!refusal) return false;
  host.log(`${words.logPrefix}: not moving to ${move.target}, the checkout has changes the switch would carry along or clash with`);
  await host.note(switchRefusalLine(words.subject, headBranch, move, refusal));
  return true;
}

async function earlierSaved<T extends LeftBranch>(host: LeftWorkHost<T>, port: EarlierRunPort, earlier: EarlierRun, purpose: SavePurpose): Promise<boolean> {
  const saved = await port.save(earlier, purpose);
  if (saved.line) await host.note(saved.line);
  return saved.ok;
}

function purposeOf<T>(picked: Picked<T>, move: Move): SavePurpose {
  if (picked.kind === 'fresh') return { kind: 'fresh', from: move.target };
  return move.switching ? { kind: 'switch', to: move.target } : { kind: 'build_on' };
}

/** Its own line: the untracked files that come along, read after the earlier run's own files were committed. */
async function carriedSaid<T extends LeftBranch>(host: LeftWorkHost<T>): Promise<void> {
  const tree = await host.tree();
  const names = tree ? carriedNames(tree) : [];
  if (names.length > 0) await host.note(carriedLine(names));
}
