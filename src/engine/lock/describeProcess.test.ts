import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameStart } from './lockRule';
import { describeProcess, ownStart } from './processProbe';

/** When a command started and what it is, for the `running_command` a takeover would stop. */

test("ps's start time and command name come apart: five words of lstart, then the name", async () => {
  const run = async () => ({ code: 0, stdout: 'Sat Sep  5 05:41:07 2026     npm\n' });
  const described = await describeProcess(48210, run);

  assert.equal(described?.comm, 'npm');
  assert.equal(sameStart(described?.start ?? '', 'Sat Sep  5 05:41:07 2026'), true);
});

test("a pid ps knows nothing about, or can't describe, is undefined; a pid that can't be one isn't asked", async () => {
  assert.equal(await describeProcess(48210, async () => ({ code: 1, stdout: '' })), undefined);
  let asked = false;
  assert.equal(
    await describeProcess(-1, async () => {
      asked = true;
      return { code: 0, stdout: '' };
    }),
    undefined
  );
  assert.equal(asked, false);
});

test('this process, described by the real ps, starts when ownStart says it did', async () => {
  const described = await describeProcess(process.pid);
  const start = await ownStart();

  assert.ok(described && start, 'ps answered');
  assert.equal(sameStart(described.start, start), true);
});
