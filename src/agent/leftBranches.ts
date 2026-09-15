/**
 * Earlier work left on a branch, as both coding engines see it (plan.md M15: "Build on Codex's earlier work", and "Build
 * on Clarvis's own earlier work"). Each engine finds its own left work: Codex through RAVIS (`leftTasks.ts`), Clarvis's
 * own engine from its record (`leftRuns.ts`). What they share is here, so the two questions can't drift apart:
 * - **where the checkout stands** (`placeOf`): the branch a fresh task starts from (`startingBase`, the rule
 *   `AgentBranch.begin` follows), and the trunk: the plan's declared one when that branch exists, else the starting
 *   branch. Never a literal `main`. "Merged" means the branch's tip is in either of them;
 * - **which work is offered** (`offeredTasks`): the branch the window is on first, then the most recent, at most three;
 * - **what a branch switch may carry along** (`switchRefusal`), the owner's rule of 15 Sep 2026 for both engines.
 *
 * **The switch rule.** Whenever the answer moves the checkout to another branch (**Build on** a branch the window isn't
 * on, or **Start fresh** from a `clarvis/*` branch):
 * - ignored files don't count at all;
 * - untracked files the target doesn't have don't block. Git carries them across without loss, so the switch goes ahead
 *   and the chat gets one line naming them (`carriedLine`). A folder holding nothing tracked is named once, as `folder/`;
 * - tracked files with uncommitted or staged changes refuse, and so do untracked files the target has a file of the same
 *   name for. The refusal names them (`switchRefusalLine`). Clarvis's own engine first commits its earlier run's own files
 *   onto that run's branch (`leftRuns.ts`), so those don't refuse;
 * - Codex's scratch space (`.clarvis/tmp/`) is never the owner's work.
 *
 * **What changed from 0.17.3**, where a Codex Build on was refused for any modified, staged or untracked file: an untracked
 * file the target doesn't have no longer refuses, and Codex's Start fresh from a `clarvis/*` branch is now checked too.
 * Found with the peer session: an untracked `__pycache__/` that a test run made would otherwise refuse every Python
 * project.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GitFacts, WorkingTree } from '../engine/checkpoint/gitFacts';
import { parseBranchFlow } from './branchFlow';
import { isAgentBranch, startingBase } from './branchNames';

/** How many **Build on** buttons the question offers, at most. */
export const MOST_OFFERED = 3;
/** Scratch space Codex's commands may use: never the owner's work (`codexGit.ts`). */
export const SCRATCH = '.clarvis/tmp/';
/** How many file names a line names before "and N more". */
const MOST_NAMED = 3;

/** Earlier work left on a branch, whichever engine left it. */
export interface LeftBranch {
  branch: string;
  /** The branch's tip, when it was found. */
  tip: string;
  /** When the work was left: the most recent is offered first after the window's own branch. */
  updatedAt: string;
  /** The window's checkout is on this branch. */
  onBranch: boolean;
}

/** What was found, and the branches the question names. Empty `tasks` means nothing is asked. */
export interface LeftWorkFound<T extends LeftBranch> {
  /** The branch a fresh task starts from: what **Start fresh from …** names. */
  startsFrom?: string;
  /** The trunk the question says the work isn't merged into. */
  trunk?: string;
  /** The branch the checkout is on; undefined when HEAD is detached. */
  headBranch?: string;
  tasks: T[];
}

/** Where this checkout stands: the branches work counts as merged into, and their tips. */
export interface Place {
  startsFrom: string;
  trunk: string;
  headBranch?: string;
  mains: string[];
  mainTips: string[];
}

/** The trunk and the starting branch with their tips, or undefined when there is no commit or no branch to compare with. */
export async function placeOf(git: Pick<GitFacts, 'head' | 'branches' | 'tip'>, root: string, rememberedBase?: string, planText?: string): Promise<Place | undefined> {
  const head = await git.head();
  if (!head.commit) return undefined;
  const branches = await git.branches();
  const startsFrom = startingBase(head.branch, false, rememberedBase, branches);
  const declared = parseBranchFlow(planText ?? readPlan(root)).trunk;
  const trunk = declared && branches.includes(declared) ? declared : startsFrom;
  if (!startsFrom || !trunk) return undefined;
  const mains = [...new Set([trunk, startsFrom])];
  const mainTips = await Promise.all(mains.map((name) => git.tip(name)));
  // Not knowing is not "not merged": a tip that can't be read offers nothing.
  if (mainTips.some((tip) => tip === undefined)) return undefined;
  return { startsFrom, trunk, headBranch: head.branch, mains, mainTips: mainTips as string[] };
}

/** Whether `tip` is already in the trunk or the starting branch: merged work has nothing left to build on. */
export async function mergedInto(git: Pick<GitFacts, 'isAncestor'>, place: Place, tip: string): Promise<boolean> {
  for (const main of place.mainTips) {
    if (await git.isAncestor(tip, main)) return true;
  }
  return false;
}

/** The work the question offers: the one on the branch the window is on first, then the most recent, at most three. */
export function offeredTasks<T extends LeftBranch>(tasks: readonly T[]): T[] {
  const here = tasks.filter((task) => task.onBranch);
  const others = tasks.filter((task) => !task.onBranch).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...here, ...others].slice(0, MOST_OFFERED);
}

export function readPlan(root: string): string {
  try {
    return fs.readFileSync(path.join(root, 'plan.md'), 'utf8');
  } catch {
    // No plan, or unreadable: the starting branch is the trunk, as the review wizard falls back to conventions.
    return '';
  }
}

export function isScratch(file: string): boolean {
  return file.startsWith(SCRATCH);
}

// ── A branch switch with files in flight ────────────────────────────────────

/** Where an answer moves the checkout, and how a line says it. */
export interface Move {
  /** The checkout moves to another branch. */
  switching: boolean;
  /** The branch whose files the checkout takes on. */
  target: string;
  /** "Switching to `x`" or "Starting fresh from `master`", to start a sentence. */
  phrase: string;
}

/**
 * **Build on** `buildOn` moves the checkout unless the window is on it. **Start fresh** (`buildOn` undefined) moves it
 * only from a `clarvis/*` branch: from any other branch a fresh task starts where the window is (`startingBase`).
 */
export function moveFor(buildOn: string | undefined, headBranch: string | undefined, startsFrom: string): Move {
  if (buildOn !== undefined) return { switching: headBranch !== buildOn, target: buildOn, phrase: `Switching to \`${buildOn}\`` };
  const switching = headBranch !== undefined && isAgentBranch(headBranch) && headBranch !== startsFrom;
  return { switching, target: startsFrom, phrase: `Starting fresh from \`${startsFrom}\`` };
}

/** What stops a switch: tracked changes, and untracked files the target has a file of the same name for. */
export interface SwitchRefusal {
  changed: string[];
  colliding: string[];
}

/**
 * Why a switch to a branch holding `onTarget` is refused, or undefined when it may go ahead.
 *
 * `saving` are the earlier run's own files that Clarvis's own engine commits onto that run's branch first, so they don't
 * refuse. `edited` are that run's files changed since it ended: no longer only its work, and not the owner's alone
 * either, so they refuse whether git tracks them or not.
 */
export function switchRefusal(tree: WorkingTree, onTarget: readonly string[], saving: readonly string[] = [], edited: readonly string[] = []): SwitchRefusal | undefined {
  const skipped = new Set([...saving, ...edited]);
  const theirs = (files: readonly string[]) => files.filter((file) => !skipped.has(file) && !isScratch(file));
  const changed = [...edited.filter((file) => !isScratch(file)), ...theirs(tree.changed)];
  const colliding = collidingFiles(theirs(tree.untracked), onTarget);
  return changed.length === 0 && colliding.length === 0 ? undefined : { changed, colliding };
}

/**
 * The untracked files a checkout of `onTarget` would clash with: the same path, a file where the target has a folder, or
 * a file inside what the target has as a file.
 */
export function collidingFiles(untracked: readonly string[], onTarget: readonly string[]): string[] {
  if (untracked.length === 0) return [];
  const files = new Set(onTarget);
  const folders = new Set(onTarget.flatMap(parentFolders));
  return untracked.filter((file) => files.has(file) || folders.has(file) || parentFolders(file).some((folder) => files.has(folder)));
}

/** The untracked files a switch carries along, as git shows them, without Codex's scratch space. */
export function carriedNames(tree: WorkingTree): string[] {
  return tree.shown.flatMap((entry) => {
    if (isScratch(entry)) return [];
    // A folder shown whole because it holds only untracked files, scratch space among them: its other files by name.
    if (entry.endsWith('/') && SCRATCH.startsWith(entry)) return tree.untracked.filter((file) => file.startsWith(entry) && !isScratch(file));
    return [entry];
  });
}

/** "`a`, `b`, `c` and 2 more". */
export function namedFiles(files: readonly string[]): string {
  const named = files.slice(0, MOST_NAMED).map((file) => `\`${file}\``).join(', ');
  return files.length > MOST_NAMED ? `${named} and ${files.length - MOST_NAMED} more` : named;
}

/**
 * The refusal, in plain words. `subject` is who didn't start: "Codex", or "I" for Clarvis's own engine. With tracked
 * changes alone it is word for word 0.17.3's line.
 */
export function switchRefusalLine(subject: string, headBranch: string | undefined, move: Move, refusal: SwitchRefusal): string {
  const { changed, colliding } = refusal;
  const didNot = `so ${subject} didn't start`;
  if (colliding.length === 0) return `${changesClause(headBranch, changed)}. ${move.phrase} would carry them along, ${didNot}. Commit them or put them aside, then ask again.`;
  if (changed.length > 0) {
    return `${changesClause(headBranch, changed)}, and ${clashClause(colliding, move.target, ' while')}. ${move.phrase} would carry the changes along and clash with the rest, ${didNot}. Commit them or put them aside, then ask again.`;
  }
  const it = colliding.length === 1 ? 'it' : 'them';
  return `${clashClause(colliding, move.target, ', and')}. ${move.phrase} would clash with ${it}, ${didNot}. Commit ${it} or put ${it} aside, then ask again.`;
}

/** Its own chat line, said as the switch goes ahead: the untracked files that come along. */
export function carriedLine(names: readonly string[]): string {
  return `${names.length === 1 ? 'This comes' : 'These come'} along, not committed anywhere: ${namedFiles(names)}.`;
}

/** Git couldn't say what is in flight, and not knowing is not "nothing": nothing runs. */
export function unreadableTreeLine(subject: string): string {
  return `I couldn't tell which files in this folder have changes, so ${subject} didn't start. Ask again in a moment.`;
}

function changesClause(headBranch: string | undefined, changed: readonly string[]): string {
  const where = headBranch ? ` on \`${headBranch}\`` : '';
  return `You have changes${where} that aren't committed yet (${namedFiles(changed)})`;
}

function clashClause(colliding: readonly string[], target: string, glue: string): string {
  const one = colliding.length === 1;
  return `${namedFiles(colliding)} ${one ? "isn't" : "aren't"} in git${glue} \`${target}\` has ${one ? 'a file' : 'files'} of the same name`;
}

/** `a/b/c.txt` → `a`, `a/b`. */
function parentFolders(file: string): string[] {
  const parts = file.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}
