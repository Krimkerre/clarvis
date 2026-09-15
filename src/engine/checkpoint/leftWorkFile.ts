/**
 * The record of runs Clarvis's own engine left on their branches (plan.md M15, "Build on Clarvis's own earlier work"; the
 * owner's decision of 15 Sep 2026, "Give Clarvis's own engine the same question").
 *
 * **Why a record at all.** Codex's left work is found through RAVIS, which keeps each idle task and names its branch. A
 * run of Clarvis's own engine keeps nothing once it ends. Its branch is a `clarvis/<task>` like Codex's, so the name
 * doesn't say which engine made it, and its files may still be uncommitted. So a run that ends on its own branch writes
 * down what the question and the next run's brief need:
 * - which branch it was, and the tip it left;
 * - the task as it was asked, and what the run said when it ended;
 * - the branch it started from;
 * - its own files (what it wrote, minus the owner's files already in flight when it started);
 * - the content, as a SHA-256, of each of its own files it left uncommitted. A file whose content no longer matches was
 *   changed after the run ended, so it isn't only the run's work any more.
 *
 * **Where, and who writes it**, as for the checkpoint (`checkpointFile.ts`): `<git dir>/clarvis-left-work.json`, beside
 * `clarvis-task-checkpoint.json`. It sits inside `.git`, so it is never committed, and both editors on this Mac (the
 * browser editor and desktop VS Code) read the same file, across window reloads. It is 0600, written whole or not at all,
 * and only while this window holds the project lock. A folder without git has no branches, so it has no record.
 *
 * **One run per branch**, the most recent first, at most twenty. **What it never holds:** tokens, keys or leases. The
 * summary is put through `redactSecrets`, and every text and list is capped.
 *
 * vscode-free.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Host } from '../relay/relayTypes';
import { writeWhole, type CheckpointWrite } from './checkpointFile';
import { redactSecrets } from './taskCheckpoint';

export const LEFT_WORK_VERSION = 1;
/** The most runs kept: one per branch, the most recent first. */
export const MOST_LEFT_RUNS = 20;
/** Past this size the oldest runs are dropped until the record fits. */
const MOST_BYTES = 256 * 1024;
const LIMITS = { task: 4_000, summary: 2_000, files: 200 };

/** One of a run's own files it left uncommitted, and its content then: `null` when the run left it deleted. */
export interface LeftFile {
  path: string;
  sha256: string | null;
}

/** A run of Clarvis's own engine that ended on its own branch. */
export interface LeftRun {
  branch: string;
  taskId: string;
  /** The task as it was asked. */
  task: string;
  /** What the run said when it ended, redacted. */
  summary: string;
  /** The branch the run started from, when it was known. */
  startedFrom?: string;
  /** The branch's tip when the run ended. */
  headCommit: string;
  /** The run's own files: what it wrote, minus `inFlightAtStart`. */
  files: string[];
  /** The owner's files already changed when the run started: never the run's, whatever it did to them. */
  inFlightAtStart: string[];
  /** The run's own files still uncommitted when it ended, with their content then. */
  uncommitted: LeftFile[];
  endedAt: string;
  host: Host;
}

export interface LeftWorkRecord {
  version: typeof LEFT_WORK_VERSION;
  /** The realpath of the folder this record belongs to. */
  workspaceRoot: string;
  runs: LeftRun[];
}

export function leftWorkPath(gitDir: string): string {
  return path.join(gitDir, 'clarvis-left-work.json');
}

export type LeftWorkRead =
  | { kind: 'absent' }
  | { kind: 'found'; record: LeftWorkRecord }
  /** Written for another folder: never read as this one's. */
  | { kind: 'other_project' }
  /** There, but not readable as a record: nothing is offered from it. */
  | { kind: 'unreadable'; detail: string };

export function readLeftWork(workspaceRoot: string, gitDir: string): LeftWorkRead {
  let text: string;
  try {
    text = fs.readFileSync(leftWorkPath(gitDir), 'utf8');
  } catch (error) {
    const code = errno(error);
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', detail: code };
  }
  const value = parseJson(text);
  if (!isRecord(value)) return { kind: 'unreadable', detail: 'not a record of left work' };
  return value.workspaceRoot === workspaceRoot ? { kind: 'found', record: value } : { kind: 'other_project' };
}

/** Writes the record if this window still holds the project lock. */
export async function writeLeftWork(workspaceRoot: string, gitDir: string, record: LeftWorkRecord, stillHolds: () => Promise<boolean>): Promise<CheckpointWrite> {
  // Another folder's record is never written into this one's git folder.
  if (record.workspaceRoot !== workspaceRoot) return { kind: 'failed', detail: 'the record belongs to another folder' };
  if (!(await stillHolds())) return { kind: 'fenced' };
  const { text, bytes } = encodeLeftWork(record);
  return writeWhole(leftWorkPath(gitDir), text, bytes);
}

/** The file's text: every run capped, and the oldest dropped while it is still too large. */
export function encodeLeftWork(record: LeftWorkRecord): { text: string; bytes: number } {
  let runs = record.runs.slice(0, MOST_LEFT_RUNS).map(capRun);
  let text = render(record, runs);
  while (Buffer.byteLength(text) > MOST_BYTES && runs.length > 1) {
    runs = runs.slice(0, -1);
    text = render(record, runs);
  }
  return { text, bytes: Buffer.byteLength(text) };
}

/** The record with `run` first, replacing any earlier run on the same branch. Another folder's record isn't built on. */
export function withLeftRun(record: LeftWorkRecord | undefined, run: LeftRun, workspaceRoot: string): LeftWorkRecord {
  const kept = record?.workspaceRoot === workspaceRoot ? record.runs.filter((other) => other.branch !== run.branch) : [];
  return { version: LEFT_WORK_VERSION, workspaceRoot, runs: [run, ...kept].slice(0, MOST_LEFT_RUNS) };
}

/** The record without the runs on these branches: merged, deleted, or no longer holding that run's work. */
export function withoutLeftRuns(record: LeftWorkRecord, branches: readonly string[]): LeftWorkRecord {
  return { ...record, runs: record.runs.filter((run) => !branches.includes(run.branch)) };
}

function render(record: LeftWorkRecord, runs: LeftRun[]): string {
  return `${JSON.stringify({ version: LEFT_WORK_VERSION, workspaceRoot: record.workspaceRoot, runs }, null, 2)}\n`;
}

function capRun(run: LeftRun): LeftRun {
  return {
    ...run,
    task: clip(run.task, LIMITS.task),
    summary: clip(redactSecrets(run.summary), LIMITS.summary),
    files: run.files.slice(0, LIMITS.files),
    inFlightAtStart: run.inFlightAtStart.slice(0, LIMITS.files),
    uncommitted: run.uncommitted.slice(0, LIMITS.files),
  };
}

function isRecord(value: unknown): value is LeftWorkRecord {
  const record = value as Partial<LeftWorkRecord> | null;
  return !!record && record.version === LEFT_WORK_VERSION && typeof record.workspaceRoot === 'string' && Array.isArray(record.runs) && record.runs.every(isRun);
}

/** One malformed run makes the whole record unreadable: nothing is offered from a record that can't be trusted. */
function isRun(value: unknown): boolean {
  const run = value as Partial<LeftRun> | null;
  if (!run || ![run.branch, run.taskId, run.task, run.summary, run.headCommit, run.endedAt].every(isText)) return false;
  return areTexts(run.files) && areTexts(run.inFlightAtStart) && Array.isArray(run.uncommitted) && run.uncommitted.every(isLeftFile);
}

function isLeftFile(value: unknown): boolean {
  const file = value as Partial<LeftFile> | null;
  return !!file && typeof file.path === 'string' && (file.sha256 === null || typeof file.sha256 === 'string');
}

function isText(value: unknown): boolean {
  return typeof value === 'string';
}

function areTexts(value: unknown): boolean {
  return Array.isArray(value) && value.every(isText);
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function errno(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? String(error);
}
