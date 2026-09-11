import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { stopProcessGroup } from './processGroup';

test('a group with something still running is stopped as a whole', () => {
  const calls: [number, string | number | undefined][] = [];
  const kill = (pid: number, signal?: string | number): true => {
    calls.push([pid, signal]);
    return true;
  };

  assert.equal(stopProcessGroup(4242, kill, 'darwin'), true);
  // The minus is the point: it addresses the whole group, not the one process.
  assert.deepEqual(calls, [
    [-4242, 0],
    [-4242, 'SIGKILL'],
  ]);
});

test('an empty group, a missing pid, or Windows leaves the caller to kill the child itself', () => {
  const gone = (): true => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  };

  assert.equal(stopProcessGroup(4242, gone, 'darwin'), false);
  assert.equal(stopProcessGroup(undefined, () => true, 'darwin'), false);
  assert.equal(stopProcessGroup(4242, () => true, 'win32'), false);
});

test(
  'a program the command started in the background is really stopped, not only the shell',
  { skip: process.platform === 'win32' },
  async () => {
    // Found live, 11 September 2026: killing the shell left `python3 main.py` running
    // with the output pipe open, and the run could not end.
    const child = spawn('sh', ['-c', 'sleep 30 & echo started; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
    const pid = child.pid!;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));

    assert.equal(stopProcessGroup(pid), true);
    await exited;
    child.stdout!.destroy();

    // The backgrounded sleep has to go too; give the system a moment to reap it.
    let empty = false;
    for (let attempt = 0; attempt < 20 && !empty; attempt++) {
      try {
        process.kill(-pid, 0);
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        empty = true;
      }
    }
    assert.equal(empty, true, 'nothing may be left in the group — the backgrounded sleep included');
  }
);
