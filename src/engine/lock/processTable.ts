/**
 * Every process on this Mac, read once, so a command can be stopped with everything it started
 * (plan.md M15, C2a; design §6.3; `project-locks.json` group_kill_at_takeover; final check F-A4).
 *
 * **What is read.** `ps -A -o pid=,ppid=,pgid=,stat=,lstart=,comm=`, in the C locale for the reason
 * `processProbe.ts` gives: start times are compared as text with the one a lock file recorded, and a Dutch
 * `ps` prints "zo 13 sep." where the recorder wrote "Sun Sep 13". The contract's snapshot names five
 * columns; `stat` is the sixth, so a process that has exited and only waits to be reaped (a zombie, `Z`)
 * counts as gone — it can't write anything any more.
 *
 * **Not knowing is its own answer.** A `ps` that fails or prints nothing is `undefined`, never "nothing is
 * running", which would let a takeover go ahead beside a command that is still writing.
 *
 * Reading only. Pure apart from the `ps` run, which a test hands in.
 */

import { runQuietly, type Runner } from './processProbe';

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** `ps -o stat=`. A leading `Z` is a process that has exited and waits to be reaped. */
  stat: string;
  /** `ps -o lstart=` in the C locale, e.g. `Sun Sep 13 05:41:07 2026`. */
  lstart: string;
  comm: string;
}

/** One `ps` line: three numbers, the state, five words of start time, then the command name (which may hold spaces). */
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*?)\s*$/;

const START = /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every process, or undefined when `ps` couldn't say. */
export async function snapshotProcesses(run: Runner = runQuietly): Promise<ProcessRow[] | undefined> {
  const { code, stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart=,comm=']);
  const rows = parseProcessTable(stdout);
  return code === 0 && rows.length > 0 ? rows : undefined;
}

export function parseProcessTable(text: string): ProcessRow[] {
  return text.split('\n').flatMap((line) => {
    const match = ROW.exec(line);
    if (!match) return [];
    const [, pid, ppid, pgid, stat, lstart, comm] = match;
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), stat, lstart, comm }];
  });
}

/**
 * When a C-locale `lstart` was, in milliseconds, read in this Mac's time zone as `ps` printed it; undefined
 * for text that isn't one. Only ever compared with another `lstart` read the same way, to the second.
 */
export function startedAtMs(lstart: string): number | undefined {
  const match = START.exec(lstart.trim().replace(/\s+/g, ' '));
  const month = match ? MONTHS.indexOf(match[1]) : -1;
  if (!match || month === -1) return undefined;
  const [, , day, hours, minutes, seconds, year] = match;
  return new Date(Number(year), month, Number(day), Number(hours), Number(minutes), Number(seconds)).getTime();
}

/** A zombie: exited, waiting for its parent to reap it. It holds nothing open and writes nothing. */
export function hasExited(row: ProcessRow): boolean {
  return row.stat.startsWith('Z');
}
