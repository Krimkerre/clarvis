/**
 * The two facts the shared lock rule needs from this Mac: is a pid still the process that took the
 * lock, and how long has this observer been awake? (plan.md M15, C1)
 *
 * **Reading only.** `ps` and `sysctl` are read; nothing is signalled, started or written.
 *
 * **Why the C locale.** The rule compares `ps -o lstart=` against the `pid_start` a holder recorded,
 * as text. `ps` formats the date through the locale, so an extension host running in Dutch would
 * write "zo 13 sep" where RAVIS writes "Sun Sep 13", and a live holder would look `gone`. Forcing
 * `LC_ALL=C` makes every reader and writer on the Mac produce the fixtures' form. The time zone is
 * inherited, as the contract's plain `ps -o lstart=` implies; both sides must leave it alone.
 *
 * **Not knowing is its own answer.** A probe that couldn't run returns `undefined`, never "not
 * running": a failed `ps` must not turn into a `gone` verdict and a takeover.
 */

import { execFile } from 'child_process';
import * as os from 'os';
import { normaliseStart, type ProcessProbe } from './lockRule';

const PROBE_TIMEOUT_MS = 5_000;

/** Runs a command and hands back its exit code and output; injectable so tests needn't depend on `ps`. */
export type Runner = (file: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

/** Looks `pid` up with `ps -o lstart= -p <pid>`. */
export async function probeProcess(pid: number, run: Runner = runQuietly): Promise<ProcessProbe | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { pid_running: false, lstart: null };
  const { code, stdout } = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  const lstart = normaliseStart(stdout);
  if (lstart !== '') return { pid_running: true, lstart };
  // ps prints nothing and exits 1 for a pid that isn't running. Anything else is not knowing.
  return code === 1 ? { pid_running: false, lstart: null } : undefined;
}

/**
 * When a process started and what it is (`ps -o lstart=,comm= -p <pid>`), for the `running_command` a
 * heartbeat reports (C2a; design §6.3, final check F-A4). `lstart` is always five words in the C locale.
 * Undefined when `ps` couldn't say.
 */
export async function describeProcess(pid: number, run: Runner = runQuietly): Promise<{ start: string; comm: string } | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const words = (await run('ps', ['-o', 'lstart=,comm=', '-p', String(pid)])).stdout.trim().split(/\s+/);
  if (words.length < 6) return undefined;
  return { start: words.slice(0, 5).join(' '), comm: words.slice(5).join(' ') };
}

/** This process's own `pid_start`, in the form a lock file records it. */
export async function ownStart(run: Runner = runQuietly): Promise<string | undefined> {
  const probe = await probeProcess(process.pid, run);
  return probe?.lstart ?? undefined;
}

/**
 * Seconds since this Mac last woke (`kern.waketime`), or since it booted when it hasn't slept
 * (`kern.boottime`). Elsewhere `os.uptime()` stands in, which overstates the time awake after a
 * suspend: that can only make a holder `unresponsive` — a takeover the owner confirms — never `gone`.
 */
export async function observerAwakeSeconds(
  nowMs = Date.now(),
  run: Runner = runQuietly,
  platform: NodeJS.Platform = process.platform
): Promise<number | undefined> {
  if (platform !== 'darwin') return Math.floor(os.uptime());
  const woke = parseSysctlSeconds((await run('sysctl', ['-n', 'kern.waketime'])).stdout);
  const since = woke ? woke : parseSysctlSeconds((await run('sysctl', ['-n', 'kern.boottime'])).stdout);
  if (!since) return undefined;
  return Math.max(0, Math.floor(nowMs / 1000 - since));
}

/** `{ sec = 1789231177, usec = 263628 } Sat Sep 12 18:39:37 2026` → 1789231177; 0 when it never happened. */
export function parseSysctlSeconds(text: string): number | undefined {
  const match = /\{\s*sec = (\d+)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** Runs `file` in the C locale, never throwing: `ps` and `sysctl` here, and the process table (`processTable.ts`). */
export function runQuietly(file: string, args: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, LC_ALL: 'C' }, timeout: PROBE_TIMEOUT_MS },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout ?? '') });
      }
    );
  });
}
