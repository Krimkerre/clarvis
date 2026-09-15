/**
 * Clarvis's own engine's work left on its branch (plan.md M15, "Build on Clarvis's own earlier work"; the owner's decision
 * of 15 Sep 2026, "Give Clarvis's own engine the same question").
 *
 * **What happened without it.** Clarvis's own engine starts every new task on a new branch from the trunk
 * (`AgentBranch.begin`). So after the owner answered "Leave it there" on a run's branch, a follow-up started beside that
 * work and never saw it, the gap Codex had until 0.17.3.
 *
 * **Written when a run ends** (`rememberLeftRun`, from `RunSession.endRun` while the run still holds the project lock):
 * every run of this engine that ends on its own `clarvis/*` branch, whatever the landing question gets as an answer
 * afterwards. Whether its work was left is judged from git when the next task asks, not from that answer. Merged work is
 * merged whether "Merge into …" or a hand merge did it, and "Show me what changed" leaves the work where "Leave it there"
 * does. A run stopped for an engine switch isn't written: its task moved, it wasn't left.
 *
 * **What counts as left**, checked in this order (`findLeftRuns`):
 * - the checkout has a commit and a trunk (`leftBranches.placeOf`, shared with Codex);
 * - the record is this folder's and readable. A missing or unreadable record offers nothing;
 * - the run's branch isn't the trunk, still exists, and still holds the tip the run left: that commit, or one after it.
 *   A branch moved away no longer holds that run's work;
 * - its branch has commits in neither the trunk nor the starting branch. Or the window is on that branch and some of the
 *   run's own uncommitted files are still as the run left them. That second case was found live on 13 Sep: "Leave it
 *   there" left `clarvis/start-building-…` with no commit and all of the run's files uncommitted.
 * A run that fails these is dropped from the record, while this window holds the project lock. Nothing else is running
 * on it: the question is asked once this task holds the project lock.
 *
 * **Codex's branches are never offered here**: Codex's tasks aren't in this record, and runs in it are never offered to
 * Codex. A branch both engines left is offered by both questions, each from its own finding.
 *
 * **The earlier run's own files** (`earlierRunPort`) are taken from the record, never from `git status`: only what the
 * run wrote itself. Files the owner already had in flight when it started stay the owner's, and a file whose content no
 * longer matches the record was changed after the run ended. When Clarvis can't read a file, it counts as changed.
 *
 * vscode-free, with real git in temporary repositories (`leftRuns.test.ts`, `clarvisLeftWork.test.ts`).
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { EarlierRun, EarlierRunPort, SavePurpose } from '../chat/leftWork';
import type { CheckpointWrite } from '../engine/checkpoint/checkpointFile';
import type { GitFacts } from '../engine/checkpoint/gitFacts';
import { readLeftWork, withLeftRun, withoutLeftRuns, writeLeftWork, type LeftFile, type LeftRun, type LeftWorkRecord } from '../engine/checkpoint/leftWorkFile';
import type { Host } from '../engine/relay/relayTypes';
import type { AgentEngineOptions } from './AgentRunner';
import { mergedInto, namedFiles, placeOf, type LeftBranch, type LeftWorkFound, type Place } from './leftBranches';

const BRIEF_LIMITS = { task: 2_000, summary: 2_000 };

/** A run of Clarvis's own engine whose work is left on its branch. */
export interface LeftRunTask extends LeftBranch {
  run: LeftRun;
}

export interface LeftRunsDeps {
  git: Pick<GitFacts, 'head' | 'branches' | 'tip' | 'isAncestor' | 'dirty'>;
  root: string;
  /** The checkout's git folder, where the record lives; a folder without git has none. */
  gitDir: string | undefined;
  /** `clarvis.agent.baseBranch`: the base remembered from an earlier run, as `AgentBranch` keeps it. */
  rememberedBase?: string;
  /** `plan.md`'s text. Read from the root when absent. */
  planText?: string;
  /** Whether this window still holds the project lock: the record is tidied only then. */
  stillHolds: () => Promise<boolean>;
  log?: (line: string) => void;
}

/** The runs this engine left in this folder, most recent first, or none when anything needed to judge them is missing. */
export async function findLeftRuns(deps: LeftRunsDeps): Promise<LeftWorkFound<LeftRunTask>> {
  const place = await placeOf(deps.git, deps.root, deps.rememberedBase, deps.planText);
  if (!place || !deps.gitDir) return { tasks: [] };
  const names = { startsFrom: place.startsFrom, trunk: place.trunk, headBranch: place.headBranch };
  const read = readLeftWork(deps.root, deps.gitDir);
  if (read.kind !== 'found') {
    if (read.kind !== 'absent') deps.log?.(`left work: the record of left runs can't be used here (${read.kind === 'unreadable' ? read.detail : read.kind}), so nothing is offered from it`);
    return { ...names, tasks: [] };
  }
  const judged = await judgeRuns(deps, place, read.record);
  if (judged.stale.length > 0) await tidy(deps, deps.gitDir, read.record, judged.stale);
  return { ...names, tasks: judged.tasks };
}

async function judgeRuns(deps: LeftRunsDeps, place: Place, record: LeftWorkRecord): Promise<{ tasks: LeftRunTask[]; stale: string[] }> {
  const tasks: LeftRunTask[] = [];
  const stale: string[] = [];
  const dirty = once(() => deps.git.dirty());
  for (const run of [...record.runs].sort((a, b) => b.endedAt.localeCompare(a.endedAt))) {
    const verdict = await judge(deps, place, run, dirty);
    if (typeof verdict !== 'string') {
      tasks.push(verdict);
      continue;
    }
    stale.push(run.branch);
    deps.log?.(`left work: the run on ${run.branch} isn't offered, and is dropped from the record: ${verdict}`);
  }
  return { tasks, stale };
}

/** The run as left work, or why it no longer is. */
async function judge(deps: LeftRunsDeps, place: Place, run: LeftRun, dirty: () => Promise<string[]>): Promise<LeftRunTask | string> {
  if (place.mains.includes(run.branch)) return `it is ${run.branch} itself`;
  const tip = await deps.git.tip(run.branch);
  if (!tip) return 'its branch is gone';
  if (tip !== run.headCommit && !(await deps.git.isAncestor(run.headCommit, tip))) return "its branch no longer holds that run's work";
  const onBranch = run.branch === place.headBranch;
  const task: LeftRunTask = { branch: run.branch, tip, updatedAt: run.endedAt, onBranch, run };
  if (!(await mergedInto(deps.git, place, tip))) return task;
  // Merged, or never committed: still left while the window is on it with the run's own files as it left them.
  if (onBranch && sortFiles(deps.root, run, await dirty()).saving.length > 0) return task;
  return `it is merged into ${place.mains.join(' or ')}`;
}

async function tidy(deps: LeftRunsDeps, gitDir: string, record: LeftWorkRecord, stale: string[]): Promise<void> {
  const written = await writeLeftWork(deps.root, gitDir, withoutLeftRuns(record, stale), deps.stillHolds);
  if (written.kind !== 'saved') deps.log?.(`left work: the record wasn't tidied (${written.kind})`);
}

/**
 * The run's own uncommitted files that are uncommitted still: `saving`, as the run left them; `edited`, changed since, or
 * unreadable now. Files it left that are no longer uncommitted (committed or put back by hand) are neither.
 */
export function sortFiles(root: string, run: LeftRun, dirty: readonly string[]): { saving: string[]; edited: string[] } {
  const inFlight = new Set(dirty);
  const saving: string[] = [];
  const edited: string[] = [];
  for (const file of run.uncommitted) {
    if (!inFlight.has(file.path)) continue;
    (contentOf(root, file.path) === file.sha256 ? saving : edited).push(file.path);
  }
  return { saving, edited };
}

/** A file's SHA-256; `null` when it doesn't exist; undefined when it can't be read, or names somewhere outside the folder. */
export function contentOf(root: string, file: string): string | null | undefined {
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return undefined;
  try {
    return createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
  }
}

// ── Saving the earlier run's own files ──────────────────────────────────────

export const LEFT_RUN_LINES = {
  notCommitted: (edited: readonly string[]) =>
    `${namedFiles(edited)} changed after the last run ended, so ${edited.length === 1 ? "it isn't committed and stays" : "they aren't committed and stay"} yours.`,
  saveFailed: (branch: string, detail: string) => `The last run's files couldn't be committed to \`${branch}\` (${detail}), so I didn't start.`,
} as const;

export interface EarlierRunDeps {
  git: Pick<GitFacts, 'dirty' | 'commitOnBranch'>;
  root: string;
  /** The left runs the question found. */
  found: () => readonly LeftRunTask[];
  log: (line: string) => void;
}

/**
 * The question's part for this engine (`leftWork.EarlierRunPort`): when the window is on the branch a run left, that run's
 * own uncommitted files are committed onto it, with a line in the chat. Never silently, and never the owner's files.
 */
export function earlierRunPort(deps: EarlierRunDeps): EarlierRunPort {
  return {
    sort: async () => {
      const here = deps.found().find((task) => task.onBranch);
      return here ? { branch: here.branch, ...sortFiles(deps.root, here.run, await deps.git.dirty()) } : undefined;
    },
    save: (earlier, purpose) => saveEarlierRun(deps, earlier, purpose),
  };
}

async function saveEarlierRun(deps: EarlierRunDeps, earlier: EarlierRun, purpose: SavePurpose): Promise<{ ok: boolean; line?: string }> {
  if (earlier.saving.length === 0) {
    // Nothing of the run's own to commit. On its branch, files it left that were changed since are still named.
    return { ok: true, line: purpose.kind === 'build_on' && earlier.edited.length > 0 ? LEFT_RUN_LINES.notCommitted(earlier.edited) : undefined };
  }
  const run = deps.found().find((task) => task.branch === earlier.branch)?.run;
  const committed = await deps.git.commitOnBranch(earlier.branch, earlier.saving, saveMessage(purpose, run?.task));
  if (!committed.ok) {
    deps.log(`left work: the last run's files couldn't be committed on ${earlier.branch} (${committed.detail}), so nothing runs`);
    return { ok: false, line: LEFT_RUN_LINES.saveFailed(earlier.branch, committed.detail) };
  }
  deps.log(`left work: committed ${earlier.saving.length} file(s) the last run left on ${earlier.branch} (${committed.commit.slice(0, 7)})`);
  return { ok: true, line: savedLine(earlier, purpose) };
}

function saveMessage(purpose: SavePurpose, task: string | undefined): string {
  const subject = `Save the earlier run's work ${purposeWords(purpose, false)}`;
  return task ? `${subject}\n\nTask: ${task}` : subject;
}

function savedLine(earlier: EarlierRun, purpose: SavePurpose): string {
  const count = earlier.saving.length;
  const saved = `Committed the last run's ${count === 1 ? '1 file' : `${count} files`} to \`${earlier.branch}\``;
  if (purpose.kind !== 'build_on') return `${saved} ${purposeWords(purpose, true)}.`;
  const edited = earlier.edited.length > 0 ? ` ${LEFT_RUN_LINES.notCommitted(earlier.edited)}` : '';
  return `${saved} so this run builds on ${count === 1 ? 'it' : 'them'}.${edited}`;
}

function purposeWords(purpose: SavePurpose, quoted: boolean): string {
  if (purpose.kind === 'fresh') return 'before starting fresh';
  if (purpose.kind === 'switch') return `before switching to ${quoted ? `\`${purpose.to}\`` : purpose.to}`;
  return 'before building on it';
}

// ── Written when a run ends ─────────────────────────────────────────────────

/** What a run of this engine knew when it ended on its own branch. */
export interface RunEnded {
  branch: string;
  taskId: string;
  task: string;
  summary: string;
  startedFrom?: string;
  /** Every file the run wrote. */
  files: string[];
  /** The owner's files already in flight when it started. */
  inFlightAtStart: string[];
  host: Host;
  now: Date;
}

export interface RememberDeps {
  git: Pick<GitFacts, 'head' | 'tip' | 'dirty'>;
  root: string;
  gitDir: string;
  stillHolds: () => Promise<boolean>;
}

/** Writes the run into the record, replacing an earlier run on its branch; `no_branch` when its branch is already gone. */
export async function rememberLeftRun(deps: RememberDeps, ended: RunEnded): Promise<CheckpointWrite['kind'] | 'no_branch'> {
  const tip = await deps.git.tip(ended.branch);
  if (!tip) return 'no_branch';
  const own = ended.files.filter((file) => !ended.inFlightAtStart.includes(file));
  const run: LeftRun = {
    branch: ended.branch,
    taskId: ended.taskId,
    task: ended.task,
    summary: ended.summary,
    ...(ended.startedFrom ? { startedFrom: ended.startedFrom } : {}),
    headCommit: tip,
    files: own,
    inFlightAtStart: ended.inFlightAtStart,
    uncommitted: await uncommittedOf(deps, ended.branch, own),
    endedAt: ended.now.toISOString(),
    host: ended.host,
  };
  const read = readLeftWork(deps.root, deps.gitDir);
  const record = withLeftRun(read.kind === 'found' ? read.record : undefined, run, deps.root);
  return (await writeLeftWork(deps.root, deps.gitDir, record, deps.stillHolds)).kind;
}

/**
 * The run's own files still uncommitted, with their content now. None when the checkout isn't on the run's branch:
 * uncommitted files belong to whichever branch is checked out. A file that can't be read isn't recorded, so it can
 * never be taken for the run's.
 */
async function uncommittedOf(deps: RememberDeps, branch: string, own: readonly string[]): Promise<LeftFile[]> {
  if ((await deps.git.head()).branch !== branch) return [];
  const dirty = new Set(await deps.git.dirty());
  return own
    .filter((file) => dirty.has(file))
    .flatMap((file) => {
      const sha256 = contentOf(deps.root, file);
      return sha256 === undefined ? [] : [{ path: file, sha256 }];
    });
}

// ── What the next run is told ───────────────────────────────────────────────

/**
 * The earlier run, for the model's instructions on a **Build on** (`AgentEngineOptions.earlierWork`): what it was asked,
 * what it said when it ended, and the commits on its branch since the starting branch. It is part of the instructions,
 * never of the task, so the new commit's `Task:` line stays the owner's request.
 */
export function earlierWorkBrief(task: LeftRunTask, subjects: readonly string[]): string {
  const { run } = task;
  const summary = run.summary.trim();
  const sections = [
    `This task builds on your own earlier work on \`${task.branch}\`, which is checked out for it. Add to that work; don't start it again from scratch.`,
    `The earlier task, as it was asked: ${clip(run.task.trim(), BRIEF_LIMITS.task)}`,
    summary ? `What you said when it ended: ${clip(summary, BRIEF_LIMITS.summary)}` : 'It ended without saying anything.',
    subjects.length > 0 ? ['Commits on this branch so far, newest first:', ...subjects.map((subject) => `- ${subject}`)].join('\n') : undefined,
    'Re-read any file before you edit it.',
  ];
  return `\n\n${sections.filter((section): section is string => section !== undefined).join('\n\n')}`;
}

/**
 * How the run starts on the answer (`RunSession.whereClarvisWorks`), read after any commit the question made:
 * - **Build on**: that branch carried on at its tip now, never a new branch beside it, with the branch the question named
 *   as its base for the landing question, and the earlier run in the model's instructions;
 * - **Start fresh**: a new branch from the starting branch, never stacked on a `clarvis/*` branch.
 * Either way, what is still uncommitted is the owner's (`theirs`): held back from the run's commits, as for any run.
 */
export async function placedRunOptions(
  git: Pick<GitFacts, 'dirty' | 'tip' | 'commitSubjects'>,
  where: { kind: 'fresh' } | { kind: 'build_on'; task: LeftRunTask },
  startsFrom: string | undefined
): Promise<{ engine: AgentEngineOptions; theirs: string[] }> {
  const theirs = await git.dirty();
  if (where.kind === 'fresh') return { engine: { startFresh: true }, theirs };
  const left = where.task;
  const tip = (await git.tip(left.branch)) ?? left.tip;
  const subjects = startsFrom ? await git.commitSubjects(startsFrom, left.branch) : [];
  return { engine: { continueOn: { branch: left.branch, headCommit: tip, theirs, base: startsFrom }, earlierWork: earlierWorkBrief(left, subjects) }, theirs };
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= read());
}
