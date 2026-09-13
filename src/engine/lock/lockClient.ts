/**
 * Clarvis's client for RAVIS's project-lock API (plan.md M15, C1; design §3.6 and §6.3).
 *
 * **What the lock is for.** One writer per project, whichever engine. A Codex session holds its
 * project's lock from the moment it is created, inside RAVIS. A run of Clarvis's own engine takes it
 * through these routes — after creating the checkout lock file (`fileLock.ts`), which is the floor
 * while RAVIS is down — heartbeats it every 15 s, and releases it once its processes are confirmed
 * gone. A switch between engines hands it on with a transfer token instead of releasing it.
 *
 * **The fence is the part to get right.** A run that lost its lock must never commit, save the
 * checkpoint or release — but "lost" must mean evidence of loss, never silence. The evidence is
 * exactly two things: a heartbeat answered `409 LEASE_REVOKED` (another window took over), or a lock
 * file that no longer names this window. RAVIS being unreachable is not loss; the run carries on under
 * the file and re-registers when RAVIS answers. So `heartbeat` reports a revoked lease as a result of
 * its own, apart from every other failure, and `fenceHolds` is the whole decision in one line, where
 * its tests can pin it.
 */

import { anyBody, sendExpecting, shaped, type Guard } from '../relay/bodies';
import type { RelayFailure, RelayOutcome } from '../relay/relayFailure';
import type { CallOptions, RelayHttp, RelayRequest } from '../relay/relayHttp';
import type { AcquireLockBody, HolderKind, Host, LockView, RunningCommand } from '../relay/relayTypes';
import type { HoldCheck } from './fileLock';

const LOCKS = '/api/v1/project-locks';

export interface AcquiredLock {
  lock: LockView;
  lease_token: string;
}

export interface HeartbeatBody {
  waiting_on_you: boolean;
  state: string;
  running_command: RunningCommand | null;
}

export type HeartbeatResult =
  | { kind: 'held'; lock: LockView }
  /** Another window took the lock over: the fence. */
  | { kind: 'revoked'; takenOverBy: string | null }
  /** Anything else, RAVIS unreachable included. Not loss. */
  | { kind: 'failed'; failure: RelayFailure };

export interface TakeoverBody {
  workspace_root: string;
  window: { id: string; host: Host; pid: number; pid_start: string };
  /** The holder as the owner was shown it. Not needed when the holder is `gone`. */
  confirm?: { holder_window_id: string; holder_since: string };
}

export interface TransferGrant {
  transfer_token: string;
  expires_at: string;
}

/** A lock is handed on by its lease, or by the holding Codex session's token. */
export type TransferAuthority = { lease: string } | { token: string };

export class LockClient {
  constructor(readonly http: RelayHttp) {}

  /** Takes the lock for a Clarvis-engine run, moves it with a transfer token, or adopts a file lock. */
  acquire(body: AcquireLockBody, key: string, options?: CallOptions): Promise<RelayOutcome<AcquiredLock>> {
    return this.call({ method: 'POST', path: LOCKS, body, idempotencyKey: key }, isAcquired, options);
  }

  /** Every 15 s, and synchronously right before every commit. */
  async heartbeat(lockId: string, lease: string, beat: HeartbeatBody, options?: CallOptions): Promise<HeartbeatResult> {
    const request: RelayRequest = { method: 'POST', path: `${lockPath(lockId)}/heartbeat`, lease, body: beat };
    const outcome = await this.call<{ lock: LockView }>(request, shaped({ lock: 'object' }), options);
    if (outcome.ok) return { kind: 'held', lock: outcome.value.lock };
    return revocation(outcome.failure) ?? { kind: 'failed', failure: outcome.failure };
  }

  /** Releases the lock. Only once the run's processes are confirmed gone, so there is nothing else to say. */
  release(lockId: string, lease: string, processesConfirmedGone: true, options?: CallOptions): Promise<RelayOutcome<unknown>> {
    const body = { processes_confirmed_gone: processesConfirmedGone };
    return this.call({ method: 'POST', path: `${lockPath(lockId)}/release`, lease, body }, anyBody, options);
  }

  /** Takes over a Clarvis-engine holder that is gone, unresponsive, or waiting on the owner. */
  takeover(lockId: string, body: TakeoverBody, key: string, options?: CallOptions): Promise<RelayOutcome<AcquiredLock>> {
    return this.call({ method: 'POST', path: `${lockPath(lockId)}/takeover`, body, idempotencyKey: key }, isAcquired, options);
  }

  /** Starts handing the lock to the other engine; the lock goes to `transferring`, never released. */
  transfer(
    lockId: string,
    authority: TransferAuthority,
    to: HolderKind,
    key: string,
    options?: CallOptions
  ): Promise<RelayOutcome<TransferGrant>> {
    const request: RelayRequest = { method: 'POST', path: `${lockPath(lockId)}/transfer`, ...authority, body: { to }, idempotencyKey: key };
    return this.call(request, shaped({ transfer_token: 'string', expires_at: 'string' }), options);
  }

  /** The lock on a workspace root, or null when it is free. */
  async current(workspaceRoot: string, options?: CallOptions): Promise<RelayOutcome<LockView | null>> {
    const request: RelayRequest = { method: 'GET', path: LOCKS, query: { workspace_root: workspaceRoot } };
    const outcome = await this.call<{ lock: LockView | null }>(request, shaped({ lock: ['object', 'null'] }), options);
    return outcome.ok ? { ...outcome, value: outcome.value.lock } : outcome;
  }

  private call<T>(request: RelayRequest, guard: Guard, options?: CallOptions): Promise<RelayOutcome<T>> {
    return sendExpecting<T>(this.http, request, guard, options);
  }
}

/**
 * The fence (design §6.3): does this run still hold its lock? False only on evidence of loss — the last
 * heartbeat was revoked, or the lock file no longer names this window. A failed or missing heartbeat,
 * or a file that couldn't be read, is not evidence.
 */
export function fenceHolds(lastHeartbeat: HeartbeatResult | undefined, file: HoldCheck): boolean {
  return lastHeartbeat?.kind !== 'revoked' && file !== 'lost';
}

function revocation(failure: RelayFailure): HeartbeatResult | undefined {
  if (failure.kind !== 'refused' || failure.code !== 'LEASE_REVOKED') return undefined;
  const by = failure.details.taken_over_by;
  return { kind: 'revoked', takenOverBy: typeof by === 'string' ? by : null };
}

function lockPath(lockId: string): string {
  return `${LOCKS}/${encodeURIComponent(lockId)}`;
}

const isAcquired = shaped({ lock: 'object', lease_token: 'string' });
