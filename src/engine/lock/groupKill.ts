/**
 * Stopping a command another Clarvis window left running, with everything it started, and making sure it
 * is gone (plan.md M15, C2a; design §6.3; `project-locks.json` group_kill_at_takeover; final check F-A4).
 *
 * **When.** A window takes a project whose lock names another window — one the shared lock rule judged
 * gone, or one the owner confirmed taking over — and that window's lock file records the command it had
 * running (`running_command`: pid, process group, start time, name). Before the new holder writes a byte,
 * that command has to stop. RAVIS does it when it is up (R4); the window does it when RAVIS is down, and
 * checks again after RAVIS says it did — which then finds nothing to signal.
 *
 * **Why the whole group, and descendants.** Killing only the pid leaves its children writing: `npm test`
 * starts workers. Clarvis starts every command as the leader of a process group of its own
 * (`commandTools.ts`), so the group is the command's; a child that moved into a group of its own is still
 * found, by walking parent pids.
 *
 * **The contract's order:**
 * 1. snapshot every process (`processTable.ts`);
 * 2. is it still that group? Not when the recorded pid now belongs to a process that started at another
 *    time: the pid was reused, so nothing is signalled by group (a group id isn't reused while members
 *    remain, so a leader that is simply gone still leaves its group recognisable);
 * 3. targets: the group's members and every descendant of the command or a member, each started at or after
 *    the recorded start — a process older than the command can't be one it started;
 * 4. SIGTERM the group and each target outside it, wait 2 s, then SIGKILL whatever is still the same
 *    process;
 * 5. confirm, for up to 3 s, that no target is alive with its start time. Otherwise the survivors are named,
 *    and the takeover stays `leftover`.
 *
 * **Never a pid on its own say-so.** After the first snapshot, a signal goes only to a process whose pid and
 * start time still match a target, so a pid that ended and was taken by an unrelated program is never
 * touched. The group itself is signalled only while every live member of it is a target. This process and
 * launchd are never targets.
 *
 * **Not the Codex rule.** Codex's commands share RAVIS's one app-server group across projects, so a Codex
 * kill never uses a group (design §4.5). That is RAVIS's; nothing here touches a Codex process.
 *
 * Residual gap, as the design records it: a child that fully detached itself (reparented to launchd) before
 * the snapshot isn't found.
 */

import type { RunningCommand } from '../relay/relayTypes';
import { sameStart } from './lockRule';
import { hasExited, snapshotProcesses, startedAtMs, type ProcessRow } from './processTable';

export const GROUP_KILL_TIMING = { graceMs: 2_000, confirmMs: 3_000, pollMs: 100 };

export interface GroupKillDeps {
  snapshot: () => Promise<ProcessRow[] | undefined>;
  /** Sends a signal; a negative pid is a whole group. Must not throw for a process that is already gone. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** This process, never a target. */
  self: number;
  timing: typeof GROUP_KILL_TIMING;
}

/** What the first snapshot says to do. */
export type GroupPlan =
  | { kind: 'group'; targets: ProcessRow[] }
  /** The recorded pid belongs to a later process now: nothing is signalled, and anything unaccounted for is named. */
  | { kind: 'reused'; survivors: ProcessRow[] };

export interface Survivor {
  pid: number;
  comm: string;
  start: string;
}

export type GroupStop =
  | { gone: true; signalled: number }
  | { gone: false; survivors: Survivor[] }
  /** `ps` couldn't be read, or the recorded start time isn't one: not knowing is never "gone". */
  | { gone: undefined };

/** The targets a snapshot gives for a recorded command (steps 2 and 3). Pure. */
export function planGroupKill(rows: ProcessRow[], command: RunningCommand, self: number): GroupPlan {
  const since = startedAtMs(command.start) ?? Number.POSITIVE_INFINITY;
  const live = rows.filter((row) => !hasExited(row) && row.pid !== self && row.pid > 1);
  const holder = live.find((row) => row.pid === command.pid);
  if (holder && !sameStart(holder.lstart, command.start)) {
    return { kind: 'reused', survivors: reusedSurvivors(live, command, holder, since) };
  }
  const members = live.filter((row) => row.pgid === command.pgid && startedAt(row) >= since);
  return { kind: 'group', targets: withDescendants(live, members, command, since) };
}

/** Stops a recorded command, its group and its descendants, and confirms they are gone (steps 1–5). */
export async function stopCommandGroup(command: RunningCommand, overrides: Partial<GroupKillDeps> = {}): Promise<GroupStop> {
  const deps: GroupKillDeps = { ...defaultDeps(), ...overrides };
  const rows = startedAtMs(command.start) === undefined ? undefined : await deps.snapshot();
  if (!rows) return { gone: undefined };
  const plan = planGroupKill(rows, command, deps.self);
  if (plan.kind === 'reused') return plan.survivors.length === 0 ? { gone: true, signalled: 0 } : leftover(plan.survivors);
  if (plan.targets.length === 0) return { gone: true, signalled: 0 };
  return terminate(plan.targets, rows, command, deps);
}

/** Steps 4 and 5: SIGTERM, a grace, SIGKILL for whatever is still the same process, then confirmation. */
async function terminate(targets: ProcessRow[], rows: ProcessRow[], command: RunningCommand, deps: GroupKillDeps): Promise<GroupStop> {
  signalTargets(targets, rows, command, 'SIGTERM', deps);
  const afterTerm = await stillAlive(targets, deps.timing.graceMs, deps);
  if (afterTerm === undefined) return { gone: undefined };
  if (afterTerm.alive.length > 0) signalTargets(afterTerm.alive, afterTerm.rows, command, 'SIGKILL', deps);
  const confirmed = afterTerm.alive.length > 0 ? await stillAlive(targets, deps.timing.confirmMs, deps) : afterTerm;
  if (confirmed === undefined) return { gone: undefined };
  return confirmed.alive.length === 0 ? { gone: true, signalled: targets.length } : leftover(confirmed.alive);
}

/**
 * Signals the group while every live member of it is a target, and each target outside it by pid. `rows` is
 * the snapshot the targets were checked against, so a group with a stranger in it is signalled one by one.
 */
function signalTargets(targets: ProcessRow[], rows: ProcessRow[], command: RunningCommand, signal: NodeJS.Signals, deps: GroupKillDeps): void {
  const ours = new Set(targets.map((row) => row.pid));
  const group = rows.filter((row) => row.pgid === command.pgid && !hasExited(row));
  const byGroup = group.length > 0 && group.every((row) => ours.has(row.pid));
  if (byGroup) deps.kill(-command.pgid, signal);
  for (const row of targets) {
    if (!byGroup || row.pgid !== command.pgid) deps.kill(row.pid, signal);
  }
}

/**
 * Polls until no target is alive with its start time, or `ms` runs out. Returns the survivors and the last
 * snapshot, or undefined once `ps` stops answering.
 */
async function stillAlive(targets: ProcessRow[], ms: number, deps: GroupKillDeps): Promise<{ alive: ProcessRow[]; rows: ProcessRow[] } | undefined> {
  const deadline = deps.now() + ms;
  for (;;) {
    const rows = await deps.snapshot();
    if (!rows) return undefined;
    const alive = targets.filter((target) => rows.some((row) => sameProcess(row, target)));
    if (alive.length === 0 || deps.now() >= deadline) return { alive, rows };
    await deps.sleep(deps.timing.pollMs);
  }
}

function sameProcess(row: ProcessRow, target: ProcessRow): boolean {
  return row.pid === target.pid && !hasExited(row) && sameStart(row.lstart, target.lstart);
}

/** The group's members, then every live descendant of the command or of anything already chosen. */
function withDescendants(live: ProcessRow[], members: ProcessRow[], command: RunningCommand, since: number): ProcessRow[] {
  const chosen = new Map(members.map((row) => [row.pid, row]));
  const parents = new Set([command.pid, command.pgid, ...chosen.keys()]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of live) {
      if (chosen.has(row.pid) || !parents.has(row.ppid) || startedAt(row) < since) continue;
      chosen.set(row.pid, row);
      parents.add(row.pid);
      grew = true;
    }
  }
  return [...chosen.values()];
}

/**
 * After a reuse, what still carries the old group id but can't belong to the process that took the pid,
 * because it started before that process did. A group id isn't reused while members remain, so this is
 * normally empty; if it isn't, it is named rather than signalled.
 */
function reusedSurvivors(live: ProcessRow[], command: RunningCommand, holder: ProcessRow, since: number): ProcessRow[] {
  const taken = startedAt(holder);
  return live.filter((row) => row.pid !== holder.pid && row.pgid === command.pgid && startedAt(row) >= since && startedAt(row) < taken);
}

function startedAt(row: ProcessRow): number {
  return startedAtMs(row.lstart) ?? Number.NEGATIVE_INFINITY;
}

function leftover(rows: ProcessRow[]): GroupStop {
  return { gone: false, survivors: rows.map((row) => ({ pid: row.pid, comm: row.comm, start: row.lstart })) };
}

function defaultDeps(): GroupKillDeps {
  return {
    snapshot: () => snapshotProcesses(),
    kill: (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch {
        // Already gone between the snapshot and the signal: exactly what the kill wanted.
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    self: process.pid,
    timing: GROUP_KILL_TIMING,
  };
}
