import * as vscode from 'vscode';
import { ButlerViewProvider, BUTLER_STATES, ButlerState } from './panels/ButlerViewProvider';
import { BusyTracker } from './watch/BusyTracker';
import { wireBusyTracker } from './watch/wireBusyTracker';
import { outcomeMessage } from './watch/outcomeMessages';

// How long an outcome reaction (impressed/judging) holds the avatar before it
// settles back to neutral, assuming nothing else has made it busy again.
const REACTION_HOLD_MS = 4000;

// Extension-wide singletons. There's only ever one instance of each of these per
// window, so module-level state (rather than a class) is the simplest fit.
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let currentState: ButlerState = 'neutral';

// Codicon shown in the status bar for each avatar state, so users who keep the
// panel closed still get a one-glyph readout of Clarvis's mood.
const STATE_GLYPHS: Record<ButlerState, string> = {
  neutral: '$(circle-outline)',
  judging: '$(eye)',
  impressed: '$(thumbsup)',
  thinking: '$(sync~spin)',
  talking: '$(comment)',
  surprised: '$(warning)',
};

// Called once by VS Code when the extension activates (onStartupFinished).
// Everything the extension does gets wired up here.
export function activate(context: vscode.ExtensionContext) {
  // Output channel is Clarvis's own debug log, visible via the "Output" panel.
  // Also doubles as the trace we use to verify behavior during development.
  outputChannel = vscode.window.createOutputChannel('Clarvis');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine(`[${new Date().toISOString()}] Clarvis activated.`);

  // Status bar glyph mirrors whatever the avatar webview is currently showing.
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = STATE_GLYPHS[currentState];
  statusBarItem.tooltip = `Clarvis: ${currentState}`;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // The single choke point for changing Clarvis's expression. Every caller in this
  // file goes through here so the webview, the status bar, and the log always agree.
  const setState = (state: ButlerState) => {
    currentState = state;
    statusBarItem.text = STATE_GLYPHS[state];
    statusBarItem.tooltip = `Clarvis: ${state}`;
    provider.setState(state); // pushes {type:'state', name} into the webview via postMessage
    outputChannel.appendLine(`[${new Date().toISOString()}] state -> ${state}`);
  };

  // The avatar itself: a webview panel in the Clarvis activity-bar view.
  // setState above is passed in as the callback the provider uses to report state
  // changes that originate from inside the webview (currently none do; reserved
  // for future click/chat wiring).
  const provider = new ButlerViewProvider(context.extensionUri, setState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ButlerViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true }, // don't reset the webview when the panel is hidden
    })
  );

  // Manual override for testing/demoing every avatar state without needing a real
  // trigger (a slow build, a failing test, etc.) to fire one.
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.debug.setState', async () => {
      const picked = await vscode.window.showQuickPick([...BUTLER_STATES], {
        placeHolder: 'Set Clarvis avatar state',
      });
      if (picked) setState(picked as ButlerState);
    })
  );

  // --- M3: task/terminal/debug watching ---
  // BusyTracker is a plain idle|busy state machine; wireBusyTracker feeds it from
  // the three VS Code event sources (tasks, terminal shell executions, debug
  // sessions) that M1's spike identified as the "is something running" signals.
  const tracker = new BusyTracker();
  wireBusyTracker(tracker, context);

  // Tracks whether the avatar is currently "holding" a post-outcome reaction
  // (impressed/judging) so a stray idle->busy->idle blip doesn't cut it short.
  let reactionHoldTimer: ReturnType<typeof setTimeout> | undefined;
  let holdingReaction = false;

  // Fires whenever the tracker flips between "something is running" and "nothing
  // is". Busy always means "thinking"; going idle only resets to neutral if we
  // aren't mid-reaction to a just-finished outcome.
  tracker.onBusyChange((busy) => {
    if (busy) {
      clearTimeout(reactionHoldTimer);
      holdingReaction = false;
      setState('thinking');
    } else if (!holdingReaction) {
      setState('neutral');
    }
  });

  // Fires once per finished task/command/debug session, regardless of duration —
  // the duration gate below decides whether it's worth reacting to. Short-lived
  // things (a quick `ls`, a fast test run) are tracked but never surfaced; nobody
  // wants a notification for a two-second command.
  tracker.onOutcome((outcome) => {
    const minDurationSeconds = vscode.workspace
      .getConfiguration('clarvis')
      .get<number>('watch.minDurationSeconds', 30);
    outputChannel.appendLine(
      `[${new Date().toISOString()}] outcome ${outcome.source} "${outcome.label}" exitCode=${outcome.exitCode} durationMs=${outcome.durationMs} (threshold=${minDurationSeconds}s)`
    );
    if (outcome.durationMs < minDurationSeconds * 1000) return; // known gap until M6 (§ M3 build notes)

    // Long enough to matter: react and notify. exitCode 0 reads as success;
    // anything else (including `undefined`, e.g. a debug session with no exit
    // code) reads as a failure worth a skeptical look.
    const success = outcome.exitCode === 0;
    setState(success ? 'impressed' : 'judging');
    vscode.window.showInformationMessage(
      outcomeMessage(outcome.label, outcome.exitCode, outcome.durationMs)
    );

    // Hold the reaction for a few seconds, then settle back to neutral — unless
    // something else makes the tracker busy again first, which cancels this timer
    // via the onBusyChange handler above.
    holdingReaction = true;
    clearTimeout(reactionHoldTimer);
    reactionHoldTimer = setTimeout(() => {
      holdingReaction = false;
      setState('neutral');
    }, REACTION_HOLD_MS);
  });
}

// Called by VS Code on window close / workspace switch / extension reload.
// There's no persistent state to flush yet (that starts at M4) — this just logs
// the teardown so M0's "does deactivate actually run" checklist item has a signal
// to look for.
export function deactivate() {
  outputChannel?.appendLine(`[${new Date().toISOString()}] Clarvis deactivated.`);
}
