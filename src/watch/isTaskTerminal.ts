/**
 * Whether a terminal shell execution belongs to the Tasks system.
 *
 * Its own module, with no `vscode` import, because the rule is the interesting
 * part and the rule could not be tested where it lived: `wireBusyTracker` needs
 * a real extension host, so the one piece of logic in it that has been wrong in
 * production had no test at all.
 *
 * **Why it matters.** Running a task fires both a task event and a terminal
 * shell-execution event for the same work. Counting both means one build
 * produces two notifications, and a cancelled task leaves its never-ending
 * terminal half stuck in the tracker, pinning Clarvis "busy" for the session.
 * Tasks win: they report a real exit code even when cancelled, which shell
 * integration does not.
 */
export function isTaskTerminal(
  terminalName: string,
  alreadyKnown: boolean,
  runningTaskNames: ReadonlySet<string>,
): boolean {
  // Learned from a previous execution in this terminal. Ordering-proof, and the
  // only one of the three that holds for a terminal a task is reusing.
  if (alreadyKnown) return true;

  // **Named after a task that is running right now.** This was missing, and the
  // double-count was real: measured under code-server on 30 August 2026, one
  // `stage9-task-probe` run produced an `outcome task` and an `outcome terminal`
  // line 3 ms apart. The empty-name rule below assumes VS Code has not yet named
  // the task's terminal when its execution starts; that host names it
  // immediately, so nothing recognised it and the run was counted twice.
  //
  // A user terminal that happens to share a name with a running task is
  // misclassified, costing one uncounted terminal execution while that task
  // runs — a far smaller error than announcing every first task twice.
  if (runningTaskNames.has(terminalName)) return true;

  // A brand-new task terminal on a host that has not named it yet.
  return runningTaskNames.size > 0 && terminalName === '';
}
