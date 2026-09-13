import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeRavisRelay, FIXTURE_LOCK, FIXTURE_SESSION, fakeHttp } from '../../test/fakes/FakeRavisRelay';
import { exampleNamed, type FixtureExample } from '../../test/fakes/relayContract';
import { freshKey } from '../relay/idempotency';
import type { RelayFailure, RelayOutcome } from '../relay/relayFailure';
import type { AcquireLockBody, LockView } from '../relay/relayTypes';
import { fenceHolds, LockClient, type HeartbeatBody, type HeartbeatResult, type TakeoverBody } from './lockClient';

/**
 * The project-lock client against `FakeRavisRelay`, and the fence. The fence is the promise that a
 * run which lost its lock writes nothing — and, just as important, that a run which merely can't reach
 * RAVIS keeps going instead of stopping every build the moment RAVIS restarts.
 */

const LOCKS = 'POST /api/v1/project-locks';
const CODEX_LOCK = 'pl_01J9ZK5A2B3C4D5E6F7G8H9J0K';

async function withLocks(run: (fake: FakeRavisRelay, locks: LockClient) => Promise<void>): Promise<void> {
  const fake = await FakeRavisRelay.start();
  try {
    await run(fake, new LockClient(fakeHttp(fake)));
    assert.deepEqual(fake.violations, [], 'every request and answer matched the fixtures');
  } finally {
    await fake.close();
  }
}

function keyOf(example: FixtureExample): string {
  const key = example.request.headers?.['Idempotency-Key'];
  if (!key) throw new Error(`${example.name} carries no Idempotency-Key`);
  return key;
}

function value<T>(outcome: RelayOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected a success, got ${JSON.stringify(outcome.failure)}`);
  return outcome.value;
}

function refusedCode<T>(outcome: RelayOutcome<T>): string | null {
  if (outcome.ok || outcome.failure.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  return outcome.failure.code;
}

test('taking a lock sends the holder and the git folder, and returns the lease', () =>
  withLocks(async (fake, locks) => {
    const example = exampleNamed(LOCKS, 'taken');
    fake.reply(LOCKS, 'taken');

    assert.deepEqual(value(await locks.acquire(example.request.body as AcquireLockBody, keyOf(example))), example.response.body);
    assert.deepEqual(fake.seen[0].body, example.request.body);
    assert.equal(fake.seen[0].headers['idempotency-key'], keyOf(example));
  }));

test('a file lock taken while RAVIS was away is registered with adopt_file_lock', () =>
  withLocks(async (fake, locks) => {
    const example = exampleNamed(LOCKS, 'a file lock adopted after RAVIS came back');
    fake.reply(LOCKS, example.name);

    assert.equal(value(await locks.acquire(example.request.body as AcquireLockBody, keyOf(example))).lease_token, FIXTURE_LOCK.lease);
    assert.equal((fake.seen[0].body as AcquireLockBody).adopt_file_lock, true);
  }));

test('a lock a Codex session holds is refused, naming the session to attach to', () =>
  withLocks(async (fake, locks) => {
    const example = exampleNamed(LOCKS, 'a Codex session holds it: attach instead');
    fake.reply(LOCKS, example.name);

    const outcome = await locks.acquire(example.request.body as AcquireLockBody, keyOf(example));

    assert.equal(refusedCode(outcome), 'PROJECT_LOCKED');
    const details = !outcome.ok && outcome.failure.kind === 'refused' ? outcome.failure.details : {};
    assert.deepEqual([details.attach_session_id, details.takeover_allowed], [FIXTURE_SESSION.id, false]);
  }));

test('a heartbeat is held, or revoked by a takeover — and only the revoked one is the fence', () =>
  withLocks(async (fake, locks) => {
    const beat = exampleNamed('POST /api/v1/project-locks/{lid}/heartbeat', 'held').request.body as HeartbeatBody;

    const held = await locks.heartbeat(FIXTURE_LOCK.id, FIXTURE_LOCK.lease, beat);
    assert.equal(held.kind, 'held');
    assert.equal(fenceHolds(held, 'holds'), true);
    assert.equal(fake.seen[0].headers['x-lock-lease'], FIXTURE_LOCK.lease);
    assert.deepEqual(fake.seen[0].body, beat);

    fake.revokeLease(FIXTURE_LOCK.lease, 'win-code-server-7f3a2b');
    const revoked = await locks.heartbeat(FIXTURE_LOCK.id, FIXTURE_LOCK.lease, beat);
    assert.deepEqual(revoked, { kind: 'revoked', takenOverBy: 'win-code-server-7f3a2b' });
    assert.equal(fenceHolds(revoked, 'holds'), false);
  }));

test('RAVIS not answering a heartbeat is not loss: the run carries on under its lock file', async () => {
  const fake = await FakeRavisRelay.start();
  const locks = new LockClient(fakeHttp(fake));
  await fake.close();
  const beat: HeartbeatBody = { waiting_on_you: false, state: 'running', running_command: null };

  const result = await locks.heartbeat(FIXTURE_LOCK.id, FIXTURE_LOCK.lease, beat, { timeoutMs: 3_000 });

  assert.equal(result.kind === 'failed' && result.failure.kind, 'unreachable');
  assert.equal(fenceHolds(result, 'holds'), true);
});

test('the fence, whole: lost only on a revoked lease, or a lock file naming someone else', () => {
  const lock = (exampleNamed('POST /api/v1/project-locks/{lid}/heartbeat', 'held').response.body as { lock: LockView }).lock;
  const serverError: RelayFailure = { kind: 'refused', status: 500, code: null, message: 'HTTP 500', retryable: true, details: {} };
  const held: HeartbeatResult = { kind: 'held', lock };
  const revoked: HeartbeatResult = { kind: 'revoked', takenOverBy: 'win-code-server-7f3a2b' };
  const unreachable: HeartbeatResult = { kind: 'failed', failure: { kind: 'unreachable', detail: 'ECONNREFUSED' } };
  const failed: HeartbeatResult = { kind: 'failed', failure: serverError };

  assert.equal(fenceHolds(held, 'holds'), true);
  assert.equal(fenceHolds(undefined, 'holds'), true, 'no heartbeat answered yet');
  assert.equal(fenceHolds(unreachable, 'holds'), true, 'silence is not evidence');
  assert.equal(fenceHolds(failed, 'unknown'), true, 'a lock file that could not be read is not evidence');

  assert.equal(fenceHolds(revoked, 'holds'), false);
  assert.equal(fenceHolds(held, 'lost'), false);
  assert.equal(fenceHolds(unreachable, 'lost'), false);
});

test('a release always says the processes are confirmed gone; a lock with leftovers is refused', () =>
  withLocks(async (fake, locks) => {
    const route = 'POST /api/v1/project-locks/{lid}/release';
    fake.reply(route, 'released');
    fake.reply(route, 'processes not confirmed gone, or the lock is leftover');

    assert.equal((await locks.release(FIXTURE_LOCK.id, FIXTURE_LOCK.lease, true)).ok, true);
    assert.equal(refusedCode(await locks.release(FIXTURE_LOCK.id, FIXTURE_LOCK.lease, true)), 'PROCESSES_NOT_CONFIRMED_GONE');
    assert.deepEqual(fake.seen[0].body, { processes_confirmed_gone: true });
  }));

test('a takeover returns a new lease; a Codex holder says attach, a busy one refuses, a changed one asks to look again', () =>
  withLocks(async (fake, locks) => {
    const route = 'POST /api/v1/project-locks/{lid}/takeover';
    const confirmed = exampleNamed(route, 'taken over from an unresponsive window, confirmed');
    fake.reply(route, confirmed.name);

    assert.deepEqual(value(await locks.takeover(FIXTURE_LOCK.id, confirmed.request.body as TakeoverBody, keyOf(confirmed))), confirmed.response.body);
    assert.equal(fake.seen[0].headers['x-lock-lease'], undefined, 'a takeover carries no lease');

    for (const [name, code] of [
      ['a Codex session holds it', 'ATTACH_INSTEAD'],
      ['the holder is alive and working', 'HOLDER_ACTIVE'],
      ['the confirmation names another window', 'CONFIRMATION_MISMATCH'],
    ]) {
      const example = exampleNamed(route, name);
      fake.reply(route, name);
      const lockId = example.request.path.split('/')[4];
      assert.equal(refusedCode(await locks.takeover(lockId, example.request.body as TakeoverBody, freshKey())), code, name);
    }
  }));

test("a transfer is authorised by the lease, or by the holding Codex session's token — never both", () =>
  withLocks(async (fake, locks) => {
    const route = 'POST /api/v1/project-locks/{lid}/transfer';
    const byLease = exampleNamed(route, "Clarvis's engine to Codex");
    const byToken = exampleNamed(route, "Codex to Clarvis's engine, with the session token");
    fake.reply(route, byLease.name);
    fake.reply(route, byToken.name);

    assert.deepEqual(value(await locks.transfer(FIXTURE_LOCK.id, { lease: FIXTURE_LOCK.lease }, 'codex_session', keyOf(byLease))), byLease.response.body);
    assert.deepEqual(value(await locks.transfer(CODEX_LOCK, { token: FIXTURE_SESSION.token }, 'clarvis_run', keyOf(byToken))), byToken.response.body);

    assert.deepEqual(
      fake.seen.map((request) => [request.headers['x-lock-lease'], request.headers['x-agent-session-token'], request.body]),
      [
        [FIXTURE_LOCK.lease, undefined, byLease.request.body],
        [undefined, FIXTURE_SESSION.token, byToken.request.body],
      ]
    );
  }));

test('the lock on a root, or null when it is free', () =>
  withLocks(async (fake, locks) => {
    const route = 'GET /api/v1/project-locks';
    const held = exampleNamed(route, 'held');
    fake.reply(route, 'held');
    fake.reply(route, 'free');

    assert.deepEqual(value(await locks.current(FIXTURE_SESSION.root)), (held.response.body as { lock: LockView }).lock);
    assert.equal(value(await locks.current(FIXTURE_SESSION.root)), null);
    assert.deepEqual(fake.seen[0].query, held.request.query);
  }));
