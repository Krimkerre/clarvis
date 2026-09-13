/**
 * Taking a project over from another Clarvis window, once the owner confirms (plan.md M15, C3; design §6.3).
 *
 * **When it is offered** (`projectLock.ts` `LockRefusal.takeover`). Only for a window running Clarvis's own
 * engine — a Codex task is joined, never taken over — whose checkout lock file the shared lock rule judges
 * `unresponsive` (its pid and start time still match, its heartbeat is over 90 s old, and this Mac has been awake
 * at least 90 s), or `alive` and waiting on its owner there. A stale heartbeat alone never makes a window dead:
 * right after a wake the same window is `alive`, and a window that is working is refused, never offered.
 *
 * **What a confirmed takeover does, in order:**
 * 1. looks again: the lock file must still name the window the owner was shown, and the rule must still allow it
 *    — a window that came back to work is refused;
 * 2. checks the lock is this folder's: when RAVIS holds a lock for this folder, it must be the one the lock file
 *    names, under this folder's root hash. A lock that belongs to another folder is never taken over from here, so
 *    nothing is stopped, committed or continued on another project's branch (cross-project safety);
 * 3. asks RAVIS (`POST …/takeover`, confirming the holder RAVIS itself names): RAVIS revokes the old lease, so the
 *    old window's next heartbeat fences it, and stops the command it had running. RAVIS not answering leaves the
 *    file floor alone to decide, as everywhere else;
 * 4. stops the command the old window recorded as running — its whole process group and descendants — and
 *    confirms it gone (`groupKill.ts`); after RAVIS did it, this finds nothing to signal. If it can't confirm, the
 *    takeover stays `leftover`, names what is left, and replaces nothing;
 * 5. replaces the lock file with this window's, recording whom it was taken from.
 *
 * **The window taken over never writes again.** Its lease is revoked and its lock file no longer names it, so its
 * fence is false before its next edit, command, commit or checkpoint write, and it never releases or rewrites a
 * lock (design §6.3).
 *
 * **The new holder continues the same task** (review AL3): the outcome carries the old lock file's task id, so
 * the caller carries that task on, on its branch, rather than starting a new one beside its leftovers.
 *
 * Offers come from the checkout lock file. RAVIS's own `takeover_allowed` on a refusal, with no lock file in this
 * checkout, isn't acted on here: the floor would have nothing to replace.
 *
 * vscode-free; the rule, the probe and the group kill come through the project lock's deps.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import { freshKey } from '../relay/idempotency';
import type { RelayFailure } from '../relay/relayFailure';
import type { LockView, RunningCommand } from '../relay/relayTypes';
import { createLockFile, lockFilePath, readLockFile, type LockFileContent } from './fileLock';
import { stopCommandGroup, type Survivor } from './groupKill';
import type { LockClient } from './lockClient';
import { onFindingALock } from './lockRule';
import { holdHere, judgeHolder, LOCK_LINES, lockFileContentFor, ProjectLock, type ProjectLockDeps, type TakeoverOffer } from './projectLock';

const RAVIS_TIMEOUT_MS = 3_000;

export type TakeoverOutcome =
  | { kind: 'taken'; lock: ProjectLock; taskId: string; takenFrom: string }
  | { kind: 'refused'; line: string; attachSessionId?: string }
  /** The old window's command wouldn't stop: nothing was replaced, and nothing may be written. */
  | { kind: 'leftover'; line: string; survivors: Survivor[] };

export const TAKEOVER_LINES = {
  gone: 'The other window has already let the project go. Start the run again.',
  changed: "The project's lock changed since you were asked, so nothing was taken over. Look again.",
  otherFolder: 'That lock belongs to another folder, so nothing was taken over from here. Open that folder to take it over there.',
  race: 'Another window took the project at the same moment, so nothing was taken over.',
  survivors: (survivors: Survivor[]) =>
    `The other window's command is still running and wouldn't stop: ${survivors.map((survivor) => `\`${survivor.comm}\` (pid ${survivor.pid})`).join(', ')}. Nothing was taken over or written.`,
};

type RavisPart = { kind: 'ravis'; lease: { id: string; token: string } } | { kind: 'floor' } | Extract<TakeoverOutcome, { kind: 'refused' }>;

/** Takes the project over from the window in `offer`, which the owner confirmed. */
export async function takeOverProjectLock(deps: ProjectLockDeps, offer: TakeoverOffer): Promise<TakeoverOutcome> {
  const file = lockFilePath(deps.root, deps.gitDir);
  const found = await stillOffered(file, offer, deps);
  if ('line' in found) return { kind: 'refused', line: found.line };
  const ravis = await ravisTakeover(deps, found.content);
  if (ravis.kind === 'refused') return ravis;
  const left = await stopWhatItWasRunning(found.content.running_command, deps);
  if (left) return left;
  return replaceLockFile(file, found.content, ravis.kind === 'ravis' ? ravis.lease : undefined, deps);
}

/** Step 1: the file still names the window the owner was shown, and the rule still allows taking it. */
async function stillOffered(file: string, offer: TakeoverOffer, deps: ProjectLockDeps): Promise<{ content: LockFileContent } | { line: string }> {
  const read = readLockFile(file);
  if (read.kind === 'absent') return { line: TAKEOVER_LINES.gone };
  if (read.kind === 'unreadable') return { line: LOCK_LINES.unreadable(read.detail) };
  const { content } = read;
  if (content.holder.kind !== 'clarvis_run' || content.holder.window_id !== offer.holderWindowId) return { line: TAKEOVER_LINES.changed };
  const verdict = await judgeWith(deps)(content, read.heartbeatAgeSeconds);
  if (verdict === undefined) return { line: LOCK_LINES.unjudged };
  const outcome = onFindingALock('clarvis_run', verdict, content.waitingOnYou);
  return outcome === 'refuse' ? { line: LOCK_LINES.working(content.holder.host, content.holder.since) } : { content };
}

/** Steps 2 and 3: RAVIS's lock for this folder is the one the file names, and RAVIS takes it over. */
async function ravisTakeover(deps: ProjectLockDeps, content: LockFileContent): Promise<RavisPart> {
  const locks = deps.locks;
  const current = locks ? await locks.current(deps.root, { timeoutMs: RAVIS_TIMEOUT_MS }) : undefined;
  // No RAVIS here, RAVIS not answering, or RAVIS keeping no lock for this folder: the file floor decides.
  if (!current?.ok || !current.value) return { kind: 'floor' };
  if (!isThisFoldersLock(current.value, deps.root, content)) return { kind: 'refused', line: TAKEOVER_LINES.otherFolder };
  return askRavis(locks as LockClient, deps, current.value);
}

function isThisFoldersLock(lock: LockView, root: string, content: LockFileContent): boolean {
  const sameRoot = lock.workspace.root_hash === rootHash(root);
  const sameLock = content.ravis_lock_id === null ? lock.holder.window_id === content.holder.window_id : lock.id === content.ravis_lock_id;
  return sameRoot && sameLock;
}

async function askRavis(locks: LockClient, deps: ProjectLockDeps, lock: LockView): Promise<RavisPart> {
  const window = { id: deps.window.id, host: deps.window.host, pid: deps.pid, pid_start: deps.pidStart };
  const confirm = { holder_window_id: lock.holder.window_id ?? '', holder_since: lock.holder.since };
  const taken = await locks.takeover(lock.id, { workspace_root: deps.root, window, confirm }, freshKey(), { timeoutMs: RAVIS_TIMEOUT_MS });
  if (taken.ok) return { kind: 'ravis', lease: { id: taken.value.lock.id, token: taken.value.lease_token } };
  return takeoverRefused(taken.failure, lock);
}

function takeoverRefused(failure: RelayFailure, lock: LockView): RavisPart {
  if (failure.kind !== 'refused') return failure.kind === 'unreachable' ? { kind: 'floor' } : { kind: 'refused', line: `RAVIS couldn't take the project over (${failure.kind}).` };
  if (failure.code === 'ATTACH_INSTEAD') return { kind: 'refused', line: LOCK_LINES.codex, attachSessionId: String(failure.details.session_id) };
  if (failure.code === 'HOLDER_ACTIVE') return { kind: 'refused', line: LOCK_LINES.working(lock.holder.host, lock.holder.since) };
  if (failure.code === 'CONFIRMATION_MISMATCH') return { kind: 'refused', line: TAKEOVER_LINES.changed };
  return failure.status === 422 ? { kind: 'floor' } : { kind: 'refused', line: failure.message };
}

/** Step 4: the old window's recorded command, with its group and descendants, stopped and confirmed gone. */
async function stopWhatItWasRunning(command: RunningCommand | null, deps: ProjectLockDeps): Promise<TakeoverOutcome | undefined> {
  if (!command) return undefined;
  const stopped = await (deps.stopGroup ?? ((recorded: RunningCommand) => stopCommandGroup(recorded)))(command);
  if (stopped.gone === true) return undefined;
  if (stopped.gone === false) return { kind: 'leftover', line: TAKEOVER_LINES.survivors(stopped.survivors), survivors: stopped.survivors };
  return { kind: 'leftover', line: LOCK_LINES.command(command), survivors: [] };
}

/** Step 5: this window's lock file in place of the old one, saying whom it was taken from. */
async function replaceLockFile(file: string, old: LockFileContent, lease: { id: string; token: string } | undefined, deps: ProjectLockDeps): Promise<TakeoverOutcome> {
  removeIfSameHolder(file, old);
  const created = createLockFile(file, { ...lockFileContentFor(deps), takenOverFrom: old.holder.window_id });
  if (!created.ok) {
    // RAVIS gave this window the lock, but another window has the file: give RAVIS's back, its processes are gone.
    if (lease && deps.locks) await deps.locks.release(lease.id, lease.token, true, { timeoutMs: RAVIS_TIMEOUT_MS });
    return { kind: 'refused', line: TAKEOVER_LINES.race };
  }
  const lock = new ProjectLock(deps, holdHere(created.lock));
  if (lease) lock.useLease(lease);
  else await lock.register(true);
  lock.startHeartbeat();
  return { kind: 'taken', lock, taskId: old.taskId, takenFrom: old.holder.window_id ?? old.holder.host };
}

/** Removes the old window's file — whatever its heartbeat says now — only while it still names that window. */
function removeIfSameHolder(file: string, old: LockFileContent): void {
  const now = readLockFile(file);
  if (now.kind === 'present' && JSON.stringify(now.content.holder) === JSON.stringify(old.holder)) fs.rmSync(file, { force: true });
}

function judgeWith(deps: ProjectLockDeps): NonNullable<ProjectLockDeps['judge']> {
  return deps.judge ?? judgeHolder;
}

/** RAVIS's `root_hash` for a folder: the sha256 of its realpath (`project-locks.json` lock_view). */
export function rootHash(root: string): string {
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    // A folder that has gone away hashes as it was named.
  }
  return `sha256:${createHash('sha256').update(real).digest('hex')}`;
}
