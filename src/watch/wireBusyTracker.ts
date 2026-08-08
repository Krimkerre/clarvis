import * as vscode from 'vscode';
import { BusyTracker } from './BusyTracker';

/**
 * Neither TaskExecution nor TerminalShellExecution exposes a stable id — VS Code
 * just hands back the same object reference across the matching start/end pair.
 * This mints a string id the first time an object is seen and remembers it in a
 * WeakMap, so end() can look the same id back up without pinning the object in
 * memory once VS Code is done with it.
 */
let counter = 0;
function idFor<T extends object>(map: WeakMap<T, string>, key: T): string {
  let id = map.get(key);
  if (!id) {
    id = `id${counter++}`;
    map.set(key, id);
  }
  return id;
}

/**
 * Subscribes to the three "busy" event sources (§4.0) and normalizes each into
 * BusyTracker's start/end calls. The only place in the extension that touches
 * these raw VS Code events — BusyTracker and everything downstream are
 * source-agnostic.
 */
export function wireBusyTracker(tracker: BusyTracker, context: vscode.ExtensionContext): void {
  const taskIds = new WeakMap<vscode.TaskExecution, string>();
  const terminalIds = new WeakMap<vscode.TerminalShellExecution, string>();

  /**
   * Names of tasks currently running. VS Code names a task's terminal after the
   * task itself, which is how runsInsideATask() below tells a task's own shell
   * apart from a terminal the user is typing in.
   */
  const runningTaskNames = new Set<string>();

  /**
   * True when this shell execution is a running task's own terminal.
   *
   * Running a task fires BOTH a task event and a terminal shell-execution event
   * for the same work. Counting both meant one build produced two notifications,
   * and a cancelled task left its never-ending terminal half stuck in the tracker,
   * pinning Clarvis "busy" for the rest of the session. Tasks win: they report a
   * real exit code even when cancelled, which shell integration doesn't.
   *
   * The tell is the terminal's name. VS Code fires the task event first and only
   * names the task's terminal afterwards, so a task's own shell execution starts
   * while its terminal is still nameless — whereas a terminal the user typed into
   * always has one ("zsh", "bash", …). Both conditions are required: an unnamed
   * terminal with no task running is still tracked.
   *
   * Only the start side needs this guard. Skipping start means the matching end
   * arrives with an id BusyTracker never saw, which it already ignores.
   */
  const belongsToRunningTask = (event: vscode.TerminalShellExecutionStartEvent) =>
    runningTaskNames.size > 0 && event.terminal.name === '';

  context.subscriptions.push(
    // Tasks: tasks.json-defined work run through the Tasks system.
    vscode.tasks.onDidStartTask((event) => {
      runningTaskNames.add(event.execution.task.name);
      tracker.start(idFor(taskIds, event.execution), 'task', event.execution.task.name);
    }),
    vscode.tasks.onDidEndTaskProcess((event) => {
      runningTaskNames.delete(event.execution.task.name);
      tracker.end(idFor(taskIds, event.execution), event.exitCode);
    }),

    // Terminal shell integration: commands typed directly into any integrated
    // terminal. Requires VS Code ≥1.93 and a shell that supports integration —
    // silently absent otherwise (no error, just no events).
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (belongsToRunningTask(event)) return;

      // Shell integration reports a phantom execution with an empty command line
      // when a shell starts up. There's no job there to watch.
      const commandLine = event.execution.commandLine.value.trim();
      if (commandLine === '') return;

      tracker.start(idFor(terminalIds, event.execution), 'terminal', commandLine);
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      tracker.end(idFor(terminalIds, event.execution), event.exitCode);
    }),

    // Debug sessions. Per M1, one debug run fires this pair twice — once for a
    // wrapper session, once for the real child — so only the top-level session is
    // tracked. The child's end() lands on an unknown id, which BusyTracker ignores.
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.parentSession) return;
      tracker.start(session.id, 'debug', session.name);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.parentSession) return;
      tracker.end(session.id, undefined); // debug sessions don't expose an exit code
    })
  );
}
