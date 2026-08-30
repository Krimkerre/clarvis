import * as vscode from 'vscode';

import { isTaskTerminal } from './isTaskTerminal';
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

  /** Names of tasks currently running. */
  const runningTaskNames = new Set<string>();

  /** Every task name seen this session — a reused terminal keeps its old name. */
  const knownTaskNames = new Set<string>();

  /**
   * Terminals we've positively identified as belonging to the Tasks system.
   *
   * Learned rather than guessed, because the event order isn't stable: for a
   * freshly created task terminal the task event fires first, but for a *reused*
   * one the shell execution starts before it. A WeakSet keyed on the Terminal
   * object sidesteps ordering entirely — once a terminal has been identified, it
   * stays identified, and it's forgotten automatically when VS Code drops it.
   */
  const taskTerminals = new WeakSet<vscode.Terminal>();

  /**
   * True when this shell execution is the Tasks system running a task, rather than
   * a command the user typed.
   *
   * Running a task fires BOTH a task event and a terminal shell-execution event for
   * the same work. Counting both meant one build produced two notifications, and a
   * cancelled task left its never-ending terminal half stuck in the tracker,
   * pinning Clarvis "busy" for the rest of the session. Tasks win: they report a
   * real exit code even when cancelled, which shell integration doesn't.
   *
   * The rule itself lives in `isTaskTerminal`, which has no `vscode` import and
   * therefore has tests. It was wrong here for as long as it was untestable.
   */
  const isTaskExecution = (event: vscode.TerminalShellExecutionStartEvent) =>
    isTaskTerminal(event.terminal.name, taskTerminals.has(event.terminal), runningTaskNames);

  /**
   * Records a terminal as task-owned once its name matches a task we've run.
   *
   * By the time an execution ends, VS Code has named the task's terminal after the
   * task — so this is the first reliable moment to identify it. Doing so means the
   * *next* execution in that terminal is recognized at start time, which is what
   * the ordering flip on reused terminals otherwise defeats.
   */
  const rememberIfTaskTerminal = (terminal: vscode.Terminal) => {
    if (knownTaskNames.has(terminal.name)) taskTerminals.add(terminal);
  };

  context.subscriptions.push(
    // Tasks: tasks.json-defined work run through the Tasks system.
    vscode.tasks.onDidStartTask((event) => {
      const taskName = event.execution.task.name;
      runningTaskNames.add(taskName);
      knownTaskNames.add(taskName);
      tracker.start(idFor(taskIds, event.execution), 'task', taskName);
    }),
    vscode.tasks.onDidEndTaskProcess((event) => {
      runningTaskNames.delete(event.execution.task.name);
      tracker.end(idFor(taskIds, event.execution), event.exitCode);
    }),

    // Terminal shell integration: commands typed directly into any integrated
    // terminal. Requires VS Code ≥1.93 and a shell that supports integration —
    // silently absent otherwise (no error, just no events).
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (isTaskExecution(event)) return;

      // Shell integration reports a phantom execution with an empty command line
      // when a shell starts up. There's no job there to watch.
      const commandLine = event.execution.commandLine.value.trim();
      if (commandLine === '') return;

      tracker.start(idFor(terminalIds, event.execution), 'terminal', commandLine);
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      // The terminal has its task's name by now, if it is one. Learn it here so the
      // next execution in this terminal is recognized the moment it starts.
      rememberIfTaskTerminal(event.terminal);
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
