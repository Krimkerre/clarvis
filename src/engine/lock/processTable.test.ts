import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameStart } from './lockRule';
import { ownStart } from './processProbe';
import { hasExited, parseProcessTable, snapshotProcesses, startedAtMs } from './processTable';

/**
 * Every process on the Mac, as the group kill reads it: three numbers, a state, five words of start time
 * and a command name that may hold spaces — and a `ps` that couldn't be read is not an empty table.
 */

test("ps's lines come apart into pid, parent, group, state, start and name — padded days and spaced names included", () => {
  const text = [
    '    1     0     1 Ss   Sat Sep  5 09:10:37 2026     /sbin/launchd',
    '48210 48123 48210 S+   Sun Sep 13 05:41:07 2026     npm',
    '48300 48210 48300 Z    Sun Sep 13 05:41:09 2026     Google Chrome Helper (Renderer)',
    'garbage that is not a process line',
    '',
  ].join('\n');

  const rows = parseProcessTable(text);

  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, pgid: 1, stat: 'Ss', lstart: 'Sat Sep  5 09:10:37 2026', comm: '/sbin/launchd' },
    { pid: 48210, ppid: 48123, pgid: 48210, stat: 'S+', lstart: 'Sun Sep 13 05:41:07 2026', comm: 'npm' },
    { pid: 48300, ppid: 48210, pgid: 48300, stat: 'Z', lstart: 'Sun Sep 13 05:41:09 2026', comm: 'Google Chrome Helper (Renderer)' },
  ]);
  assert.deepEqual(rows.map(hasExited), [false, false, true], 'only the zombie has exited');
});

test('a start time reads the same however it is padded, orders by the second, and anything else is no time at all', () => {
  assert.equal(startedAtMs('Sat Sep  5 09:10:37 2026'), startedAtMs('Sat Sep 5 09:10:37 2026'));
  assert.ok((startedAtMs('Sun Sep 13 05:41:08 2026') ?? 0) > (startedAtMs('Sun Sep 13 05:41:07 2026') ?? 0));
  // A Dutch ps writes this; the C locale never does, so it is not a time the rule can compare.
  assert.equal(startedAtMs('zo 13 sep. 05:41:07 2026'), undefined);
  assert.equal(startedAtMs('yesterday'), undefined);
});

test("a ps that fails or prints nothing is not knowing, never an empty table; the real one lists this process as ownStart says", async () => {
  assert.equal(await snapshotProcesses(async () => ({ code: 1, stdout: '' })), undefined);
  assert.equal(await snapshotProcesses(async () => ({ code: 0, stdout: '' })), undefined);

  const rows = await snapshotProcesses();
  const me = rows?.find((row) => row.pid === process.pid);
  const start = await ownStart();

  assert.ok(me && start, 'the real ps answered and listed this process');
  assert.equal(me.ppid, process.ppid);
  assert.equal(sameStart(me.lstart, start), true);
});
