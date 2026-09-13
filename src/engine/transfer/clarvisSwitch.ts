/**
 * Clarvis's own engine in a switch: as the engine that stops, and as the engine that takes a task over from Codex
 * (plan.md M15, C3; design §6.2).
 *
 * **As the source** (Clarvis → Codex):
 * - `stopping`: the project lock is reserved for Codex with the run's lease (`ProjectLock.transfer`), and only then
 *   is the run stopped with the chat's own Stop. From here the run's lock is never released by the run itself
 *   (`ProjectLock.release` answers `held_for_transfer`; review N2);
 * - `confirming`: the run's loop has returned — its `finally` ran, so the command it had going has ended — within
 *   30 s, and the last command it started is confirmed gone with its whole process group (`groupKill.ts`);
 * - `settling`: what the run left uncommitted (a command's output, say) is committed on the task's branch, "stopped
 *   for a switch"; the owner's own files, in flight before the task began, are left alone. HEAD found off the task's
 *   branch saves nothing. What was typed and never taken in, the step question that was on screen, and a tool call
 *   that was cut off go into the checkpoint;
 * - `started`: its lock file is dropped, and its lease forgotten, never released — RAVIS gave the lock to Codex;
 * - a failure: the lock is its own again, and is let go only once the run has returned and its command is gone.
 *
 * **As the destination** (Codex → Clarvis): the checkout lock file and RAVIS's lock are taken with the transfer token
 * (the file RAVIS wrote for the Codex session being handed over may be replaced), then the run starts continuing on
 * the task's branch at the saved commit. A start that fails before any tool ran gives the lock straight back.
 *
 * vscode-free: the run, the lock and git are handed in.
 */

import { writeCheckpoint } from '../checkpoint/checkpointFile';
import type { GitFacts } from '../checkpoint/gitFacts';
import type { CheckRecord, TaskCheckpoint, UncertainOperation } from '../checkpoint/taskCheckpoint';
import type { SwitchConfirmation, SwitchResult } from '../codex/runCore';
import { stopCommandGroup, type GroupStop } from '../lock/groupKill';
import type { LockOutcome, ProjectLock } from '../lock/projectLock';
import type { Host, RunningCommand } from '../relay/relayTypes';
import type { SwitchDestination, SwitchSource } from './engineSwitch';
import { checkpointFromClarvis } from './fromSource';

/** A run of Clarvis's own engine, as a switch needs it. The chat's `RunSession` provides it. */
export interface ClarvisRunHandle {
  /** The chat's own Stop for the run: its abort, and the release of a step question. */
  stop(): void;
  /** Resolves once the run's loop has returned. */
  readonly returned: Promise<void>;
  drainInterjections(): string[];
  /** The step question on screen, read before Stop lets it go. */
  pendingQuestion(): string | undefined;
  /** A tool call that was under way when the run stopped. */
  interruptedOperation(): UncertainOperation | undefined;
  checksRun(): CheckRecord[];
  readonly result: { files: string[] };
  readonly branches: { working?: string };
}

export const CLARVIS_SWITCH_LINES = {
  didNotStop: "Clarvis's own run didn't stop within 30 seconds, so the switch didn't go ahead. It keeps the project until it does.",
  offBranch: (branch: string | undefined, head: string | undefined) =>
    `This editor is on ${head ?? 'no branch'}, not the task's branch ${branch ?? '(unknown)'}, so nothing was saved or handed over.`,
  notCommitted: (detail: string) => `What the run left uncommitted couldn't be committed (${detail}), so nothing was handed over.`,
  commandLeft: (survivors: string) => `Something the run started is still running: ${survivors}. Nothing is saved until it stops.`,
  commandUnknown: "Whether the run's last command has stopped couldn't be checked, so the switch didn't go ahead.",
};

const RETURN_TIMEOUT_MS = 30_000;
const LEFTOVER_POLL_MS = 5_000;

export interface ClarvisSourceDeps {
  lock: ProjectLock;
  run: ClarvisRunHandle;
  git: GitFacts;
  /** The task's checkpoint as it started: its brief, plan, base commit, and the owner's files in flight (`git.dirty`). */
  base: TaskCheckpoint;
  gitDir: string | undefined;
  host: Host;
  stopGroup?: (command: RunningCommand) => Promise<GroupStop>;
  returnTimeoutMs?: number;
  pollMs?: number;
  now?: () => Date;
}

export class ClarvisSource implements SwitchSource {
  readonly engine = 'clarvis' as const;
  /** Resolves once a source that stayed has let its lock go (tests wait on it). */
  releasing: Promise<void> = Promise.resolve();
  private question: string | undefined;

  constructor(private readonly deps: ClarvisSourceDeps) {}

  async stopForSwitch(): Promise<SwitchResult<{ transferToken: string }>> {
    const reserved = await this.deps.lock.transfer('codex_session');
    if (!reserved.ok) return reserved;
    this.question = this.deps.run.pendingQuestion();
    this.deps.run.stop();
    return { ok: true, value: { transferToken: reserved.token } };
  }

  async confirmStopped(): Promise<SwitchConfirmation> {
    const returned = await Promise.race([this.deps.run.returned.then(() => true), delay(this.deps.returnTimeoutMs ?? RETURN_TIMEOUT_MS).then(() => false)]);
    return returned ? this.commandGone() : { gone: undefined, line: CLARVIS_SWITCH_LINES.didNotStop };
  }

  stopLeftovers(): Promise<SwitchConfirmation> {
    return this.commandGone();
  }

  async settle(): Promise<SwitchResult<TaskCheckpoint>> {
    const { git, base, run } = this.deps;
    const branch = run.branches.working ?? base.git.branch;
    const head = await git.head();
    if (!branch || head.branch !== branch || !head.commit) return { ok: false, line: CLARVIS_SWITCH_LINES.offBranch(branch, head.branch) };
    const leftovers = (await git.dirty()).filter((file) => !base.git.dirty.includes(file) && !file.startsWith('.clarvis/'));
    const committed = leftovers.length > 0 ? await git.commitOnBranch(branch, leftovers, leftoverMessage(base.task)) : { ok: true as const, commit: head.commit };
    if (!committed.ok) return { ok: false, line: CLARVIS_SWITCH_LINES.notCommitted(committed.detail) };
    const diffStat = base.git.baseCommit ? await git.diffStat(base.git.baseCommit, committed.commit) : [];
    const facts = {
      branch,
      headCommit: committed.commit,
      changedFiles: [...run.result.files, ...leftovers],
      diffStat,
      dirty: (await git.dirty()).filter((file) => base.git.dirty.includes(file)),
      checks: run.checksRun(),
      typed: run.drainInterjections(),
      question: this.question,
      interrupted: run.interruptedOperation(),
      lockId: this.deps.lock.ravisLockId,
    };
    return { ok: true, value: checkpointFromClarvis(base, facts, { workspaceRoot: base.workspaceRoot, host: this.deps.host, now: this.now() }) };
  }

  async saveCheckpoint(checkpoint: TaskCheckpoint): Promise<boolean> {
    const written = await writeCheckpoint(this.deps.base.workspaceRoot, this.deps.gitDir, checkpoint, () => this.deps.lock.stillHolds('commit'));
    return written.kind === 'saved';
  }

  async handOn(): Promise<SwitchResult<void>> {
    return { ok: true, value: undefined };
  }

  handedOver(): void {
    this.deps.lock.handOver();
  }

  async stayed(): Promise<void> {
    this.deps.lock.transferEnded();
    this.releasing = this.releaseOnceGone();
  }

  /** After a failed switch: the run returned (its own stop committed its work), its command gone, then the lock. */
  private async releaseOnceGone(): Promise<void> {
    await this.deps.run.returned;
    while ((await this.commandGone()).gone !== true) await delay(this.deps.pollMs ?? LEFTOVER_POLL_MS);
    await this.deps.lock.release();
  }

  private async commandGone(): Promise<SwitchConfirmation> {
    const command = this.deps.lock.recordedCommand;
    if (!command) return { gone: true };
    const stopped = await (this.deps.stopGroup ?? ((recorded: RunningCommand) => stopCommandGroup(recorded)))(command);
    if (stopped.gone === true) return { gone: true };
    if (stopped.gone === undefined) return { gone: undefined, line: CLARVIS_SWITCH_LINES.commandUnknown };
    return { gone: false, leftover: CLARVIS_SWITCH_LINES.commandLeft(stopped.survivors.map((survivor) => `\`${survivor.comm}\` (pid ${survivor.pid})`).join(', ')) };
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
}

export interface ClarvisDestinationDeps {
  model: string;
  workspaceRoot: string;
  gitDir: string | undefined;
  /**
   * Takes the project with the transfer token, for the checkpoint's task (`takeProjectLock` with `transferToken`, and
   * `transferredFrom` the checkpoint's Codex session, whose checkout lock file RAVIS wrote).
   */
  take(transferToken: string, checkpoint: TaskCheckpoint): Promise<LockOutcome>;
  /** Starts the run continuing on the checkpoint's branch; resolves once it has started, or with why not. */
  run(checkpoint: TaskCheckpoint, lock: ProjectLock): Promise<SwitchResult<void>>;
}

export class ClarvisDestination implements SwitchDestination {
  readonly engine = 'clarvis' as const;
  private lock: ProjectLock | undefined;

  constructor(private readonly deps: ClarvisDestinationDeps) {}

  get model(): string {
    return this.deps.model;
  }

  async ready(): Promise<SwitchResult<void>> {
    return { ok: true, value: undefined };
  }

  async start(checkpoint: TaskCheckpoint, transferToken: string): Promise<SwitchResult<void>> {
    const taken = await this.deps.take(transferToken, checkpoint);
    if (!taken.held) return { ok: false, line: taken.line };
    this.lock = taken.lock;
    const started = await this.deps.run(checkpoint, taken.lock);
    // Refused before any tool ran (the branch was missing or moved): nothing is running, so the lock goes back.
    if (!started.ok) await taken.lock.release();
    return started;
  }

  async saveCheckpoint(checkpoint: TaskCheckpoint): Promise<boolean> {
    const lock = this.lock;
    if (!lock) return false;
    return (await writeCheckpoint(this.deps.workspaceRoot, this.deps.gitDir, checkpoint, () => lock.stillHolds('commit'))).kind === 'saved';
  }
}

function leftoverMessage(task: string): string {
  const subject = task.split('\n')[0].trim().slice(0, 60) || 'the task';
  return `Clarvis's work on ${subject} (stopped for a switch)`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
