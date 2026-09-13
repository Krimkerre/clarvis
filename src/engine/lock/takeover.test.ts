import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { CLARVIS_CREDENTIAL, FakeRavisRelay } from '../../test/fakes/FakeRavisRelay';
import type { FakeLocks } from '../../test/fakes/fakeLocks';
import { writeCheckpoint } from '../checkpoint/checkpointFile';
import { newCheckpoint } from '../checkpoint/taskCheckpoint';
import { RelayHttp, relayEndpoint } from '../relay/relayHttp';
import type { RunningCommand } from '../relay/relayTypes';
import { encodeLockFile, lockFilePath, readLockFile, type LockFileContent } from './fileLock';
import type { GroupStop } from './groupKill';
import { LockClient } from './lockClient';
import { judgeLock, type Verdict } from './lockRule';
import { takeoverQuestion, takeProjectLock, type LockOutcome, type ProjectLock, type ProjectLockDeps, type TakeoverOffer } from './projectLock';
import { rootHash, takeOverProjectLock, TAKEOVER_LINES } from './takeover';

/**
 * Taking a project over from another Clarvis window (design §6.3), against the fake's lock machine and a real lock
 * file: a stale heartbeat is never death, the 90-second wake rule holds, nothing happens without the owner's yes,
 * the old window's command group is stopped before anything is replaced, the old window never writes again, and a
 * lock that belongs to another folder is never taken from here.
 */

const WINDOW = { id: 'win-desktop-1c9e4d', host: 'desktop' as const };
const OLD = { id: 'win-code-server-7f3a2b', host: 'code-server' as const };
const NPM: RunningCommand = { pid: 48210, pgid: 48210, start: 'Sun Sep 13 05:41:07 2026', comm: 'npm' };

interface Checkout {
  root: string;
  gitDir: string;
  file: string;
  fake: FakeRavisRelay;
  locks: FakeLocks;
  /** Requests as `METHOD /path`, and markers the test adds, in order. */
  sent: string[];
  deps(window: { id: string; host: 'desktop' | 'code-server' }, overrides?: Partial<ProjectLockDeps>): ProjectLockDeps;
}

async function withCheckout(run: (checkout: Checkout) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-takeover-')));
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir);
  const fake = await FakeRavisRelay.start();
  const sent: string[] = [];
  const endpoint = relayEndpoint(fake.url, CLARVIS_CREDENTIAL);
  if (!endpoint.ok) throw new Error(endpoint.reason);
  const client = new LockClient(
    new RelayHttp(endpoint.endpoint, (input, init) => {
      sent.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      return fetch(input, init);
    })
  );
  const deps = (window: { id: string; host: 'desktop' | 'code-server' }, overrides: Partial<ProjectLockDeps> = {}): ProjectLockDeps => ({
    root,
    gitDir,
    taskId: window === OLD ? 'the-old-windows-task' : 'a-new-task',
    window,
    pid: process.pid,
    pidStart: 'Sun Sep 13 05:30:40 2026',
    locks: client,
    judge: async () => 'alive',
    stopGroup: async () => ({ gone: true, signalled: 1 }),
    every: () => () => undefined,
    ...overrides,
  });
  try {
    await run({ root, gitDir, file: lockFilePath(root, gitDir), fake, locks: fake.locks(), sent, deps });
    assert.deepEqual(fake.violations, [], 'every lock request and answer matched the fixtures');
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** A lock file the old window wrote, its heartbeat `ageSeconds` old. */
function oldWindowsLock(file: string, ageSeconds: number, rest: Partial<LockFileContent> = {}): LockFileContent {
  const content: LockFileContent = {
    version: 3,
    ravis_lock_id: null,
    taskId: 'the-old-windows-task',
    engine: 'clarvis',
    state: 'running',
    holder: { kind: 'clarvis_run', session_id: null, pid: 51000, pid_start: 'Sun Sep 13 01:00:00 2026', window_id: OLD.id, host: OLD.host, since: '2026-09-13T01:12:00Z' },
    heartbeatAt: new Date(Date.now() - ageSeconds * 1000).toISOString(),
    waitingOnYou: false,
    leftover: [],
    takenOverFrom: null,
    running_command: NPM,
    ...rest,
  };
  fs.writeFileSync(file, encodeLockFile(content), { mode: 0o600 });
  return content;
}

/** The shared rule with a live pid, as an observer awake `awake` seconds sees it. */
const ruleAwake =
  (awake: number) =>
  async (content: LockFileContent, age: number): Promise<Verdict> =>
    judgeLock({ pid: content.holder.pid, pid_start: content.holder.pid_start, heartbeat_age_seconds: age }, { pid_running: true, lstart: content.holder.pid_start }, awake);

function offerIn(outcome: LockOutcome): TakeoverOffer {
  const offer = outcome.held ? undefined : outcome.takeover;
  if (!offer) throw new Error(`expected a takeover offer, got ${JSON.stringify(outcome)}`);
  return offer;
}

const holderOf = (file: string) => {
  const read = readLockFile(file);
  return read.kind === 'present' ? read.content.holder.window_id : read.kind;
};

test('a stale heartbeat alone is never death: just after a wake the window is refused as working; awake 90 s, a takeover is offered — never done silently', () =>
  withCheckout(async (c) => {
    oldWindowsLock(c.file, 300);

    const justWoke = await takeProjectLock(c.deps(WINDOW, { judge: ruleAwake(30) }));
    assert.equal(justWoke.held, false);
    assert.match(justWoke.held ? '' : justWoke.line, /is working on this project/);
    assert.equal(justWoke.held ? 'held' : justWoke.takeover, undefined, 'a window that may only have been asleep is not offered');

    const offer = offerIn(await takeProjectLock(c.deps(WINDOW, { judge: ruleAwake(600) })));
    assert.deepEqual([offer.holderWindowId, offer.holderHost, offer.why], [OLD.id, 'code-server', 'unresponsive']);
    assert.ok(offer.heartbeatAgeSeconds >= 299);
    assert.match(takeoverQuestion(offer), /^Another Clarvis window \(code-server, since \d\d:\d\d, last heard from 5 min ago\) holds this project and isn't answering\. Take it over\?/);
    assert.equal(holderOf(c.file), OLD.id, "the old window's file is untouched until the owner says yes");
    assert.deepEqual(c.sent, [], 'RAVIS was not asked for anything');
  }));

test('a window waiting on its owner is offered too, and one that came back to work by the time of the yes is refused', () =>
  withCheckout(async (c) => {
    oldWindowsLock(c.file, 4, { waitingOnYou: true, running_command: null });
    const offer = offerIn(await takeProjectLock(c.deps(WINDOW, { judge: async () => 'alive' })));
    assert.equal(offer.why, 'waiting');
    assert.match(takeoverQuestion(offer), /is waiting on you there/);

    oldWindowsLock(c.file, 4, { waitingOnYou: false, running_command: null });
    const outcome = await takeOverProjectLock(c.deps(WINDOW, { judge: async () => 'alive' }), offer);

    assert.equal(outcome.kind, 'refused');
    assert.match(outcome.kind === 'refused' ? outcome.line : '', /is working on this project/);
    assert.equal(c.sent.some((line) => line.endsWith('/takeover')), false);
    assert.equal(holderOf(c.file), OLD.id);
  }));

test('a confirmed takeover: RAVIS takes it with the confirmation, the command is stopped before the file is replaced, the same task continues, and the old window never writes again', () =>
  withCheckout(async (c) => {
    const old = await held(takeProjectLock(c.deps(OLD)));
    old.commandStarted(NPM);
    c.locks.setVerdict(c.root, 'unresponsive');
    const row = c.locks.rowFor(c.root);
    // Read now: the takeover gives the row a new holder, and a new `since`, in place.
    const since = row?.holder.since;
    const offer = offerIn(await takeProjectLock(c.deps(WINDOW, { judge: async () => 'unresponsive' })));
    const stopped: RunningCommand[] = [];

    const outcome = await takeOverProjectLock(
      c.deps(WINDOW, {
        judge: async () => 'unresponsive',
        stopGroup: async (command): Promise<GroupStop> => {
          stopped.push(command);
          c.sent.push(holderOf(c.file) === OLD.id ? 'command group stopped, the old file still in place' : 'command group stopped after the file was replaced');
          return { gone: true, signalled: 3 };
        },
      }),
      offer
    );

    assert.equal(outcome.kind, 'taken', JSON.stringify(outcome));
    assert.deepEqual(stopped, [NPM]);
    assert.deepEqual(c.sent.slice(-3), ['GET /api/v1/project-locks', `POST /api/v1/project-locks/${row?.id}/takeover`, 'command group stopped, the old file still in place']);
    const takeover = c.fake.seen.find((request) => request.path.endsWith('/takeover'))?.body as { confirm: unknown; workspace_root: string };
    assert.deepEqual(takeover.confirm, { holder_window_id: OLD.id, holder_since: since }, 'confirming the holder RAVIS names');
    const read = readLockFile(c.file);
    assert.deepEqual(read.kind === 'present' && [read.content.holder.window_id, read.content.takenOverFrom, read.content.ravis_lock_id], [WINDOW.id, OLD.id, row?.id]);
    assert.equal(outcome.kind === 'taken' && outcome.taskId, 'the-old-windows-task', 'the new holder carries the same task on');

    // The window taken over: fenced before its next edit, command, commit or checkpoint write, and it deletes nothing.
    assert.equal(await old.stillHolds('tool'), false);
    assert.equal(await old.stillHolds('commit'), false);
    const late = newCheckpoint({ taskId: 'the-old-windows-task', workspaceRoot: c.root, host: 'code-server', engine: 'clarvis', task: 'written after the takeover', now: new Date() });
    assert.deepEqual(await writeCheckpoint(c.root, c.gitDir, late, () => old.stillHolds('commit')), { kind: 'fenced' });
    assert.equal(await old.release(), 'lost');
    assert.equal(holderOf(c.file), WINDOW.id);
    if (outcome.kind === 'taken') assert.equal(await outcome.lock.release(), 'released');
  }));

test("a command the old window left running that won't stop keeps the takeover leftover: nothing is replaced, and it is named", () =>
  withCheckout(async (c) => {
    oldWindowsLock(c.file, 300);
    const offer = offerIn(await takeProjectLock(c.deps(WINDOW, { judge: async () => 'unresponsive' })));

    const outcome = await takeOverProjectLock(
      c.deps(WINDOW, { judge: async () => 'unresponsive', stopGroup: async () => ({ gone: false, survivors: [{ pid: 48211, comm: 'node', start: NPM.start }] }) }),
      offer
    );

    assert.equal(outcome.kind, 'leftover');
    assert.equal(outcome.kind === 'leftover' ? outcome.line : '', TAKEOVER_LINES.survivors([{ pid: 48211, comm: 'node', start: NPM.start }]));
    assert.equal(holderOf(c.file), OLD.id);
  }));

test("a lock that belongs to another folder is never taken over from here: nothing asked of RAVIS, nothing stopped, nothing replaced", () =>
  withCheckout(async (c) => {
    // This folder's lock in RAVIS is not the one the lock file names: the file was written for another folder's lock.
    c.locks.holdForWindow(c.root, OLD, { verdict: 'unresponsive' });
    oldWindowsLock(c.file, 300, { ravis_lock_id: 'pl_ANOTHERFOLDER000000000000' });
    const offer = offerIn(await takeProjectLock(c.deps(WINDOW, { judge: async () => 'unresponsive' })));
    const stopped: RunningCommand[] = [];

    const outcome = await takeOverProjectLock(c.deps(WINDOW, { judge: async () => 'unresponsive', stopGroup: async (command) => (stopped.push(command), { gone: true, signalled: 1 }) }), offer);

    assert.deepEqual(outcome, { kind: 'refused', line: TAKEOVER_LINES.otherFolder });
    assert.deepEqual(stopped, []);
    assert.equal(c.sent.some((line) => line.endsWith('/takeover')), false);
    assert.equal(holderOf(c.file), OLD.id);
    assert.equal(c.locks.takeovers.length, 0);
  }));

test("an enclosing folder's lock is another folder's lock, even under the id the file names: nothing asked of RAVIS, nothing stopped, nothing replaced", () =>
  withCheckout(async (c) => {
    const parent = path.dirname(c.root);
    const row = c.locks.holdForWindow(parent, OLD, { verdict: 'unresponsive' });
    oldWindowsLock(c.file, 300, { ravis_lock_id: row.id });
    const offer = offerIn(await takeProjectLock(c.deps(WINDOW, { locks: undefined, judge: async () => 'unresponsive' })));
    // The contract leaves nested roots open: this RAVIS answers for this folder with the enclosing folder's lock.
    const client = c.deps(WINDOW).locks as LockClient;
    const enclosing: LockClient = Object.assign(Object.create(client) as LockClient, {
      current: (_root: string, options: Parameters<LockClient['current']>[1]) => client.current(parent, options),
    });
    const stopped: RunningCommand[] = [];

    const outcome = await takeOverProjectLock(c.deps(WINDOW, { locks: enclosing, judge: async () => 'unresponsive', stopGroup: async (command) => (stopped.push(command), { gone: true, signalled: 1 }) }), offer);

    assert.deepEqual(outcome, { kind: 'refused', line: TAKEOVER_LINES.otherFolder });
    assert.deepEqual(stopped, []);
    assert.equal(c.sent.some((line) => line.endsWith('/takeover')), false);
    assert.equal(holderOf(c.file), OLD.id);
    assert.equal(c.locks.takeovers.length, 0);
  }));

test("RAVIS's root hash for a folder is the sha256 of its real path, as the fixtures' lock view has it", () => {
  assert.equal(rootHash('/Users/owner/Documents/coding/add-utc-demo'), 'sha256:c462152dbc1b3298da32ac6af3df54ec3f7ffd6a3328477ce9393b917bbddeeb');
  const folder = fs.realpathSync(os.tmpdir());
  assert.equal(rootHash(folder), `sha256:${createHash('sha256').update(folder).digest('hex')}`);
});

test('with RAVIS down, the lock file alone decides: the command is stopped, then the file replaced', () =>
  withCheckout(async (c) => {
    oldWindowsLock(c.file, 300);
    const offer = offerIn(await takeProjectLock(c.deps(WINDOW, { locks: undefined, judge: async () => 'unresponsive' })));
    await c.fake.stopListening();
    const stopped: RunningCommand[] = [];

    const outcome = await takeOverProjectLock(c.deps(WINDOW, { judge: async () => 'unresponsive', stopGroup: async (command) => (stopped.push(command), { gone: true, signalled: 1 }) }), offer);

    assert.equal(outcome.kind, 'taken');
    assert.deepEqual(stopped, [NPM]);
    const read = readLockFile(c.file);
    assert.deepEqual(read.kind === 'present' && [read.content.holder.window_id, read.content.takenOverFrom], [WINDOW.id, OLD.id]);
    if (outcome.kind === 'taken') await outcome.lock.release();
  }));

async function held(outcome: Promise<LockOutcome>): Promise<ProjectLock> {
  const taken = await outcome;
  if (!taken.held) throw new Error(`expected the lock, got: ${taken.line}`);
  return taken.lock;
}
