import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fixture } from '../../test/fakes/relayContract';
import {
  createLockFile,
  lockFilePath,
  parseLockFile,
  readLockFile,
  type CreateOutcome,
  type HeldLockFile,
  type LockFileContent,
} from './fileLock';

/**
 * The checkout lock file is the one writer rule's floor when RAVIS is down, so its promises are tested
 * on real files and, for the race, real processes: exactly one creator wins; a holder whose file was
 * replaced finds out, and can neither heartbeat over the new holder nor delete its file.
 */

const posix = process.platform !== 'win32';
const example = fixture('lock-rule-cases.json').lock_file.example;

function content(holder: Partial<LockFileContent['holder']> = {}, rest: Partial<LockFileContent> = {}): LockFileContent {
  return {
    ...example,
    engine: 'clarvis',
    ravis_lock_id: null,
    holder: {
      kind: 'clarvis_run',
      session_id: null,
      pid: 48123,
      pid_start: 'Sun Sep 13 05:10:02 2026',
      window_id: 'win-desktop-1c9e4d',
      host: 'desktop',
      since: '2026-09-13T01:42:00Z',
      ...holder,
    },
    ...rest,
  };
}

function held(outcome: CreateOutcome): HeldLockFile {
  if (!outcome.ok) throw new Error(`expected to take the lock: ${JSON.stringify(outcome)}`);
  return outcome.lock;
}

function withGitFolder(run: (file: string) => void | Promise<void>): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-lockfile-'));
  fs.mkdirSync(path.join(base, '.git'));
  return Promise.resolve(run(lockFilePath(base, path.join(base, '.git')))).finally(() => fs.rmSync(base, { recursive: true, force: true }));
}

test('the file lives in the git folder, or in .clarvis without git', () => {
  assert.equal(lockFilePath('/p', '/p/.git'), path.join('/p/.git', 'clarvis-engine.lock'));
  assert.equal(lockFilePath('/p', undefined), path.join('/p', '.clarvis', 'engine.lock'));
  assert.equal(lockFilePath('/p', ''), path.join('/p', '.clarvis', 'engine.lock'));
});

test("the contract's example is a lock file this module reads", () => {
  assert.deepEqual(parseLockFile(JSON.stringify(example)), example);
  assert.equal(parseLockFile('{"version": 2}'), undefined);
  assert.equal(parseLockFile('not json'), undefined);
});

test("a created file has the contract's fields, mode 0600, and reads back with its heartbeat's age", { skip: !posix }, () =>
  withGitFolder((file) => {
    held(createLockFile(file, content({}, { heartbeatAt: '2026-09-13T01:42:00Z' })));

    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), Object.keys(example).sort());
    assert.equal(fs.statSync(file).size % 1024, 0, 'padded to a whole KiB');
    const read = readLockFile(file, Date.parse('2026-09-13T01:42:30Z'));
    assert.equal(read.kind, 'present');
    assert.equal(read.kind === 'present' && read.heartbeatAgeSeconds, 30);
    assert.equal(read.kind === 'present' && read.content.holder.window_id, 'win-desktop-1c9e4d');
  }));

test('a second create finds the first holder and changes nothing', () =>
  withGitFolder((file) => {
    held(createLockFile(file, content()));
    const before = fs.readFileSync(file);
    const second = createLockFile(file, content({ window_id: 'win-code-server-7f3a2b', pid: 50211 }));

    assert.equal(second.ok, false);
    assert.equal(!second.ok && second.reason, 'exists');
    assert.equal(!second.ok && second.reason === 'exists' && second.existing.kind === 'present' && second.existing.content.holder.pid, 48123);
    assert.deepEqual(fs.readFileSync(file), before);
  }));

test('the atomic create holds under a race: of eight processes creating at once, exactly one wins', { skip: !posix }, () =>
  withGitFolder(async (file) => {
    const modulePath = path.join(__dirname, 'fileLock.js');
    const startAt = Date.now() + 1_500;
    // Every racer loads the module first, then waits for the same moment before creating.
    const script = `
      const { createLockFile } = require(${JSON.stringify(modulePath)});
      const content = JSON.parse(process.argv[1]);
      content.holder.pid = process.pid;
      setTimeout(() => {
        const outcome = createLockFile(${JSON.stringify(file)}, content);
        process.stdout.write(outcome.ok ? 'won' : outcome.reason);
      }, Math.max(0, ${startAt} - Date.now()));
    `;
    const racers = Array.from({ length: 8 }, () => runNode(script, [JSON.stringify(content())]));
    const results = await Promise.all(racers);

    assert.deepEqual(results.map((result) => result.stdout).sort(), ['exists', 'exists', 'exists', 'exists', 'exists', 'exists', 'exists', 'won']);
    const winner = results.find((result) => result.stdout === 'won');
    const read = readLockFile(file);
    assert.equal(read.kind === 'present' && read.content.holder.pid, winner?.pid, 'the file names the one that won');
  }));

test('a heartbeat rewrites the same file with the new heartbeat and running command', { skip: !posix }, () =>
  withGitFolder((file) => {
    const lock = held(createLockFile(file, content({}, { heartbeatAt: '2026-09-13T01:42:00Z' })));
    const inode = fs.statSync(file).ino;
    const command = { pid: 48210, pgid: 48210, start: 'Sun Sep 13 05:41:07 2026', comm: 'npm' };

    assert.equal(lock.heartbeat({ running_command: command, waitingOnYou: true }, new Date('2026-09-13T01:43:00Z')), 'written');
    const read = readLockFile(file);
    assert.equal(read.kind === 'present' && read.content.heartbeatAt, '2026-09-13T01:43:00.000Z');
    assert.deepEqual(read.kind === 'present' && read.content.running_command, command);
    assert.equal(read.kind === 'present' && read.content.waitingOnYou, true);
    assert.equal(fs.statSync(file).ino, inode);
    assert.equal(lock.check(), 'holds');
  }));

test("a holder whose file was replaced has lost the lock: it can't heartbeat over the new holder or delete its file", () =>
  withGitFolder((file) => {
    const first = held(createLockFile(file, content()));
    // What a takeover of a holder judged gone does: the old file goes, a new holder creates its own.
    fs.unlinkSync(file);
    const second = held(createLockFile(file, content({ window_id: 'win-code-server-7f3a2b', pid: 50211 })));
    const secondBytes = fs.readFileSync(file);

    assert.equal(first.check(), 'lost');
    assert.equal(first.heartbeat({ state: 'running' }), 'lost');
    assert.deepEqual(fs.readFileSync(file), secondBytes, "the new holder's lock is untouched");
    assert.equal(first.release(), 'lost');
    assert.equal(fs.existsSync(file), true, "the new holder's file is not deleted");

    assert.equal(second.check(), 'holds');
    assert.equal(second.release(), 'released');
    assert.equal(fs.existsSync(file), false);
  }));

test('a file rewritten to name someone else, or deleted, is lost too', () =>
  withGitFolder((file) => {
    const lock = held(createLockFile(file, content()));
    fs.writeFileSync(file, JSON.stringify(content({ window_id: 'win-code-server-7f3a2b' })));
    assert.equal(lock.check(), 'lost');

    fs.unlinkSync(file);
    assert.equal(lock.check(), 'lost');
  }));

test("a file that can't be read right now is unknown — never lost — and release waits", () =>
  withGitFolder((file) => {
    const lock = held(createLockFile(file, content()));
    fs.writeFileSync(file, '{"version": 3, "holder": {"ki');

    assert.equal(lock.check(), 'unknown');
    assert.equal(lock.heartbeat(), 'unknown');
    assert.equal(lock.release(), 'unknown');
    assert.equal(fs.existsSync(file), true);
  }));

test('without git, the file goes in .clarvis, which is made if needed', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-lockfile-nogit-'));
  try {
    const file = lockFilePath(base, undefined);
    const lock = held(createLockFile(file, content()));

    assert.equal(fs.existsSync(path.join(base, '.clarvis', 'engine.lock')), true);
    assert.equal(lock.release(), 'released');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function runNode(script: string, args: string[]): Promise<{ stdout: string; pid: number | undefined; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script, ...args], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ stdout, pid: child.pid, code }));
  });
}
