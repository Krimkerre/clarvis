/**
 * The checkpoint a switch saves, from what the stopping engine knows (plan.md M15, C3; design §6.1, §6.2 step 4).
 *
 * **Two sources, one record.** A Codex task settles with facts from RAVIS's events (`CodexSettleFacts`); a run of
 * Clarvis's own engine stops with facts from the run and from git (`ClarvisStopFacts`). Either way the result is the
 * same `TaskCheckpoint`, built on the one already saved for the same task — its brief, its plan steps, its earlier
 * checks and feedback — so a task switched back and forth keeps its history.
 *
 * **What is never carried over as a thing to do.** Questions that were open become `unresolvedQuestions`, never
 * answered for the next engine; operations that were under way become `uncertainOperations`, to be checked before
 * anything is repeated (design §6.4).
 *
 * **One project only.** A saved checkpoint for another task, or another folder, is never built on: a new record is
 * started for this task instead.
 *
 * Pure.
 */

import type { CheckRun } from '../codex/ledger';
import type { CodexSettleFacts } from '../codex/runCore';
import type { Host } from '../relay/relayTypes';
import {
  newCheckpoint,
  type CheckRecord,
  type DiffStat,
  type FeedbackNote,
  type OpenQuestion,
  type TaskCheckpoint,
  type UncertainOperation,
} from '../checkpoint/taskCheckpoint';

export interface CheckpointContext {
  workspaceRoot: string;
  host: Host;
  now: Date;
}

/** A Codex settle's facts as the checkpoint. `homeFingerprint` is RAVIS's Codex home now, for a later resume. */
export function checkpointFromCodex(saved: TaskCheckpoint | undefined, facts: CodexSettleFacts, context: CheckpointContext & { homeFingerprint?: string }): TaskCheckpoint {
  const base = sameTask(saved, facts.taskId, context) ?? newCheckpoint({ taskId: facts.taskId, workspaceRoot: context.workspaceRoot, host: context.host, engine: 'codex', task: '', now: context.now });
  const homeFingerprint = context.homeFingerprint ?? base.codexSession?.homeFingerprint;
  return {
    ...base,
    engine: 'codex',
    status: facts.status,
    savedAt: context.now.toISOString(),
    savedByHost: context.host,
    git: { ...base.git, branch: facts.branch ?? base.git.branch, headCommit: facts.headCommit },
    changedFiles: union(base.changedFiles, facts.changedFiles),
    checks: [...base.checks, ...facts.checks.map((check) => codexCheck(check, context.now))],
    latestFeedback: mergeFeedback(base.latestFeedback, facts.feedback),
    unresolvedQuestions: facts.unanswered,
    uncertainOperations: facts.uncertain,
    codexSession: homeFingerprint ? { ...facts.session, homeFingerprint } : { ...facts.session },
  };
}

/** What a stopped run of Clarvis's own engine hands on (design §6.2 steps 3 and 4). */
export interface ClarvisStopFacts {
  branch: string;
  headCommit: string;
  changedFiles: string[];
  diffStat: DiffStat[];
  /** What is still uncommitted: the owner's own files. */
  dirty: string[];
  checks: CheckRecord[];
  /** Typed to the run and never taken in. */
  typed: string[];
  /** The step question on screen when it stopped. */
  question?: string;
  /** The tool call under way when it stopped. */
  interrupted?: UncertainOperation;
  lockId?: string;
}

/** A stopped Clarvis-engine run's facts as the checkpoint, on the task's own record. */
export function checkpointFromClarvis(base: TaskCheckpoint, facts: ClarvisStopFacts, context: CheckpointContext): TaskCheckpoint {
  const questions: OpenQuestion[] = facts.question ? [{ engine: 'clarvis', summary: facts.question }] : [];
  const typedNotes: FeedbackNote[] = facts.typed.map((text) => ({ text, typedAt: context.now.toISOString(), host: context.host, delivered: false }));
  return {
    ...base,
    engine: 'clarvis',
    status: 'transferring',
    savedAt: context.now.toISOString(),
    savedByHost: context.host,
    git: { ...base.git, branch: facts.branch, headCommit: facts.headCommit, dirty: facts.dirty, diffStat: facts.diffStat },
    changedFiles: union(base.changedFiles, facts.changedFiles),
    checks: [...base.checks, ...facts.checks],
    latestFeedback: mergeFeedback(base.latestFeedback, typedNotes),
    unresolvedQuestions: questions,
    uncertainOperations: facts.interrupted ? [facts.interrupted] : [],
    ...(facts.lockId ? { lock: { id: facts.lockId, kind: 'clarvis_run' as const } } : {}),
  };
}

/** The saved record, only when it is this task's, in this folder. */
function sameTask(saved: TaskCheckpoint | undefined, taskId: string, context: CheckpointContext): TaskCheckpoint | undefined {
  return saved && saved.taskId === taskId && saved.workspaceRoot === context.workspaceRoot ? saved : undefined;
}

function codexCheck(check: CheckRun, now: Date): CheckRecord {
  return { command: check.command, exitCode: check.exitCode, engine: 'codex', ranAt: now.toISOString(), outputTail: check.outputTail };
}

/** Notes already kept, then new ones — the same words typed at the same moment are one note. */
function mergeFeedback(kept: FeedbackNote[], added: FeedbackNote[]): FeedbackNote[] {
  const key = (note: FeedbackNote) => `${note.typedAt}\0${note.text}`;
  const seen = new Set(kept.map(key));
  return [...kept, ...added.filter((note) => !seen.has(key(note)))];
}

function union(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])];
}
