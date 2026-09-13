import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { test } from 'node:test';
import type { RunningCommand } from '../relay/relayTypes';
import { GROUP_KILL_TIMING, planGroupKill, stopCommandGroup, type GroupKillDeps } from './groupKill';
import { sameStart } from './lockRule';
import { describeProcess } from './processProbe';
import { snapshotProcesses, type ProcessRow } from './processTable';

/**
 * Stopping a command a Clarvis window left running, as a takeover must before the new holder writes
 * (design §6.3, final check F-A4): the whole group and every descendant, never a pid that now belongs to
 * someone else, a SIGKILL for what ignores SIGTERM, and confirmation — or the survivors, by name.
 *
 * The guard a person would notice missing: a takeover that killed only `npm` while its test workers went on
 * writing into the project the new holder had just started changing.
 */

const START = 'Sun Sep 13 05:41:07 2026';
const LATER = 'Sun Sep 13 05:41:09 2026';
const EARLIER = 'Sun Sep 13 05:00:00 2026';
const REUSED = 'Sun Sep 13 05:50:00 2026';
/** The extension host doing the killing. */
const SELF = 777;
const NPM: RunningCommand = { pid: 48210, pgid: 48210, start: START, comm: 'npm' };

const row = (pid: number, ppid: number, pgid: number, lstart = LATER, comm = 'node', stat = 'S'): ProcessRow => ({ pid, ppid, pgid, stat, lstart, comm });

const LAUNCHD = row(1, 0, 1, EARLIER, 'launchd', 'Ss');
const EDITOR = row(SELF, 1, SELF, EARLIER, 'Code Helper');
const LEADER = row(48210, SELF, 48210, START, 'npm');
const MEMBER = row(48211, 48210, 48210, LATER, 'node');
/** A test worker that moved into a group of its own. */
const WORKER = row(48300, 48211, 48300, LATER, 'node');
const GRANDCHILD = row(48301, 48300, 48300, LATER, 'esbuild');
const UNRELATED = row(50000, 1, 50000, LATER, 'Safari');

const pids = (rows: readonly { pid: number }[]) => rows.map((each) => each.pid).sort((a, b) => a - b);

// ── What the first snapshot decides ─────────────────────────────────────────

test('the group and every descendant started since the command are the targets; older processes, this one and launchd are not', () => {
  // A "child" older than the command can only be a parent pid that was reused: not something the command started.
  const older = row(48400, 48211, 48400, EARLIER, 'older');
  const plan = planGroupKill([LAUNCHD, EDITOR, LEADER, MEMBER, WORKER, GRANDCHILD, UNRELATED, older], NPM, SELF);

  assert.equal(plan.kind, 'group');
  assert.deepEqual(pids(plan.kind === 'group' ? plan.targets : []), [48210, 48211, 48300, 48301]);
});

test("a leader that is gone still leaves its group recognisable, and the members it left are the targets", () => {
  const orphan = row(48211, 1, 48210, LATER, 'node');
  const plan = planGroupKill([LAUNCHD, EDITOR, orphan, row(48300, 48211, 48300)], NPM, SELF);

  assert.deepEqual(pids(plan.kind === 'group' ? plan.targets : []), [48211, 48300]);
});

test('a pid now held by a process that started later is not the group: nothing is a target', () => {
  const plan = planGroupKill([LAUNCHD, EDITOR, row(48210, 1, 48210, REUSED, 'python3')], NPM, SELF);

  assert.deepEqual(plan, { kind: 'reused', survivors: [] });
});

test('a zombie has exited: it is not a target, and nothing waits for it', () => {
  const plan = planGroupKill([row(48210, SELF, 48210, START, 'npm', 'Z'), MEMBER], NPM, SELF);

  assert.deepEqual(pids(plan.kind === 'group' ? plan.targets : []), [48211]);
});

// ── Signalling and confirming, against a scripted process table ─────────────

interface World {
  deps: Partial<GroupKillDeps>;
  signals: [number, string][];
  /** How many snapshots were taken. */
  snapshots: () => number;
}

interface WorldRules {
  /** Pids that survive SIGTERM. */
  ignoreTerm?: number[];
  /** Pids nothing can stop. */
  unkillable?: number[];
  /** When this pid dies, another program is started with the same pid. */
  reuse?: ProcessRow;
  /** From this snapshot on (counting from 0), `ps` can't be read. */
  unreadableFrom?: number;
}

/**
 * A pretend Mac: signals really end processes (unless a rule says otherwise), snapshots show what is left,
 * and time passes only when the kill sleeps — so the grace and the confirmation are what the test sees.
 */
function world(initial: ProcessRow[], rules: WorldRules = {}): World {
  const signals: [number, string][] = [];
  let rows = [...initial];
  let taken = 0;
  let clock = 0;
  const survives = (target: ProcessRow, signal: string) =>
    (rules.unkillable ?? []).includes(target.pid) || (signal === 'SIGTERM' && (rules.ignoreTerm ?? []).includes(target.pid));
  const deps: Partial<GroupKillDeps> = {
    snapshot: async () => (taken++ >= (rules.unreadableFrom ?? Infinity) ? undefined : [...rows]),
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      const hit = rows.filter((each) => (pid < 0 ? each.pgid === -pid : each.pid === pid));
      const dead = hit.filter((each) => !survives(each, signal));
      rows = rows.filter((each) => !dead.includes(each));
      if (rules.reuse && dead.some((each) => each.pid === rules.reuse?.pid)) rows.push(rules.reuse);
    },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    self: SELF,
    timing: { graceMs: 20, confirmMs: 40, pollMs: 5 },
  };
  return { deps, signals, snapshots: () => taken };
}

test('SIGTERM goes to the group and to each descendant outside it; what ends then gets no SIGKILL', async () => {
  const script = world([EDITOR, LEADER, MEMBER, WORKER, UNRELATED]);

  const stopped = await stopCommandGroup(NPM, script.deps);

  assert.deepEqual(stopped, { gone: true, signalled: 3 });
  assert.deepEqual(script.signals, [
    [-48210, 'SIGTERM'],
    [48300, 'SIGTERM'],
  ]);
});

test('what ignores SIGTERM is killed after the grace, and a pid that ended and was reused meanwhile is never touched', async () => {
  const reusedWorkerPid = row(48300, 1, 48300, REUSED, 'Mail');
  const script = world([EDITOR, LEADER, MEMBER, WORKER], { ignoreTerm: [48211], reuse: reusedWorkerPid });

  const stopped = await stopCommandGroup(NPM, script.deps);

  assert.deepEqual(stopped, { gone: true, signalled: 3 });
  assert.deepEqual(script.signals, [
    [-48210, 'SIGTERM'],
    [48300, 'SIGTERM'],
    [-48210, 'SIGKILL'],
  ]);
  assert.equal(
    script.signals.some(([pid, signal]) => pid === 48300 && signal === 'SIGKILL'),
    false,
    'the program that took pid 48300 afterwards is left alone'
  );
});

test('a group with a stranger in it is signalled one process at a time', async () => {
  const stranger = row(48999, 1, 48210, EARLIER, 'stranger');
  const script = world([EDITOR, LEADER, stranger]);

  await stopCommandGroup(NPM, script.deps);

  assert.deepEqual(script.signals, [[48210, 'SIGTERM']]);
});

test('what is still there after the confirmation is named, and nothing counts as gone', async () => {
  const script = world([EDITOR, LEADER], { unkillable: [48210] });

  const stopped = await stopCommandGroup(NPM, script.deps);

  assert.deepEqual(stopped, { gone: false, survivors: [{ pid: 48210, comm: 'npm', start: START }] });
  assert.deepEqual(script.signals, [
    [-48210, 'SIGTERM'],
    [-48210, 'SIGKILL'],
  ]);
});

test('a ps that cannot be read, or a recorded start that is no time, is not knowing — never gone, and nothing is signalled', async () => {
  const unreadable = world([EDITOR, LEADER], { unreadableFrom: 0 });
  assert.deepEqual(await stopCommandGroup(NPM, unreadable.deps), { gone: undefined });

  const garbled = world([EDITOR, LEADER]);
  assert.deepEqual(await stopCommandGroup({ ...NPM, start: 'zo 13 sep. 05:41:07 2026' }, garbled.deps), { gone: undefined });
  assert.equal(garbled.snapshots(), 0, 'not even looked up');

  const afterTermUnreadable = world([EDITOR, LEADER], { ignoreTerm: [48210], unreadableFrom: 1 });
  assert.deepEqual(await stopCommandGroup(NPM, afterTermUnreadable.deps), { gone: undefined });
  assert.deepEqual([...unreadable.signals, ...garbled.signals], []);
});

test('the real timings are the contract’s: SIGKILL two seconds after SIGTERM, confirmation for up to three', () => {
  assert.deepEqual(GROUP_KILL_TIMING, { graceMs: 2_000, confirmMs: 3_000, pollMs: 100 });
});

// ── Real processes ───────────────────────────────────────────────────────────

/** The command's leader and everything under it, found through parent pids. */
function family(rows: ProcessRow[], leader: number): ProcessRow[] {
  const found = rows.filter((each) => each.pid === leader);
  for (let grew = true; grew; ) {
    grew = false;
    for (const each of rows) {
      if (found.some((member) => member.pid === each.pid) || !found.some((member) => member.pid === each.ppid)) continue;
      found.push(each);
      grew = true;
    }
  }
  return found;
}

async function waitForFamily(leader: number, size: number): Promise<ProcessRow[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const members = family((await snapshotProcesses()) ?? [], leader);
    if (members.length >= size && members.some((member) => member.pgid !== leader)) return members;
    if (Date.now() > deadline) throw new Error(`the command's family never grew to ${size}: ${JSON.stringify(members)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test(
  'a real command, a background child, a child ignoring SIGTERM and a grandchild in a group of its own are all stopped and confirmed gone',
  { skip: process.platform === 'win32' },
  async () => {
    // Started as Clarvis starts a command: detached, so the shell leads a process group of its own.
    const grandchild = `require('child_process').spawn('sleep', ['62'], { detached: true, stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    const script = ['sleep 60 &', '(trap "" TERM; exec sleep 61) &', `"${process.execPath}" -e "${grandchild}" &`, 'echo ready', 'wait'].join('\n');
    const leader = spawn('sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let members: ProcessRow[] = [];
    try {
      await new Promise<void>((resolve) => leader.stdout?.once('data', () => resolve()));
      const pid = leader.pid as number;
      // The shell, both sleeps, node, and the sleep node put in a group of its own.
      members = await waitForFamily(pid, 5);
      const described = await describeProcess(pid);
      assert.ok(described, 'ps described the command');

      const stopped = await stopCommandGroup(
        { pid, pgid: pid, start: described.start, comm: described.comm },
        { timing: { graceMs: 400, confirmMs: 3_000, pollMs: 50 } }
      );

      assert.equal(stopped.gone, true, JSON.stringify(stopped));
      const after = (await snapshotProcesses()) ?? [];
      const alive = members.filter((member) => after.some((each) => each.pid === member.pid && each.stat[0] !== 'Z' && sameStart(each.lstart, member.lstart)));
      assert.deepEqual(alive, [], 'every member of the family is gone, the SIGTERM-ignoring sleep included');
    } finally {
      // Whatever a failed assertion left behind, and only processes that are still the ones this test started.
      const after = (await snapshotProcesses()) ?? [];
      for (const member of members) {
        if (after.some((each) => each.pid === member.pid && sameStart(each.lstart, member.lstart))) {
          try {
            process.kill(member.pid, 'SIGKILL');
          } catch {
            // Gone already.
          }
        }
      }
      leader.stdout?.destroy();
    }
  }
);
