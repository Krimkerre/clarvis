/**
 * The checkout lock file: one writer per project, even while RAVIS is down
 * (plan.md M15, C1; design §6.3; `lock-rule-cases.json` lock_file).
 *
 * **Why a file as well as RAVIS's lock.** RAVIS's project lock is the authority while RAVIS is up. The
 * file is the floor underneath it: Clarvis's own engine must stay safe when RAVIS isn't running, and
 * RAVIS and a window can agree on who holds a checkout without a network call. It lives in the
 * checkout's git folder — `<git_dir>/clarvis-engine.lock`, or `<root>/.clarvis/engine.lock` without
 * git — and is written by the process that actually writes to the project: RAVIS for a Codex
 * session, the window for a run of Clarvis's own engine.
 *
 * **The create is the lock.** `open(path, 'wx', 0o600)` either makes the file or fails because it
 * exists, atomically, whoever else tries at the same moment. There is no "check, then create".
 *
 * **Heartbeats go through the descriptor that created the file,** never by writing to the path again.
 * If another window has since replaced the file (a takeover of a holder it judged gone), a write by
 * path would overwrite the new holder's lock with the old one's; a write through the old descriptor
 * lands in the old, unlinked file, where it harms nobody. Each write is also checked first: a holder
 * whose file was replaced or deleted learns that it has lost the lock.
 *
 * **Lost means evidence, never doubt.** `check()` answers `lost` only when the file is gone, is a
 * different file, or names another holder. A file that can't be read right now — mid-write, or an I/O
 * error — is `unknown`, which the fence treats as still holding (`lockClient.ts` `fenceHolds`).
 *
 * **Padding.** The JSON is padded with trailing spaces to a whole KiB, so successive heartbeats are the
 * same size and a reader never catches the file between a rewrite and a truncate. JSON allows the
 * trailing whitespace, in JavaScript and in Python alike.
 *
 * Taking a lock over from a holder that is `gone` is not here: that needs its processes stopped and
 * confirmed first, which belongs to the run (C2a).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { HolderKind, RunningCommand } from '../relay/relayTypes';
import { sameStart } from './lockRule';

export interface LockFileHolder {
  kind: HolderKind;
  session_id: string | null;
  pid: number;
  pid_start: string;
  window_id: string | null;
  host: string;
  since: string;
}

/** The file's contents, as `lock-rule-cases.json` lock_file.example has them. */
export interface LockFileContent {
  version: 3;
  ravis_lock_id: string | null;
  taskId: string;
  engine: 'clarvis' | 'codex';
  state: string;
  holder: LockFileHolder;
  heartbeatAt: string;
  waitingOnYou: boolean;
  /** RAVIS records a Codex session's processes here; the fixtures fix no shape for an entry. */
  leftover: unknown[];
  takenOverFrom: string | null;
  running_command: RunningCommand | null;
}

/** What a heartbeat may change. The holder never changes: a new holder means a new file. */
export type LockFileUpdate = Partial<
  Pick<LockFileContent, 'ravis_lock_id' | 'state' | 'waitingOnYou' | 'leftover' | 'running_command'>
>;

export type LockFileRead =
  | { kind: 'absent' }
  | { kind: 'present'; content: LockFileContent; heartbeatAgeSeconds: number }
  | { kind: 'unreadable'; detail: string };

export type CreateOutcome =
  | { ok: true; lock: HeldLockFile }
  | { ok: false; reason: 'exists'; existing: LockFileRead }
  | { ok: false; reason: 'failed'; detail: string };

export type HoldCheck = 'holds' | 'lost' | 'unknown';

const FILE_NAME = 'clarvis-engine.lock';
const PAD_TO_BYTES = 1024;

/** Where the lock file for a checkout lives. */
export function lockFilePath(workspaceRoot: string, gitDir: string | undefined): string {
  return gitDir ? path.join(gitDir, FILE_NAME) : path.join(workspaceRoot, '.clarvis', 'engine.lock');
}

/** Takes the lock by creating the file. Exactly one of any number of simultaneous callers succeeds. */
export function createLockFile(file: string, content: LockFileContent): CreateOutcome {
  let fd: number;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    if (errno(error) === 'EEXIST') return { ok: false, reason: 'exists', existing: readLockFile(file) };
    return { ok: false, reason: 'failed', detail: errno(error) };
  }
  try {
    writeThrough(fd, content);
  } catch (error) {
    // Nobody else can have this file yet: it was created a moment ago by this call.
    fs.closeSync(fd);
    fs.rmSync(file, { force: true });
    return { ok: false, reason: 'failed', detail: errno(error) };
  }
  return { ok: true, lock: new HeldLockFile(fd, file, content) };
}

/** Reads whoever holds a checkout, and how old their heartbeat is. */
export function readLockFile(file: string, nowMs: number = Date.now()): LockFileRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return errno(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', detail: errno(error) };
  }
  const content = parseLockFile(text);
  if (!content) return { kind: 'unreadable', detail: 'not a lock file' };
  const heartbeatAgeSeconds = Math.max(0, Math.floor((nowMs - Date.parse(content.heartbeatAt)) / 1000));
  return { kind: 'present', content, heartbeatAgeSeconds };
}

export function parseLockFile(text: string): LockFileContent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return isLockFileContent(value) ? value : undefined;
}

/** The bytes written: the JSON, padded with spaces to a whole KiB. */
export function encodeLockFile(content: LockFileContent): Buffer {
  const text = JSON.stringify(content, null, 2) + '\n';
  const bytes = Buffer.byteLength(text);
  const size = Math.ceil(bytes / PAD_TO_BYTES) * PAD_TO_BYTES;
  return Buffer.from(text + ' '.repeat(size - bytes));
}

/** A lock file this process created and still has open. */
export class HeldLockFile {
  private fd: number | null;

  constructor(
    fd: number,
    readonly file: string,
    private content: LockFileContent
  ) {
    this.fd = fd;
  }

  get current(): LockFileContent {
    return this.content;
  }

  /** Whether the file at the path is still the one this holder created, still naming it. */
  check(): HoldCheck {
    if (this.fd === null) return 'lost';
    const identity = sameFile(this.fd, this.file);
    if (identity !== 'same') return identity;
    const read = readLockFile(this.file);
    if (read.kind === 'unreadable') return 'unknown';
    return read.kind === 'present' && sameHolder(read.content.holder, this.content.holder) ? 'holds' : 'lost';
  }

  /** Records a heartbeat, and any change, if the lock is still held. */
  heartbeat(update: LockFileUpdate = {}, now: Date = new Date()): 'written' | Exclude<HoldCheck, 'holds'> {
    const check = this.check();
    if (check !== 'holds') return check;
    this.content = { ...this.content, ...update, heartbeatAt: now.toISOString() };
    writeThrough(this.fd as number, this.content);
    return 'written';
  }

  /**
   * Closes the descriptor and deletes nothing (C2a). For a holder that lost the lock by RAVIS's word — a
   * revoked lease — whose file may still name it: the window that took the project over replaces the file,
   * and this holder never releases or rewrites a lock again (the fence).
   */
  abandon(): void {
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
  }

  /**
   * Deletes the file — only while it is still this holder's. A holder that lost it closes its
   * descriptor and deletes nothing: the file now belongs to someone else. While the answer is
   * `unknown`, nothing is done, so the caller can try again.
   */
  release(): 'released' | Exclude<HoldCheck, 'holds'> {
    const check = this.check();
    if (check === 'unknown') return check;
    if (check === 'holds') fs.unlinkSync(this.file);
    if (this.fd !== null) fs.closeSync(this.fd);
    this.fd = null;
    return check === 'holds' ? 'released' : 'lost';
  }
}

function writeThrough(fd: number, content: LockFileContent): void {
  const bytes = encodeLockFile(content);
  fs.writeSync(fd, bytes, 0, bytes.length, 0);
  fs.ftruncateSync(fd, bytes.length);
  fs.fsyncSync(fd);
}

/** `same` when the path still leads to the descriptor's file; `lost` when it's gone or another file. */
function sameFile(fd: number, file: string): 'same' | 'lost' | 'unknown' {
  try {
    const mine = fs.fstatSync(fd);
    const there = fs.statSync(file);
    return mine.ino === there.ino && mine.dev === there.dev ? 'same' : 'lost';
  } catch (error) {
    return errno(error) === 'ENOENT' ? 'lost' : 'unknown';
  }
}

function sameHolder(a: LockFileHolder, b: LockFileHolder): boolean {
  const ids = a.kind === b.kind && a.session_id === b.session_id && a.window_id === b.window_id;
  return ids && a.pid === b.pid && sameStart(a.pid_start, b.pid_start);
}

function isLockFileContent(value: unknown): value is LockFileContent {
  const content = value as Partial<LockFileContent> | null;
  if (!content || content.version !== 3 || typeof content.taskId !== 'string') return false;
  return isHolder(content.holder) && !Number.isNaN(Date.parse(String(content.heartbeatAt)));
}

function isHolder(value: unknown): value is LockFileHolder {
  const holder = value as Partial<LockFileHolder> | null;
  if (!holder || (holder.kind !== 'codex_session' && holder.kind !== 'clarvis_run')) return false;
  return Number.isSafeInteger(holder.pid) && typeof holder.pid_start === 'string';
}

function errno(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? 'unknown';
}
