import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawn } from 'child_process';
import { judgeLock } from './lockRule';
import { observerAwakeSeconds, ownStart, parseSysctlSeconds, probeProcess, type Runner } from './processProbe';

/**
 * The lock rule is only as good as what it is told about the holder's process, so these run the real
 * `ps` against real processes — this test's own, and a child killed mid-test — rather than trusting a
 * description of what `ps` prints.
 */

const posix = process.platform !== 'win32';

test("this process is running, and its start time is what ps prints in the C locale", { skip: !posix }, async () => {
  const printed = execFileSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { env: { ...process.env, LC_ALL: 'C' } })
    .toString()
    .trim()
    .replace(/\s+/g, ' ');

  assert.deepEqual(await probeProcess(process.pid), { pid_running: true, lstart: printed });
  assert.match(printed, /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/, 'the fixtures\' form, e.g. "Sun Sep 13 05:10:02 2026"');
  assert.equal(await ownStart(), printed);
});

test('the start time is read in the C locale even when the editor runs in Dutch, so both sides write the same text', { skip: process.platform !== 'darwin' }, async () => {
  // Measured on this Mac, 13 Sep 2026: `LC_ALL=nl_NL.UTF-8 ps -o lstart=` prints "zo 13 sep. 11:06:32 2026".
  // A holder recorded in one locale and probed in another would look gone while it is running.
  const saved = process.env.LC_ALL;
  process.env.LC_ALL = 'nl_BE.UTF-8';
  try {
    const probe = await probeProcess(process.pid);
    assert.match(probe?.lstart ?? '', /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/);
  } finally {
    if (saved === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = saved;
  }
});

test('a live holder is alive; once its process exits, the same lock is gone', { skip: !posix }, async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const pid = child.pid as number;

  const running = await probeProcess(pid);
  assert.equal(running?.pid_running, true);
  const lock = { pid, pid_start: running?.lstart as string, heartbeat_age_seconds: 3 };
  assert.equal(judgeLock(lock, running!, 600), 'alive');

  child.kill('SIGKILL');
  await exited;
  const after = await probeProcess(pid);
  assert.deepEqual(after, { pid_running: false, lstart: null });
  assert.equal(judgeLock(lock, after!, 600), 'gone');
});

test("a pid ps doesn't know is not running; a ps that couldn't run is not knowing, never 'not running'", async () => {
  const notRunning: Runner = async () => ({ code: 1, stdout: '' });
  const couldNotRun: Runner = async () => ({ code: null, stdout: '' });

  assert.deepEqual(await probeProcess(4242, notRunning), { pid_running: false, lstart: null });
  assert.equal(await probeProcess(4242, couldNotRun), undefined, 'a failed probe must not become a gone verdict');
  assert.deepEqual(await probeProcess(0), { pid_running: false, lstart: null });
  assert.deepEqual(await probeProcess(-1), { pid_running: false, lstart: null });
});

test('the observer counts from its last wake, or from boot when it never slept', async () => {
  assert.equal(parseSysctlSeconds('{ sec = 1789231177, usec = 263628 } Sat Sep 12 18:39:37 2026'), 1789231177);
  assert.equal(parseSysctlSeconds('{ sec = 0, usec = 0 } Thu Jan  1 01:00:00 1970'), 0);
  assert.equal(parseSysctlSeconds('no such sysctl'), undefined);

  const outputs: Record<string, string> = {
    'kern.waketime': '{ sec = 0, usec = 0 } Thu Jan  1 01:00:00 1970',
    'kern.boottime': '{ sec = 1000, usec = 5 } Thu Jan  1 01:16:40 1970',
  };
  const run: Runner = async (_file, args) => ({ code: 0, stdout: outputs[args[1]] ?? '' });

  assert.equal(await observerAwakeSeconds(1_600_000, run, 'darwin'), 600, 'never slept: since boot');
  outputs['kern.waketime'] = '{ sec = 1500, usec = 0 } Thu Jan  1 01:25:00 1970';
  assert.equal(await observerAwakeSeconds(1_600_000, run, 'darwin'), 100, 'slept: since the wake');
  outputs['kern.boottime'] = '';
  outputs['kern.waketime'] = '';
  assert.equal(await observerAwakeSeconds(1_600_000, run, 'darwin'), undefined);
});

test('on this Mac the observer has been awake a real, non-negative number of seconds', { skip: process.platform !== 'darwin' }, async () => {
  const awake = await observerAwakeSeconds();

  assert.equal(typeof awake, 'number');
  assert.ok((awake as number) >= 0);
  assert.ok((awake as number) < 400 * 24 * 3600, 'more than a year awake means the wrong field was read');
});
