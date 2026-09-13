/**
 * The checkpoint: what another engine needs to carry an unfinished task on (plan.md M15, C3; design §6.1).
 *
 * **What it is for.** A task can move between Clarvis's own engine and Codex, in either direction, and between
 * editors — started in the browser editor, picked up in desktop VS Code. The engine that carries it on needs
 * more than the branch: what was asked, how far it got, what the owner said meanwhile, what was asked and never
 * answered, what may or may not have happened, and which Codex thread it was. That is this record.
 *
 * **Where it lives, and who writes it** (`checkpointFile.ts`): in the checkout's git folder, never committed,
 * written only by the window holding the project lock. **What it never holds:** tokens, leases or keys —
 * nothing that grants anything — and it is never sent to NERVIS or the Bridge. Output tails and summaries are
 * put through `redactSecrets`, and every list and text is capped, so the file stays under 64 KB.
 *
 * **It belongs to one project.** `workspaceRoot` is the realpath of the folder it was written for. A checkpoint
 * that names another folder is never read as this one's, so a task is never carried on — and nothing is
 * committed — on another project's branch.
 *
 * **Where this differs from design §6.1's sketch**, each forced by what exists:
 * - `task`, `plan.fromPlan` and `plan.steps`: the destination needs the brief and the plan's steps, or the
 *   progress bar and plan ticking stop after a switch (the planning build hand-off contract);
 * - `requirements.checks`: the milestone's `- Check:` lines, beside the exclusions and rejected choices;
 * - `codexSession.homeFingerprint` rather than an account fingerprint: `GET /api/v1/codex` serves no
 *   comparable account fingerprint (`account.fingerprint` is a strength word, `fingerprint_matches` a yes or
 *   no), only the Codex home's; a resume also requires `fingerprint_matches` (`transferState.ts`);
 * - `workspaceRoot`: the cross-project guard above.
 *
 * Pure.
 */

import type { EngineKind } from '../CodingRun';
import type { HolderKind, Host } from '../relay/relayTypes';

export const CHECKPOINT_VERSION = 3;
export const CHECKPOINT_MAX_BYTES = 64 * 1024;

export type CheckpointStatus = 'running' | 'settled' | 'interrupted' | 'uncertain' | 'transferring' | 'leftover';

/** Where a switch between engines has got to (design §6.2). */
export type TransferStep = 'stopping' | 'confirming' | 'settling' | 'saved' | 'starting' | 'started' | 'failed';

/** Something the owner typed for the task, and whether an engine has taken it in. */
export interface FeedbackNote {
  text: string;
  typedAt: string;
  host: string;
  delivered: boolean;
}

/** A command an engine ran as a check, and how it ended. */
export interface CheckRecord {
  command: string;
  exitCode: number | null;
  engine: EngineKind;
  ranAt: string;
  outputTail: string;
}

/** A question or approval that was open when the task stopped. Never answered for the next engine. */
export interface OpenQuestion {
  engine: EngineKind;
  summary: string;
}

/** Something that was under way when the task stopped, and may or may not have happened. Never repeated blindly. */
export interface UncertainOperation {
  kind: 'command' | 'fileChange';
  summary: string;
  state: 'unknown' | 'failed';
}

export interface DiffStat {
  path: string;
  added: number;
  removed: number;
}

export interface TransferState {
  from: EngineKind;
  to: EngineKind;
  toModel: string;
  startedAt: string;
  step: TransferStep;
  error?: string;
}

/** The Codex session and thread a task used, so a switch back reuses or resumes it (review AH4). */
export interface CodexThreadRef {
  id: string;
  threadId?: string;
  lastTurnId?: string;
  lastTurnStatus: 'completed' | 'interrupted' | 'failed' | 'unknown';
  runtimeSha256?: string;
  model?: string;
  /** The commit Codex last saw: a catch-up describes what changed since. */
  sawHeadCommit?: string;
  /** `GET /api/v1/codex` `home.fingerprint` when the thread was used. */
  homeFingerprint?: string;
}

export interface TaskCheckpoint {
  version: typeof CHECKPOINT_VERSION;
  taskId: string;
  /** The realpath of the folder this task belongs to. */
  workspaceRoot: string;
  savedAt: string;
  savedByHost: Host;
  engine: EngineKind;
  status: CheckpointStatus;
  /** The brief the task was started with. */
  task: string;
  plan: {
    file: 'plan.md';
    fromPlan: boolean;
    steps: string[];
    uncheckedSteps: string[];
    milestone?: { index: number; title: string };
    nextAction?: string;
  };
  requirements: { checks: string[]; exclusions: string[]; rejected: string[] };
  git: { branch?: string; baseBranch?: string; baseCommit?: string; headCommit?: string; dirty: string[]; diffStat: DiffStat[] };
  changedFiles: string[];
  checks: CheckRecord[];
  latestFeedback: FeedbackNote[];
  unresolvedQuestions: OpenQuestion[];
  uncertainOperations: UncertainOperation[];
  leftoverProcesses?: { pid: number; start: string; comm: string }[];
  /** The coding model before a switch, so switching back knows where to go. */
  previousModel?: string;
  lock?: { id: string; kind: HolderKind };
  codexSession?: CodexThreadRef;
  transfer?: TransferState;
}

/** What starting a record needs; everything else starts empty. */
export interface CheckpointStart {
  taskId: string;
  workspaceRoot: string;
  host: Host;
  engine: EngineKind;
  task: string;
  now: Date;
  plan?: Partial<TaskCheckpoint['plan']>;
  requirements?: Partial<TaskCheckpoint['requirements']>;
  git?: Partial<TaskCheckpoint['git']>;
  previousModel?: string;
}

export function newCheckpoint(start: CheckpointStart): TaskCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    taskId: start.taskId,
    workspaceRoot: start.workspaceRoot,
    savedAt: start.now.toISOString(),
    savedByHost: start.host,
    engine: start.engine,
    status: 'running',
    task: start.task,
    plan: { file: 'plan.md', fromPlan: false, steps: [], uncheckedSteps: [], ...start.plan },
    requirements: { checks: [], exclusions: [], rejected: [], ...start.requirements },
    git: { dirty: [], diffStat: [], ...start.git },
    changedFiles: [],
    checks: [],
    latestFeedback: [],
    unresolvedQuestions: [],
    uncertainOperations: [],
    ...(start.previousModel ? { previousModel: start.previousModel } : {}),
  };
}

// ── Feedback ────────────────────────────────────────────────────────────────

/** Adds what was typed, once: the same words still waiting are one note, not two (review H8). */
export function withFeedback(checkpoint: TaskCheckpoint, texts: readonly string[], host: string, now: Date): TaskCheckpoint {
  const waiting = new Set(undeliveredFeedback(checkpoint));
  const added: FeedbackNote[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (text === '' || waiting.has(text)) continue;
    waiting.add(text);
    added.push({ text, typedAt: now.toISOString(), host, delivered: false });
  }
  return added.length === 0 ? checkpoint : { ...checkpoint, latestFeedback: [...checkpoint.latestFeedback, ...added] };
}

export function undeliveredFeedback(checkpoint: TaskCheckpoint): string[] {
  return checkpoint.latestFeedback.filter((note) => !note.delivered).map((note) => note.text);
}

/** Once the next engine has taken the brief or the turn that carried them, the notes are delivered. */
export function withFeedbackDelivered(checkpoint: TaskCheckpoint): TaskCheckpoint {
  return { ...checkpoint, latestFeedback: checkpoint.latestFeedback.map((note) => ({ ...note, delivered: true })) };
}

// ── Reading one back ────────────────────────────────────────────────────────

export type CheckpointParse = { ok: true; checkpoint: TaskCheckpoint } | { ok: false; reason: 'not_a_checkpoint' | 'other_project' };

const ENGINES = new Set(['clarvis', 'codex']);
const STATUSES = new Set(['running', 'settled', 'interrupted', 'uncertain', 'transferring', 'leftover']);

/** A checkpoint for `workspaceRoot`, or why the text isn't one this folder may use. */
export function parseCheckpoint(text: string, workspaceRoot: string): CheckpointParse {
  const value = parseJson(text);
  if (!looksLikeCheckpoint(value)) return { ok: false, reason: 'not_a_checkpoint' };
  if (value.workspaceRoot !== workspaceRoot) return { ok: false, reason: 'other_project' };
  return { ok: true, checkpoint: value };
}

function looksLikeCheckpoint(value: unknown): value is TaskCheckpoint {
  const checkpoint = value as Partial<TaskCheckpoint> | null;
  if (!checkpoint || checkpoint.version !== CHECKPOINT_VERSION || typeof checkpoint.taskId !== 'string') return false;
  return ENGINES.has(String(checkpoint.engine)) && STATUSES.has(String(checkpoint.status)) && hasItsParts(checkpoint);
}

function hasItsParts(checkpoint: Partial<TaskCheckpoint>): boolean {
  const texts = typeof checkpoint.workspaceRoot === 'string' && typeof checkpoint.task === 'string';
  return texts && hasItsLists(checkpoint) && typeof checkpoint.requirements === 'object' && checkpoint.requirements !== null;
}

function hasItsLists(checkpoint: Partial<TaskCheckpoint>): boolean {
  const git: Partial<TaskCheckpoint['git']> = checkpoint.git ?? {};
  const plan: Partial<TaskCheckpoint['plan']> = checkpoint.plan ?? {};
  const lists = [
    checkpoint.changedFiles,
    checkpoint.checks,
    checkpoint.latestFeedback,
    checkpoint.unresolvedQuestions,
    checkpoint.uncertainOperations,
    git.dirty,
    git.diffStat,
    plan.steps,
    plan.uncheckedSteps,
  ];
  return lists.every(Array.isArray);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ── Keeping it small and free of secrets ─────────────────────────────────────

const LIMITS = {
  task: 8_000,
  text: 500,
  feedbackText: 2_000,
  outputTail: 1_500,
  steps: 50,
  requirements: 30,
  files: 300,
  checks: 20,
  feedback: 30,
  questions: 20,
  uncertain: 20,
  processes: 20,
};

/** Every list and text cut to its limit, with summaries and output tails redacted. */
export function capCheckpoint(checkpoint: TaskCheckpoint): TaskCheckpoint {
  const capped: TaskCheckpoint = {
    ...checkpoint,
    task: clip(checkpoint.task, LIMITS.task),
    plan: capPlan(checkpoint.plan),
    requirements: capRequirements(checkpoint.requirements),
    git: { ...checkpoint.git, dirty: checkpoint.git.dirty.slice(0, LIMITS.files), diffStat: checkpoint.git.diffStat.slice(0, LIMITS.files) },
    changedFiles: checkpoint.changedFiles.slice(0, LIMITS.files),
    checks: checkpoint.checks.slice(-LIMITS.checks).map(capCheck),
    latestFeedback: capFeedback(checkpoint.latestFeedback),
    unresolvedQuestions: checkpoint.unresolvedQuestions.slice(-LIMITS.questions).map((question) => ({ ...question, summary: clipRedacted(question.summary) })),
    uncertainOperations: checkpoint.uncertainOperations.slice(-LIMITS.uncertain).map((operation) => ({ ...operation, summary: clipRedacted(operation.summary) })),
  };
  if (checkpoint.leftoverProcesses) capped.leftoverProcesses = checkpoint.leftoverProcesses.slice(0, LIMITS.processes);
  return capped;
}

/**
 * The file's text: capped, and if still over 64 KB, the bulky history — checks, the diff stat, the file lists —
 * halved until it fits. What the owner said, the open questions and the uncertain operations are never cut here.
 */
export function encodeCheckpoint(checkpoint: TaskCheckpoint): { text: string; bytes: number } {
  let current = capCheckpoint(checkpoint);
  let text = `${JSON.stringify(current, null, 2)}\n`;
  for (let round = 0; Buffer.byteLength(text) > CHECKPOINT_MAX_BYTES && round < 8; round++) {
    current = halveBulk(current);
    text = `${JSON.stringify(current, null, 2)}\n`;
  }
  return { text, bytes: Buffer.byteLength(text) };
}

function halveBulk(checkpoint: TaskCheckpoint): TaskCheckpoint {
  const half = <T>(items: T[]) => items.slice(0, Math.floor(items.length / 2));
  return {
    ...checkpoint,
    task: clip(checkpoint.task, Math.floor(checkpoint.task.length / 2)),
    checks: checkpoint.checks.slice(Math.ceil(checkpoint.checks.length / 2)),
    changedFiles: half(checkpoint.changedFiles),
    git: { ...checkpoint.git, dirty: half(checkpoint.git.dirty), diffStat: half(checkpoint.git.diffStat) },
  };
}

function capPlan(plan: TaskCheckpoint['plan']): TaskCheckpoint['plan'] {
  const steps = (list: string[]) => list.slice(0, LIMITS.steps).map((step) => clip(step, LIMITS.text));
  const nextAction = plan.nextAction === undefined ? {} : { nextAction: clip(plan.nextAction, LIMITS.text) };
  return { ...plan, steps: steps(plan.steps), uncheckedSteps: steps(plan.uncheckedSteps), ...nextAction };
}

function capRequirements(requirements: TaskCheckpoint['requirements']): TaskCheckpoint['requirements'] {
  const list = (items: string[]) => items.slice(0, LIMITS.requirements).map((item) => clip(item, LIMITS.text));
  return { checks: list(requirements.checks), exclusions: list(requirements.exclusions), rejected: list(requirements.rejected) };
}

function capCheck(check: CheckRecord): CheckRecord {
  return { ...check, command: clipRedacted(check.command), outputTail: redactSecrets(check.outputTail).slice(-LIMITS.outputTail) };
}

/** Everything not yet delivered is kept; delivered notes fill what room is left, newest first. */
function capFeedback(notes: FeedbackNote[]): FeedbackNote[] {
  const waiting = notes.filter((note) => !note.delivered).slice(-LIMITS.feedback);
  const room = LIMITS.feedback - waiting.length;
  const delivered = room > 0 ? notes.filter((note) => note.delivered).slice(-room) : [];
  const kept = new Set([...waiting, ...delivered]);
  return notes.filter((note) => kept.has(note)).map((note) => ({ ...note, text: clip(note.text, LIMITS.feedbackText) }));
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function clipRedacted(text: string): string {
  return clip(redactSecrets(text), LIMITS.text);
}

/**
 * Secrets a command's output or a request's summary can carry, and what replaces them. Deliberately broad: a
 * checkpoint loses nothing by missing a word that only looked like a key.
 */
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key removed]'],
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '[secret removed]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[secret removed]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[secret removed]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[secret removed]'],
  [/\b(?:ast|lk)_[A-Za-z0-9_-]{16,}/g, '[secret removed]'],
  [/\b(authorization\s*[:=]\s*(?:bearer\s+)?)(?!\[secret removed\])\S+/gi, '$1[secret removed]'],
  [/\b(bearer\s+)(?!\[secret removed\])\S+/gi, '$1[secret removed]'],
  [/\b((?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*)(?!\[secret removed\])\S+/gi, '$1[secret removed]'],
];

export function redactSecrets(text: string): string {
  return SECRETS.reduce((redacted, [pattern, replacement]) => redacted.replace(pattern, replacement), text);
}
