/**
 * Stopping everything a command started, not only the shell that started it.
 *
 * **Found live, 11 September 2026.** A check ran `cd src && python3 main.py`, a program
 * that loops for ever. Stop — and the ten-minute limit — killed the shell Clarvis had
 * spawned, and the Python process that shell launched lived on with the output pipe
 * still open. The command never finished, so the run never ended, and pressing Stop
 * changed nothing anyone could see. Ending that one Python process let the stop
 * complete at once.
 *
 * So a command runs as the leader of its own process group, and stopping it stops the
 * group. Pure apart from the signal it sends, which is handed in so the tests can watch.
 */

type Kill = (pid: number, signal?: string | number) => true;

/** How long a command's output may stay open after the command itself has exited. */
export const LEFT_RUNNING_GRACE_MS = 2000;

/** Told to the model, and shown in the terminal, when a command left a program running. */
export const LEFT_RUNNING_NOTE =
  '[Clarvis] This command finished but left a program running, and that program has now been stopped. ' +
  'A check has to end on its own: if the program is meant to keep running, check it in a way that finishes — ' +
  'with a short time limit, or by testing the part of it that can end.';

/**
 * Stops every process still in the group `pid` leads.
 *
 * `true` when something was still running and has been sent SIGKILL. `false` when the
 * group was already empty, or on Windows, which has no process groups — the caller then
 * kills the child on its own, as before.
 */
export function stopProcessGroup(
  pid: number | undefined,
  kill: Kill = process.kill.bind(process) as Kill,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (pid === undefined || platform === 'win32') return false;
  try {
    // Signal 0 sends nothing: it only asks whether anything in the group is still there.
    kill(-pid, 0);
  } catch {
    return false;
  }
  try {
    kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
