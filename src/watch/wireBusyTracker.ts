import * as vscode from 'vscode';
import { BusyTracker } from './BusyTracker';

// Neither TaskExecution nor TerminalShellExecution expose a stable id — VS Code
// just hands back the same object reference across the matching start/end event
// pair. This mints a string id the first time an object is seen (on start) and
// remembers it via WeakMap so end() can look the same id back up, without leaking
// memory once the object itself is garbage-collected.
let counter = 0;
function idFor<T extends object>(map: WeakMap<T, string>, key: T): string {
  let id = map.get(key);
  if (!id) {
    id = `id${counter++}`;
    map.set(key, id);
  }
  return id;
}

// Subscribes to the three §4.0 "busy" event sources and normalizes each into
// BusyTracker's start(id)/end(id, exitCode) calls. This is the only place in the
// extension that touches these raw VS Code events — BusyTracker itself and
// everything downstream of it are source-agnostic.
export function wireBusyTracker(tracker: BusyTracker, context: vscode.ExtensionContext): void {
  const taskIds = new WeakMap<vscode.TaskExecution, string>();
  const terminalIds = new WeakMap<vscode.TerminalShellExecution, string>();

  context.subscriptions.push(
    // Tasks (tasks.json-defined, run through the Tasks system). Per M1: these do
    // NOT fire for commands typed directly into a terminal — that's a genuinely
    // separate source, wired independently below, not a fallback.
    vscode.tasks.onDidStartTask((e) =>
      tracker.start(idFor(taskIds, e.execution), 'task', e.execution.task.name)
    ),
    vscode.tasks.onDidEndTaskProcess((e) =>
      tracker.end(idFor(taskIds, e.execution), e.exitCode)
    ),

    // Terminal shell integration — fires for both real tasks AND raw commands
    // typed into any integrated terminal. Requires VS Code ≥1.93 and a shell with
    // integration support; silently absent otherwise (no error, just no events).
    vscode.window.onDidStartTerminalShellExecution((e) =>
      tracker.start(
        idFor(terminalIds, e.execution),
        'terminal',
        e.execution.commandLine.value
      )
    ),
    vscode.window.onDidEndTerminalShellExecution((e) =>
      tracker.end(idFor(terminalIds, e.execution), e.exitCode)
    ),

    // Debug sessions. Per M1: a single debug run fires this event pair TWICE — once
    // for a wrapper session, once for the actual child session — so we only track
    // the top-level one (no parentSession) and let the child's start/end become
    // silent no-ops in BusyTracker (unknown id on end() is a no-op by design).
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.parentSession) return; // dedupe nested child sessions (M1 finding)
      tracker.start(session.id, 'debug', session.name);
    }),
    vscode.debug.onDidTerminateDebugSession((session) => {
      if (session.parentSession) return;
      tracker.end(session.id, undefined); // debug sessions don't expose an exit code
    })
  );
}
