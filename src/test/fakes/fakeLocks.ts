/**
 * FakeRavisRelay's project locks: taking, heartbeats, release, takeover and transfer, and the lock a Codex session
 * holds — so a switch between engines and a takeover can be driven against the contract (plan.md M15, C3).
 *
 * **Opt-in** (`fake.locks()`). Until a test asks for it, every lock route answers its fixture examples as C1 built
 * it, and the session machine keeps its simpler rule. **Still a labelled test double:** it holds no real lock, reads
 * no lock file and signals no process. Every answer goes through the same fixture checks as the rest of the fake.
 *
 * **Where the contract leaves a choice, it says which it made:**
 * - a transfer token is honoured once, by the kind of holder it was issued for;
 * - a Clarvis window taking a lock with an unknown, used or expired transfer token gets `409 LOCK_TRANSFER_INVALID`.
 *   The fixtures list that code only for session create and turns, so this answer is marked off-contract, and it is
 *   a gap for RAVIS's lock increment (R4);
 * - `transfer` takes the lease of a Clarvis-engine holder, or the token of the Codex session holding the lock;
 * - after a transfer the lock stays `transferring`, with the source still named, until the destination takes it;
 * - a Codex session settled with `next: "transfer"` keeps its lock reserved for the destination; settled `idle` or
 *   `end`, its lock is released (`conventions.json`: the idle view shows it released);
 * - a takeover is judged by the verdict a test sets (`setVerdict`), as RAVIS judges with its own probe.
 *
 * Test support only.
 */

import { createHash, randomBytes } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import * as path from 'path';
import type { Verdict } from '../../engine/lock/lockRule';
import type { HolderKind } from '../../engine/relay/relayTypes';
import { errorAnswer, fixtureAnswer, type FakeAnswer } from './fakeAnswers';
import type { FixtureRoute } from './relayContract';

export interface FakeLockRow {
  id: string;
  root: string;
  holder: { kind: HolderKind; session_id: string | null; window_id: string | null; host: string; since: string };
  /** A Clarvis-engine holder's lease; a Codex session holds its lock through its token. */
  lease: string | null;
  state: 'running' | 'stopping' | 'transferring' | 'leftover' | 'superseded';
  verdict: Verdict;
  waitingOnYou: boolean;
  takenOverFrom: string | null;
  transfer: { token: string; to: HolderKind; used: boolean; expired: boolean } | null;
}

/** Whether a Codex session may take its root's lock now, for a create or a turn. */
export type SessionTake = 'ok' | 'invalid_token' | 'locked' | 'nested' | 'superseded';

/** What the lock machine needs from the fake that owns it. */
export interface LocksHost {
  revokeLease(lease: string, takenOverBy: string): void;
  sessionToken(sessionId: string): string | undefined;
  /** A lock moved away from a Codex session: it no longer holds its project. */
  sessionLostLock(sessionId: string): void;
  /** A lock registered with `adopt_file_lock` replaced RAVIS's superseded one for this root. */
  unsupersede(root: string): void;
}

const ACQUIRE = 'POST /api/v1/project-locks';
const RELEASE = 'POST /api/v1/project-locks/{lid}/release';
const TRANSFER = 'POST /api/v1/project-locks/{lid}/transfer';

type WindowHolder = { window_id: string; host: string };

export class FakeLocks {
  /** Lock ids let go through `release`, in order. */
  readonly released: string[] = [];
  readonly transfers: { id: string; to: HolderKind; by: 'lease' | 'token' }[] = [];
  readonly takeovers: { id: string; by: string; confirm: unknown }[] = [];
  private readonly rows = new Map<string, FakeLockRow>();
  private counter = 0;

  constructor(private readonly host: LocksHost) {}

  // ── Test controls ───────────────────────────────────────────────────────────

  rowFor(root: string): FakeLockRow | undefined {
    return [...this.rows.values()].find((row) => row.root === root);
  }

  rowForSession(sessionId: string): FakeLockRow | undefined {
    return [...this.rows.values()].find((row) => row.holder.session_id === sessionId);
  }

  /** Another Clarvis window holds `root`, judged `verdict`. */
  holdForWindow(root: string, window: { id: string; host: string }, options: { verdict?: Verdict; waitingOnYou?: boolean; since?: string } = {}): FakeLockRow {
    const row = this.newRow(root, { window_id: window.id, host: window.host }, options.since);
    row.verdict = options.verdict ?? 'alive';
    row.waitingOnYou = options.waitingOnYou ?? false;
    return row;
  }

  setVerdict(root: string, verdict: Verdict, waitingOnYou = false): void {
    const row = this.rowFor(root);
    if (!row) throw new Error(`nothing holds ${root}`);
    Object.assign(row, { verdict, waitingOnYou });
  }

  /** The transfer token for `root` runs out, as after 15 minutes: nothing is released by it. */
  expireTransfer(root: string): void {
    const transfer = this.rowFor(root)?.transfer;
    if (transfer) transfer.expired = true;
  }

  // ── What the session machine asks ───────────────────────────────────────────

  sessionTakes(root: string, sessionId: string | undefined, token: string | null | undefined): SessionTake {
    const row = this.rowFor(root);
    if (token) return this.validToken(row, token, 'codex_session') ? 'ok' : 'invalid_token';
    if (row?.state === 'superseded') return 'superseded';
    if (row) return sessionId !== undefined && row.holder.session_id === sessionId ? 'ok' : 'locked';
    return this.nested(root) ? 'nested' : 'ok';
  }

  /** A create or a turn took the lock: with a transfer token, from whoever it was reserved from. */
  giveToSession(root: string, sessionId: string, token: string | null | undefined): void {
    const row = this.rowFor(root);
    if (row?.holder.session_id === sessionId && !token) return;
    const taken = row ?? this.newRow(root, { window_id: '', host: 'ravis' });
    if (row?.lease) this.host.revokeLease(row.lease, sessionId);
    if (token && taken.transfer) taken.transfer.used = true;
    Object.assign(taken, { holder: { kind: 'codex_session', session_id: sessionId, window_id: null, host: 'ravis', since: now() }, lease: null, state: 'running', verdict: 'alive' });
  }

  sessionSettled(sessionId: string, next: string): void {
    const row = this.rowForSession(sessionId);
    if (!row || next === 'transfer') return;
    this.rows.delete(row.id);
  }

  supersede(root: string): void {
    const row = this.rowFor(root);
    if (row) row.state = 'superseded';
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  answer(route: FixtureRoute, url: URL, headers: IncomingHttpHeaders, body: unknown): FakeAnswer | undefined {
    const row = this.rows.get(decodeURIComponent(url.pathname.split('/')[4] ?? ''));
    const lease = header(headers, 'x-lock-lease');
    switch (route.key) {
      case ACQUIRE:
        return this.acquire(body as AcquireRequest);
      case 'POST /api/v1/project-locks/{lid}/heartbeat':
        return this.heartbeat(lease);
      case RELEASE:
        return this.release(lease, body);
      case 'POST /api/v1/project-locks/{lid}/takeover':
        return row ? this.takeover(row, body as TakeoverRequest) : offContract(404, 'an unknown lock id');
      case TRANSFER:
        return row ? this.transfer(row, headers, body) : offContract(404, 'an unknown lock id');
      case 'GET /api/v1/project-locks': {
        const held = this.rowFor(url.searchParams.get('workspace_root') ?? '');
        return { status: 200, body: { lock: held ? this.view(held) : null } };
      }
      default:
        return undefined;
    }
  }

  private acquire(request: AcquireRequest): FakeAnswer {
    const current = this.rowFor(request.workspace_root);
    if (request.transfer_token !== undefined) return this.acquireWithToken(current, request);
    if (request.adopt_file_lock && (!current || current.state === 'superseded')) return this.adopt(current, request);
    if (current) return this.locked(current);
    const nested = this.nested(request.workspace_root);
    if (nested) return errorAnswer(409, 'NESTED_PROJECT_LOCKED', undefined, { lock: this.view(nested) });
    return this.granted(this.newRow(request.workspace_root, request.holder));
  }

  private acquireWithToken(current: FakeLockRow | undefined, request: AcquireRequest): FakeAnswer {
    if (!current || !this.validToken(current, request.transfer_token ?? '', 'clarvis_run')) {
      return { ...errorAnswer(409, 'LOCK_TRANSFER_INVALID'), offContract: 'the fixtures list LOCK_TRANSFER_INVALID only for session create and turns (R4 gap)' };
    }
    if (current.holder.session_id) this.host.sessionLostLock(current.holder.session_id);
    (current.transfer as NonNullable<FakeLockRow['transfer']>).used = true;
    return this.granted(this.moveToWindow(current, request.holder, null));
  }

  private adopt(current: FakeLockRow | undefined, request: AcquireRequest): FakeAnswer {
    if (current) this.rows.delete(current.id);
    this.host.unsupersede(request.workspace_root);
    return this.granted(this.newRow(request.workspace_root, request.holder));
  }

  private locked(current: FakeLockRow): FakeAnswer {
    const codex = current.holder.kind === 'codex_session';
    const takeoverAllowed = !codex && (current.verdict !== 'alive' || current.waitingOnYou);
    const attach = codex ? { attach_session_id: current.holder.session_id } : {};
    return errorAnswer(409, 'PROJECT_LOCKED', 'Another holder has this project.', { lock: this.view(current), takeover_allowed: takeoverAllowed, ...attach });
  }

  private heartbeat(lease: string | undefined): FakeAnswer {
    const row = this.byLease(lease);
    if (!row) return errorAnswer(409, 'LEASE_REVOKED', undefined, { taken_over_by: null });
    return { status: 200, body: { lock: this.view(row) } };
  }

  private release(lease: string | undefined, body: unknown): FakeAnswer {
    const row = this.byLease(lease);
    if (!row) return errorAnswer(409, 'LEASE_REVOKED', undefined, { taken_over_by: null });
    const confirmed = (body as { processes_confirmed_gone?: unknown } | undefined)?.processes_confirmed_gone === true;
    if (!confirmed || row.state === 'leftover') return fixtureAnswer(RELEASE, 'processes not confirmed gone, or the lock is leftover');
    this.rows.delete(row.id);
    this.released.push(row.id);
    return { status: 200, body: { $unfixed: '200; the design fixes no body' } };
  }

  /** `project-locks.json` takeover_rules, by the verdict a test set. */
  private takeover(row: FakeLockRow, request: TakeoverRequest): FakeAnswer {
    if (row.holder.kind === 'codex_session') return errorAnswer(409, 'ATTACH_INSTEAD', undefined, { session_id: row.holder.session_id });
    const confirmable = row.verdict === 'unresponsive' || row.waitingOnYou;
    if (row.verdict !== 'gone' && !confirmable) return errorAnswer(409, 'HOLDER_ACTIVE');
    const matches = request.confirm?.holder_window_id === row.holder.window_id && request.confirm?.holder_since === row.holder.since;
    if (row.verdict !== 'gone' && !matches) return errorAnswer(422, 'CONFIRMATION_MISMATCH');
    this.takeovers.push({ id: row.id, by: request.window.id, confirm: request.confirm });
    if (row.lease) this.host.revokeLease(row.lease, request.window.id);
    const from = row.holder.window_id;
    return this.granted(this.moveToWindow(row, { window_id: request.window.id, host: request.window.host }, from));
  }

  private transfer(row: FakeLockRow, headers: IncomingHttpHeaders, body: unknown): FakeAnswer {
    const by = this.authority(row, headers);
    if (!by) return offContract(403, 'neither the lease nor the holding session’s token');
    if (row.state === 'leftover') return fixtureAnswer(TRANSFER, 'processes not confirmed gone');
    this.counter++;
    const to = (body as { to: HolderKind }).to;
    row.transfer = { token: `FIXTURE-transfer-token-${this.counter}`, to, used: false, expired: false };
    row.state = 'transferring';
    this.transfers.push({ id: row.id, to, by });
    return { status: 200, body: { transfer_token: row.transfer.token, expires_at: '2026-09-13T02:09:00Z' } };
  }

  private authority(row: FakeLockRow, headers: IncomingHttpHeaders): 'lease' | 'token' | undefined {
    if (row.lease && header(headers, 'x-lock-lease') === row.lease) return 'lease';
    const token = row.holder.session_id ? this.host.sessionToken(row.holder.session_id) : undefined;
    return token && header(headers, 'x-agent-session-token') === token ? 'token' : undefined;
  }

  // ── Rows ────────────────────────────────────────────────────────────────────

  private validToken(row: FakeLockRow | undefined, token: string, to: HolderKind): boolean {
    const transfer = row?.transfer;
    return Boolean(transfer && transfer.token === token && transfer.to === to && !transfer.used && !transfer.expired);
  }

  private newRow(root: string, holder: WindowHolder, since = now()): FakeLockRow {
    this.counter++;
    const row: FakeLockRow = {
      id: `pl_FAKE${String(this.counter).padStart(4, '0')}${randomBytes(3).toString('hex').toUpperCase()}`,
      root,
      holder: { kind: 'clarvis_run', session_id: null, window_id: holder.window_id, host: holder.host, since },
      lease: `lk_FAKE_lease_${this.counter}_${randomBytes(8).toString('hex')}`,
      state: 'running',
      verdict: 'alive',
      waitingOnYou: false,
      takenOverFrom: null,
      transfer: null,
    };
    this.rows.set(row.id, row);
    return row;
  }

  private moveToWindow(row: FakeLockRow, holder: WindowHolder, takenOverFrom: string | null): FakeLockRow {
    this.counter++;
    Object.assign(row, {
      holder: { kind: 'clarvis_run', session_id: null, window_id: holder.window_id, host: holder.host, since: now() },
      lease: `lk_FAKE_lease_${this.counter}_${randomBytes(8).toString('hex')}`,
      state: 'running',
      verdict: 'alive',
      waitingOnYou: false,
      takenOverFrom,
    });
    return row;
  }

  private granted(row: FakeLockRow): FakeAnswer {
    return { status: row.takenOverFrom === null ? 201 : 200, body: { lock: this.view(row), lease_token: row.lease } };
  }

  private byLease(lease: string | undefined): FakeLockRow | undefined {
    return lease ? [...this.rows.values()].find((row) => row.lease === lease) : undefined;
  }

  /** A root locked around or inside `root` (`project-locks.json` nested_root_cases). */
  private nested(root: string): FakeLockRow | undefined {
    const inside = (outer: string, inner: string) => inner.startsWith(`${outer}${path.sep}`);
    return [...this.rows.values()].find((row) => inside(row.root, root) || inside(root, row.root));
  }

  private view(row: FakeLockRow): Record<string, unknown> {
    return {
      id: row.id,
      workspace: { name: path.basename(row.root), root_hash: `sha256:${createHash('sha256').update(row.root).digest('hex')}` },
      holder: { ...row.holder },
      state: row.state,
      waiting_on_you: row.waitingOnYou,
      heartbeat_age_seconds: row.verdict === 'unresponsive' ? 140 : 4,
      verdict: row.verdict,
      taken_over_from: row.takenOverFrom,
    };
  }
}

interface AcquireRequest {
  workspace_root: string;
  holder: WindowHolder;
  transfer_token?: string;
  adopt_file_lock?: boolean;
}

interface TakeoverRequest {
  workspace_root: string;
  window: { id: string; host: string };
  confirm?: { holder_window_id?: string; holder_since?: string };
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function offContract(status: number, why: string): FakeAnswer {
  return { status, body: { error: { code: 'FAKE_OFF_CONTRACT', message: why } }, offContract: why };
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
