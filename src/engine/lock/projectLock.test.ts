import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { CLARVIS_CREDENTIAL, FakeRavisRelay, FIXTURE_LOCK, FIXTURE_SESSION } from '../../test/fakes/FakeRavisRelay';
import { RelayHttp, relayEndpoint } from '../relay/relayHttp';
import type { RunningCommand } from '../relay/relayTypes';
import { encodeLockFile, lockFilePath, readLockFile, type LockFileContent } from './fileLock';
import { LockClient } from './lockClient';
import type { GroupStop } from './groupKill';
import type { Verdict } from './lockRule';
import { LOCK_LINES, takeProjectLock, type ProjectLock, type ProjectLockDeps } from './projectLock';

/**
 * One writer per project for Clarvis's own engine: the lock file first, then RAVIS's lock; the fence that
 * stops a run which lost the project; and the rules for a lock file that is already there. Every request
 * the lock makes is held to RAVIS's fixtures by the fake.
 */

const WINDOW = { id: 'win-desktop-1c9e4d', host: 'desktop' as const };
const OTHER = { id: 'win-code-server-7f3a2b', host: 'code-server' as const };
const LOCKS = 'POST /api/v1/project-locks';
const NPM: RunningCommand = { pid: 48210, pgid: 48210, start: 'Sun Sep 13 05:41:07 2026', comm: 'npm' };

interface Project {
  root: string;
  gitDir: string;
  file: string;
  fake: FakeRavisRelay;
  /** RAVIS's lock API, noting for each request whether the lock file existed when it was sent. */
  locks: LockClient;
  requests: { method: string; path: string; fileExisted: boolean }[];
  log: string[];
  deps(overrides?: Partial<ProjectLockDeps>): ProjectLockDeps;
}

async function withProject(run: (project: Project) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-project-lock-')));
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir);
  const file = lockFilePath(root, gitDir);
  const fake = await FakeRavisRelay.start();
  const requests: Project['requests'] = [];
  const log: string[] = [];
  const endpoint = relayEndpoint(fake.url, CLARVIS_CREDENTIAL);
  if (!endpoint.ok) throw new Error(endpoint.reason);
  const locks = new LockClient(
    new RelayHttp(endpoint.endpoint, (input, init) => {
      requests.push({ method: init?.method ?? 'GET', path: new URL(String(input)).pathname, fileExisted: fs.existsSync(file) });
      return fetch(input, init);
    })
  );
  const deps = (overrides: Partial<ProjectLockDeps> = {}): ProjectLockDeps => ({
    root,
    gitDir,
    taskId: '8b1c2d3e-4f50-4a61-9b72-83c4d5e6f708',
    window: WINDOW,
    pid: process.pid,
    pidStart: 'Sun Sep 13 05:10:02 2026',
    locks,
    judge: async () => 'alive',
    stopGroup: async () => ({ gone: true, signalled: 1 }),
    every: () => () => undefined,
    log: (line) => log.push(line),
    ...overrides,
  });
  try {
    await run({ root, gitDir, file, fake, locks, requests, log, deps });
    assert.deepEqual(fake.violations, [], 'every lock request and answer matched the fixtures');
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function held(outcome: Awaited<ReturnType<typeof takeProjectLock>>): Promise<ProjectLock> {
  if (!outcome.held) throw new Error(`expected the lock, got: ${outcome.line}`);
  return outcome.lock;
}

/** A lock file some other process wrote. */
function writeForeignLock(file: string, holder: Partial<LockFileContent['holder']>, rest: Partial<LockFileContent> = {}): void {
  const content: LockFileContent = {
    version: 3,
    ravis_lock_id: null,
    taskId: 'another-task',
    engine: 'clarvis',
    state: 'running',
    holder: { kind: 'clarvis_run', session_id: null, pid: 999_999, pid_start: 'Sun Sep 13 01:00:00 2026', window_id: OTHER.id, host: OTHER.host, since: '2026-09-13T01:12:00Z', ...holder },
    heartbeatAt: new Date().toISOString(),
    waitingOnYou: false,
    leftover: [],
    takenOverFrom: null,
    running_command: null,
    ...rest,
  };
  fs.writeFileSync(file, encodeLockFile(content), { mode: 0o600 });
}

const holderOf = (file: string) => {
  const read = readLockFile(file);
  return read.kind === 'present' ? read.content.holder.window_id : read.kind;
};

// ── Taking and holding ───────────────────────────────────────────────────────

test('a run takes the lock file first, then RAVIS’s lock, and holds both', () =>
  withProject(async (project) => {
    const lock = await held(await takeProjectLock(project.deps()));

    const acquire = project.fake.seen.find((request) => request.method === 'POST' && request.path === '/api/v1/project-locks');
    assert.deepEqual(acquire?.body, {
      workspace_root: project.root,
      clarvis_task_id: '8b1c2d3e-4f50-4a61-9b72-83c4d5e6f708',
      holder: { kind: 'clarvis_run', window_id: WINDOW.id, host: 'desktop', pid: process.pid, pid_start: 'Sun Sep 13 05:10:02 2026' },
      git_dir: project.gitDir,
    });
    assert.equal(project.requests[0].fileExisted, true, 'the file was created before RAVIS was asked');
    assert.equal(lock.ravisLockId, FIXTURE_LOCK.id);
    const read = readLockFile(project.file);
    assert.deepEqual(read.kind === 'present' && [read.content.holder.window_id, read.content.ravis_lock_id], [WINDOW.id, FIXTURE_LOCK.id]);
    assert.equal(await lock.stillHolds('tool'), true);
    assert.equal(await lock.release(), 'released');
  }));

test('RAVIS refusing because a Codex session holds the project removes the file, and names the session to follow', () =>
  withProject(async (project) => {
    project.fake.reply(LOCKS, 'a Codex session holds it: attach instead');

    const outcome = await takeProjectLock(project.deps());

    assert.deepEqual(outcome, { held: false, line: LOCK_LINES.codex, attachSessionId: FIXTURE_SESSION.id });
    assert.equal(fs.existsSync(project.file), false, 'the file this run made is gone again');
  }));

test('RAVIS refusing because another window holds the project says whether it is working or stalled', () =>
  withProject(async (project) => {
    project.fake.reply(LOCKS, 'an unresponsive Clarvis window holds it');

    const outcome = await takeProjectLock(project.deps());

    assert.equal(outcome.held, false);
    assert.match(outcome.held ? '' : outcome.line, /isn't answering/);
    assert.equal(fs.existsSync(project.file), false);
  }));

test('RAVIS not answering leaves the run on the lock file alone, and it registers with adopt_file_lock once RAVIS is back', () =>
  withProject(async (project) => {
    await project.fake.stopListening();
    const lock = await held(await takeProjectLock(project.deps()));
    assert.equal(lock.ravisLockId, undefined);
    assert.equal(await lock.stillHolds('tool'), true, 'RAVIS being away is not losing the lock');

    await project.fake.listenAgain();
    await lock.stillHolds('commit'); // the heartbeat before a commit re-registers

    const adopted = project.fake.seen.find((request) => request.path === '/api/v1/project-locks');
    assert.equal((adopted?.body as { adopt_file_lock?: boolean }).adopt_file_lock, true);
    assert.equal(lock.ravisLockId, FIXTURE_LOCK.id);
    await lock.release();
  }));

test('a 422 for the folder means RAVIS doesn’t govern it: the file keeps one writer, and RAVIS isn’t asked again', () =>
  withProject(async (project) => {
    project.fake.reply(LOCKS, "the ecosystem's own repository");
    const lock = await held(await takeProjectLock(project.deps()));

    await lock.stillHolds('commit');
    await lock.stillHolds('commit');

    assert.equal(project.requests.filter((request) => request.path === '/api/v1/project-locks').length, 1);
    assert.equal(fs.existsSync(project.file), true);
    assert.equal(await lock.release(), 'released');
  }));

// ── The fence ────────────────────────────────────────────────────────────────

test('LEASE_REVOKED is the fence: the run no longer holds, and letting go deletes nothing and tells RAVIS nothing', () =>
  withProject(async (project) => {
    const lock = await held(await takeProjectLock(project.deps()));
    project.fake.revokeLease(FIXTURE_LOCK.lease, OTHER.id);

    assert.equal(await lock.stillHolds('commit'), false);
    assert.equal(await lock.release(), 'lost');
    assert.equal(fs.existsSync(project.file), true, 'the file is not this run’s to delete any more');
    assert.equal(project.requests.some((request) => request.path.endsWith('/release')), false);
  }));

test('a revoked lease stays lost, even when RAVIS then stops answering', () =>
  withProject(async (project) => {
    const lock = await held(await takeProjectLock(project.deps()));
    project.fake.revokeLease(FIXTURE_LOCK.lease, OTHER.id);
    assert.equal(await lock.stillHolds('commit'), false);

    await project.fake.stopListening();

    assert.equal(await lock.stillHolds('commit'), false, 'silence afterwards does not give the project back');
    assert.equal(await lock.stillHolds('tool'), false);
    assert.equal(await lock.release(), 'lost');
  }));

test('a lock file that names another window now is the fence too', () =>
  withProject(async (project) => {
    const lock = await held(await takeProjectLock(project.deps({ locks: undefined })));
    fs.rmSync(project.file);
    writeForeignLock(project.file, {});

    assert.equal(await lock.stillHolds('tool'), false);
    assert.equal(await lock.release(), 'lost');
    assert.equal(holderOf(project.file), OTHER.id, 'the other window’s file is left as it is');
  }));

test('RAVIS not answering a heartbeat is never loss', () =>
  withProject(async (project) => {
    const lock = await held(await takeProjectLock(project.deps()));
    await project.fake.stopListening();

    assert.equal(await lock.stillHolds('commit'), true);
    assert.equal(await lock.stillHolds('tool'), true);
  }));

test('letting go is RAVIS first, then the file, once the run is done', () =>
  withProject(async (project) => {
    const lock = await held(await takeProjectLock(project.deps()));

    assert.equal(await lock.release(), 'released');

    const release = project.requests.find((request) => request.path.endsWith('/release'));
    assert.equal(release?.fileExisted, true, 'the file outlives the RAVIS release');
    const sent = project.fake.seen.find((request) => request.path.endsWith('/release'));
    assert.deepEqual([sent?.headers['x-lock-lease'], sent?.body], [FIXTURE_LOCK.lease, { processes_confirmed_gone: true }]);
    assert.equal(fs.existsSync(project.file), false);
  }));

test('the command a run has going is written into the lock file and sent with the heartbeat, and cleared after', () =>
  withProject(async (project) => {
    const lock = await held(await takeProjectLock(project.deps()));

    lock.commandStarted(NPM);
    const during = readLockFile(project.file);
    assert.deepEqual(during.kind === 'present' && during.content.running_command, NPM);
    await lock.stillHolds('commit');
    const heartbeat = project.fake.seen.find((request) => request.path.endsWith('/heartbeat'));
    assert.deepEqual((heartbeat?.body as { running_command: unknown }).running_command, NPM);

    lock.commandEnded();
    const after = readLockFile(project.file);
    assert.equal(after.kind === 'present' && after.content.running_command, null);
    await lock.release();
  }));

// ── Finding a lock file already there ────────────────────────────────────────

test("a Codex session's lock file is never taken: the run is refused and pointed at the session", () =>
  withProject(async (project) => {
    writeForeignLock(project.file, { kind: 'codex_session', session_id: FIXTURE_SESSION.id, window_id: null, host: 'ravis' }, { engine: 'codex' });

    const outcome = await takeProjectLock(project.deps({ locks: undefined }));

    assert.deepEqual(outcome, { held: false, line: LOCK_LINES.codex, attachSessionId: FIXTURE_SESSION.id });
  }));

test("this window's own leftover is replaced, but a lock this window holds right now refuses a second run", () =>
  withProject(async (project) => {
    writeForeignLock(project.file, { window_id: WINDOW.id, host: 'desktop', pid: process.pid });
    const first = await held(await takeProjectLock(project.deps({ locks: undefined })));
    assert.equal(holderOf(project.file), WINDOW.id);

    const second = await takeProjectLock(project.deps({ locks: undefined }));
    assert.deepEqual(second, { held: false, line: LOCK_LINES.here });
    await first.release();
  }));

test("another window's lock file is judged by the shared rule", () =>
  withProject(async (project) => {
    const npmLeftRunning: GroupStop = { gone: false, survivors: [{ pid: 48210, comm: 'npm', start: NPM.start }] };
    const cases: { verdict: Verdict | undefined; waiting?: boolean; command?: RunningCommand; stop?: GroupStop; expect: RegExp | 'taken' }[] = [
      { verdict: 'alive', expect: /is working on this project/ },
      { verdict: 'alive', waiting: true, expect: /isn't answering, or is waiting on you/ },
      { verdict: 'unresponsive', expect: /isn't answering/ },
      { verdict: undefined, expect: /couldn't be checked/ },
      { verdict: 'gone', command: NPM, stop: npmLeftRunning, expect: /still running and wouldn't stop: `npm` \(pid 48210\)/ },
      { verdict: 'gone', command: NPM, stop: { gone: undefined }, expect: /may still be running \(`npm`, pid 48210\), and whether it stopped couldn't be checked/ },
      { verdict: 'gone', command: NPM, stop: { gone: true, signalled: 3 }, expect: 'taken' },
      { verdict: 'gone', expect: 'taken' },
    ];

    for (const each of cases) {
      fs.rmSync(project.file, { force: true });
      writeForeignLock(project.file, {}, { waitingOnYou: each.waiting ?? false, running_command: each.command ?? null });
      const outcome = await takeProjectLock(
        project.deps({ locks: undefined, judge: async () => each.verdict, stopGroup: async () => each.stop ?? { gone: undefined } })
      );
      const label = JSON.stringify(each);
      if (each.expect === 'taken') {
        await held(outcome).then((lock) => lock.release());
        continue;
      }
      assert.equal(outcome.held, false, label);
      assert.match(outcome.held ? '' : outcome.line, each.expect, label);
      assert.equal(holderOf(project.file), OTHER.id, `${label}: the other window's file is untouched`);
    }
  }));
