/**
 * One writer per project, for a run of Clarvis's own engine (plan.md M15, C2a; design §5.1, §6.3;
 * `lock-rule-cases.json` lock_file and fence).
 *
 * **Behaviour change, stated plainly.** Until M15, two editors could each run Clarvis's engine in the same
 * project at once. Now a writing run takes the project's lock first, so the second editor is told another
 * window is working instead of both editing the same files. Read-only answers take no lock.
 *
 * **Taking it** (the order is the contract's): create the checkout lock file atomically, then take RAVIS's
 * lock. If RAVIS refuses — a Codex task or another window holds the project — the file is removed again
 * and the run is refused with who holds it. Both are heartbeaten every 15 s.
 *
 * **When RAVIS isn't there.** No RAVIS configured, or RAVIS not answering, leaves the run on the lock file
 * alone — the floor — and a run that couldn't reach RAVIS re-registers, with `adopt_file_lock`, as soon as
 * it answers. A `422` for the folder (outside RAVIS's allowed roots, or a protected repository) means RAVIS
 * doesn't govern this folder at all: the file keeps the one-writer rule, and RAVIS isn't asked again.
 *
 * **Finding the file already there.** A Codex session's file is never taken: the owner follows that task
 * instead. A file naming this very window is a leftover of an earlier run here that didn't release, and is
 * replaced — unless this extension host holds it right now, in which case a run is already going here.
 * Another window's file is judged by the shared lock rule: `alive` and working is refused; `unresponsive`,
 * or waiting on its owner, is refused with the offer to take over, which the owner confirms (`takeover.ts`);
 * `gone` is replaced — once the command it recorded as running, with its whole process group and every
 * descendant, has been stopped and confirmed gone (`groupKill.ts`). A command that won't stop, or whose
 * state couldn't be checked, keeps the file where it is and the run refused, naming it. The caller learns
 * whose file was replaced (`replaced`), because the new holder continues that task rather than sweeping its
 * leftovers into a new one (design §6.3, review AL3).
 *
 * **The fence** (`stillHolds`). False only on evidence of loss: a heartbeat answered `409 LEASE_REVOKED`,
 * or a lock file that no longer names this window. RAVIS not answering is never loss. Before a commit the
 * heartbeat is sent first, so a takeover a moment ago is seen before the write that matters most.
 *
 * **Letting go** is in reverse order, once the run's processes are gone — and never by a holder that lost
 * the lock: that one closes its descriptor and deletes nothing, because the file is someone else's now.
 *
 * vscode-free. Process probes default to `ps` (`processProbe.ts`); tests hand in their own.
 */

import * as fs from 'fs';
import type { RunFence } from '../CodingRun';
import { clockTime } from '../codex/translate';
import { freshKey } from '../relay/idempotency';
import type { RelayFailure } from '../relay/relayFailure';
import type { AcquireLockBody, Host, LockView, RunningCommand } from '../relay/relayTypes';
import { createLockFile, lockFilePath, readLockFile, type HeldLockFile, type LockFileContent, type LockFileRead } from './fileLock';
import { gitDirForRelay } from './gitDir';
import { stopCommandGroup, type GroupStop, type Survivor } from './groupKill';
import { fenceHolds, type HeartbeatResult, type LockClient } from './lockClient';
import { judgeLock, onFindingALock, type Verdict } from './lockRule';
import { observerAwakeSeconds, probeProcess } from './processProbe';

export const HEARTBEAT_MS = 15_000;
/** A run waits this long for RAVIS's lock routes before carrying on with the file alone. */
const RAVIS_TIMEOUT_MS = 3_000;

export interface ProjectLockDeps {
  root: string;
  /** The checkout's git folder (`gitDir.ts`), or undefined for a root without one. */
  gitDir: string | undefined;
  taskId: string;
  window: { id: string; host: Host };
  pid: number;
  /** This extension host's `ps -o lstart=`. */
  pidStart: string;
  /** RAVIS's lock API; absent when no RAVIS is configured for this window. */
  locks?: LockClient;
  judge?: (content: LockFileContent, heartbeatAgeSeconds: number) => Promise<Verdict | undefined>;
  /** Stops a gone holder's recorded command with its group and descendants, and confirms (`groupKill.ts`). */
  stopGroup?: (command: RunningCommand) => Promise<GroupStop>;
  /**
   * Registers the file lock with RAVIS as an adoption (`adopt_file_lock`), replacing a lock row RAVIS marked
   * superseded at a restart: the reconcile a window does for a Codex task a gone window left paused (F-A9).
   */
  adopt?: boolean;
  waitingOnYou?: () => boolean;
  now?: () => Date;
  log?: (line: string) => void;
  every?: (ms: number, tick: () => void) => () => void;
}

export interface LockRefusal {
  line: string;
  /** A Codex session holds the project: follow it instead. */
  attachSessionId?: string;
}

/** A gone window's lock file this run replaced: its task is the one to continue (review AL3). */
export interface ReplacedHolder {
  taskId: string;
  windowId: string | null;
  host: string;
  since: string;
}

export type LockOutcome = { held: true; lock: ProjectLock; replaced?: ReplacedHolder } | ({ held: false } & LockRefusal);

/** Lock files this extension host holds right now. */
const HELD_HERE = new Set<string>();

const since = (value: string) => (value ? `, since ${clockTime(value)}` : '');

export const LOCK_LINES = {
  codex: 'Codex is already working on this project.',
  here: 'Clarvis is already working on this project in this window.',
  working: (host: string, from: string) => `Another Clarvis window (${host}${since(from)}) is working on this project. Stop it there first.`,
  stalled: (host: string, from: string) =>
    `Another Clarvis window (${host}${since(from)}) holds this project but isn't answering, or is waiting on you there. Stop it there, or close that window, then try again.`,
  unjudged: "Another Clarvis window holds this project, and whether it's still working couldn't be checked, so nothing was started.",
  command: (command: RunningCommand) =>
    `A command from a Clarvis window that closed may still be running (\`${command.comm}\`, pid ${command.pid}), and whether it stopped couldn't be checked, so nothing was started.`,
  survivors: (survivors: Survivor[]) =>
    `A command from a Clarvis window that closed is still running and wouldn't stop: ${survivors
      .map((survivor) => `\`${survivor.comm}\` (pid ${survivor.pid})`)
      .join(', ')}. Nothing was started.`,
  nested: 'A folder inside or around this project is locked by another task, so nothing was started.',
  unreadable: (detail: string) => `This project's lock file can't be read right now (${detail}), so nothing was started.`,
  failed: (detail: string) => `This project's lock file couldn't be created (${detail}), so nothing was started.`,
  race: 'Another window took this project at the same moment, so nothing was started.',
};

/** Takes the project for a run of Clarvis's own engine, or says who has it. */
export async function takeProjectLock(deps: ProjectLockDeps): Promise<LockOutcome> {
  const file = lockFilePath(deps.root, deps.gitDir);
  const created = await createFileLock(file, deps);
  if ('line' in created) return { held: false, ...created };
  const lock = new ProjectLock(deps, created.lock);
  const refused = await lock.register(deps.adopt === true);
  if (refused) {
    lock.dropFile();
    return { held: false, ...refused };
  }
  lock.startHeartbeat();
  return created.replaced ? { held: true, lock, replaced: holderOf(created.replaced) } : { held: true, lock };
}

export class ProjectLock implements RunFence {
  private lease: { id: string; token: string } | undefined;
  private lastBeat: HeartbeatResult | undefined;
  private running: RunningCommand | null = null;
  private cancelBeat: (() => void) | undefined;
  private ravisGoverns: boolean;
  /** Evidence of loss stays evidence: a later heartbeat RAVIS doesn't answer can't undo it. */
  private lost = false;
  private readonly logged = new Set<string>();

  constructor(
    private readonly deps: ProjectLockDeps,
    private readonly file: HeldLockFile
  ) {
    this.ravisGoverns = deps.locks !== undefined;
  }

  /** RAVIS's lock id once RAVIS holds the lock for this run. */
  get ravisLockId(): string | undefined {
    return this.lease?.id;
  }

  get lockFile(): string {
    return this.file.file;
  }

  async stillHolds(moment: 'tool' | 'commit'): Promise<boolean> {
    if (moment === 'commit') await this.beat();
    return this.holds();
  }

  commandStarted(command: RunningCommand): void {
    this.running = command;
    this.writeFile();
  }

  commandEnded(): void {
    this.running = null;
    this.writeFile();
  }

  /** Lets go, once the run's processes are gone. A holder that lost the lock deletes nothing. */
  async release(): Promise<'released' | 'lost' | 'unknown'> {
    this.cancelBeat?.();
    if (!this.holds()) return this.letGoLost();
    if (this.lease) await this.releaseRavis(this.lease);
    const released = this.file.release();
    if (released !== 'unknown') HELD_HERE.delete(this.file.file);
    return released;
  }

  /** Takes RAVIS's lock, or adopts the file lock into it once RAVIS is back. A refusal only when RAVIS refuses. */
  async register(adopt: boolean): Promise<LockRefusal | undefined> {
    const locks = this.deps.locks;
    if (!locks || !this.ravisGoverns) return undefined;
    const outcome = await locks.acquire(acquireBody(this.deps, adopt), freshKey(), { timeoutMs: RAVIS_TIMEOUT_MS });
    if (!outcome.ok) return this.notRegistered(outcome.failure, adopt);
    this.lease = { id: outcome.value.lock.id, token: outcome.value.lease_token };
    this.writeFile();
    return undefined;
  }

  startHeartbeat(): void {
    this.cancelBeat = (this.deps.every ?? every)(HEARTBEAT_MS, () => void this.beat());
  }

  /** Removes the file this run created, when RAVIS refused the run. */
  dropFile(): void {
    this.file.release();
    HELD_HERE.delete(this.file.file);
  }

  private holds(): boolean {
    if (this.lost) return false;
    if (fenceHolds(this.lastBeat, this.file.check())) return true;
    this.lost = true;
    return false;
  }

  /** A holder that lost the lock closes its descriptor and leaves the file to whoever has the project. */
  private letGoLost(): 'lost' {
    this.file.abandon();
    HELD_HERE.delete(this.file.file);
    return 'lost';
  }

  private async beat(): Promise<void> {
    if (this.lost) return;
    this.writeFile();
    if (!this.lease) {
      await this.register(true);
      return;
    }
    const body = { waiting_on_you: this.waiting(), state: 'running', running_command: this.running };
    const locks = this.deps.locks as LockClient;
    this.lastBeat = await locks.heartbeat(this.lease.id, this.lease.token, body, { timeoutMs: RAVIS_TIMEOUT_MS });
    if (this.lastBeat.kind !== 'revoked') return;
    this.lost = true;
    this.logOnce('revoked', `lock: another window took this project over (${this.lastBeat.takenOverBy ?? 'unnamed'})`);
  }

  private writeFile(): void {
    // A holder that lost the lock never rewrites it, even while the file still names this window.
    if (this.lost) return;
    const update = { running_command: this.running, waitingOnYou: this.waiting(), ravis_lock_id: this.lease?.id ?? null };
    if (this.file.heartbeat(update, this.now()) !== 'lost') return;
    this.lost = true;
    this.logOnce('file', 'lock: the lock file no longer names this window');
  }

  private notRegistered(failure: RelayFailure, adopt: boolean): LockRefusal | undefined {
    if (failure.kind === 'refused' && failure.status === 422) return this.ungoverned(failure.code);
    const locked = failure.kind === 'refused' && (failure.code === 'PROJECT_LOCKED' || failure.code === 'NESTED_PROJECT_LOCKED');
    if (locked && !adopt) return ravisRefusal(failure as Extract<RelayFailure, { kind: 'refused' }>);
    this.logOnce(`register:${failure.kind}`, `lock: RAVIS didn't take the lock (${failure.kind}); the lock file keeps one writer meanwhile`);
    return undefined;
  }

  private ungoverned(code: string | null): undefined {
    this.ravisGoverns = false;
    this.logOnce('ungoverned', `lock: RAVIS doesn't keep locks for this folder (${code ?? 'HTTP 422'}); the lock file keeps one writer`);
    return undefined;
  }

  private async releaseRavis(lease: { id: string; token: string }): Promise<void> {
    const locks = this.deps.locks as LockClient;
    const released = await locks.release(lease.id, lease.token, true, { timeoutMs: RAVIS_TIMEOUT_MS });
    if (!released.ok) this.logOnce('release', `lock: RAVIS didn't take the release (${released.failure.kind}); its lock will age out`);
  }

  private waiting(): boolean {
    return this.deps.waitingOnYou?.() ?? false;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private logOnce(key: string, line: string): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    this.deps.log?.(line);
  }
}

/** The lock file, created — replacing a stale one when the rule allows — or why not. */
async function createFileLock(file: string, deps: ProjectLockDeps): Promise<{ lock: HeldLockFile; replaced?: LockFileContent } | LockRefusal> {
  const first = createLockFile(file, contentFor(deps));
  if (first.ok) return { lock: hold(first.lock) };
  if (first.reason === 'failed') return { line: LOCK_LINES.failed(first.detail) };
  const refusal = await decideOnExisting(file, first.existing, deps);
  if (refusal) return refusal;
  const second = createLockFile(file, contentFor(deps));
  if (!second.ok) return { line: LOCK_LINES.race };
  const replaced = first.existing.kind === 'present' ? first.existing.content : undefined;
  return { lock: hold(second.lock), replaced };
}

function holderOf(content: LockFileContent): ReplacedHolder {
  return { taskId: content.taskId, windowId: content.holder.window_id, host: content.holder.host, since: content.holder.since };
}

function hold(lock: HeldLockFile): HeldLockFile {
  HELD_HERE.add(lock.file);
  return lock;
}

/** Undefined once a stale file is out of the way; otherwise why the run can't have the project. */
async function decideOnExisting(file: string, read: LockFileRead, deps: ProjectLockDeps): Promise<LockRefusal | undefined> {
  if (read.kind === 'absent') return undefined;
  if (read.kind === 'unreadable') return { line: LOCK_LINES.unreadable(read.detail) };
  const refusal = await refusalFor(file, read.content, read.heartbeatAgeSeconds, deps);
  if (!refusal) removeIfUnchanged(file, read.content);
  return refusal;
}

async function refusalFor(file: string, content: LockFileContent, ageSeconds: number, deps: ProjectLockDeps): Promise<LockRefusal | undefined> {
  const holder = content.holder;
  if (holder.kind === 'codex_session') return { line: LOCK_LINES.codex, attachSessionId: holder.session_id ?? undefined };
  if (holder.window_id === deps.window.id && holder.pid === deps.pid) return HELD_HERE.has(file) ? { line: LOCK_LINES.here } : undefined;
  const verdict = await (deps.judge ?? judgeHolder)(content, ageSeconds);
  return verdict === undefined ? { line: LOCK_LINES.unjudged } : otherWindow(content, verdict, deps);
}

async function otherWindow(content: LockFileContent, verdict: Verdict, deps: ProjectLockDeps): Promise<LockRefusal | undefined> {
  const outcome = onFindingALock('clarvis_run', verdict, content.waitingOnYou);
  if (outcome === 'refuse') return { line: LOCK_LINES.working(content.holder.host, content.holder.since) };
  if (outcome !== 'reconcile') return { line: LOCK_LINES.stalled(content.holder.host, content.holder.since) };
  return reconcileGone(content.running_command, deps);
}

/**
 * A gone window's file may go only once the command it recorded is stopped — group, descendants and all —
 * and confirmed gone (design §6.3; final check F-A4). Not knowing is not gone: the file stays.
 */
async function reconcileGone(command: RunningCommand | null, deps: ProjectLockDeps): Promise<LockRefusal | undefined> {
  if (!command) return undefined;
  const stopped = await (deps.stopGroup ?? ((recorded: RunningCommand) => stopCommandGroup(recorded)))(command);
  if (stopped.gone === true) {
    deps.log?.(`lock: stopped the closed window's command \`${command.comm}\` (pid ${command.pid}) and ${stopped.signalled - 1} process(es) it started`);
    return undefined;
  }
  return stopped.gone === false ? { line: LOCK_LINES.survivors(stopped.survivors) } : { line: LOCK_LINES.command(command) };
}

/** Deletes the file judged stale — only if it is still exactly that file's holder and heartbeat. */
function removeIfUnchanged(file: string, judged: LockFileContent): void {
  const now = readLockFile(file);
  if (now.kind !== 'present' || now.content.heartbeatAt !== judged.heartbeatAt) return;
  if (JSON.stringify(now.content.holder) !== JSON.stringify(judged.holder)) return;
  fs.rmSync(file, { force: true });
}

function ravisRefusal(failure: Extract<RelayFailure, { kind: 'refused' }>): LockRefusal {
  if (failure.code === 'NESTED_PROJECT_LOCKED') return { line: LOCK_LINES.nested };
  return lockViewRefusal(failure.details.lock as LockView | undefined);
}

/** Who RAVIS says holds the project, as the refusal the owner reads. */
function lockViewRefusal(lock: LockView | undefined): LockRefusal {
  if (!lock) return { line: LOCK_LINES.stalled('another editor', '') };
  const { holder } = lock;
  if (holder.kind === 'codex_session') return { line: LOCK_LINES.codex, attachSessionId: holder.session_id ?? undefined };
  const describe = lock.verdict === 'alive' && !lock.waiting_on_you ? LOCK_LINES.working : LOCK_LINES.stalled;
  return { line: describe(holder.host, holder.since) };
}

function contentFor(deps: ProjectLockDeps): LockFileContent {
  const at = (deps.now ?? (() => new Date()))().toISOString();
  return {
    version: 3,
    ravis_lock_id: null,
    taskId: deps.taskId,
    engine: 'clarvis',
    state: 'running',
    holder: { kind: 'clarvis_run', session_id: null, pid: deps.pid, pid_start: deps.pidStart, window_id: deps.window.id, host: deps.window.host, since: at },
    heartbeatAt: at,
    waitingOnYou: false,
    leftover: [],
    takenOverFrom: null,
    running_command: null,
  };
}

function acquireBody(deps: ProjectLockDeps, adopt: boolean): AcquireLockBody {
  const holder = { kind: 'clarvis_run' as const, window_id: deps.window.id, host: deps.window.host, pid: deps.pid, pid_start: deps.pidStart };
  const body: AcquireLockBody = { workspace_root: deps.root, clarvis_task_id: deps.taskId, holder, git_dir: gitDirForRelay(deps.root, deps.gitDir) };
  return adopt ? { ...body, adopt_file_lock: true } : body;
}

/** The shared lock rule applied to a lock file's holder, with this Mac's `ps` and wake time. */
async function judgeHolder(content: LockFileContent, heartbeatAgeSeconds: number): Promise<Verdict | undefined> {
  const [probe, awake] = await Promise.all([probeProcess(content.holder.pid), observerAwakeSeconds()]);
  if (!probe || awake === undefined) return undefined;
  const lock = { pid: content.holder.pid, pid_start: content.holder.pid_start, heartbeat_age_seconds: heartbeatAgeSeconds };
  return judgeLock(lock, probe, awake);
}

function every(ms: number, tick: () => void): () => void {
  const timer = setInterval(tick, ms);
  // A heartbeat is never a reason for the extension host, or a test, to stay alive.
  timer.unref();
  return () => clearInterval(timer);
}
