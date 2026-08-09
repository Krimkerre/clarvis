import * as vscode from 'vscode';
import { ButlerViewProvider, BUTLER_STATES, isButlerState } from './panels/ButlerViewProvider';
import { AvatarController } from './AvatarController';
import { StatusBarMirror } from './StatusBarMirror';
import { ClarvisLog } from './ClarvisLog';
import { BusyTracker } from './watch/BusyTracker';
import { wireBusyTracker } from './watch/wireBusyTracker';
import { WatchPresenter } from './watch/WatchPresenter';
import { BriefingService } from './briefing/BriefingService';
import { PatternStore } from './memory/PatternStore';
import { PatternMemory } from './memory/PatternMemory';

// Held at module scope only because deactivate() has no way to receive anything
// from activate() — VS Code calls the two independently. Everything else lives
// inside activate()'s scope and is torn down via context.subscriptions.
let log: ClarvisLog | undefined;

/**
 * Called once by VS Code when the extension activates (onStartupFinished).
 *
 * Composition root: builds the pieces, wires them together, registers them for
 * teardown. The actual behavior lives in the collaborators, not here.
 */
export function activate(context: vscode.ExtensionContext): void {
  log = new ClarvisLog();
  context.subscriptions.push(log.disposable);
  log.write('Clarvis activated.');

  const avatar = createAvatar(context, log);
  registerDebugStateCommand(context, avatar);
  const tracker = startTaskWatching(context, avatar, log);
  const memory = startPatternMemory(context, avatar, tracker, log);
  startBriefing(context, avatar, tracker, log, memory);
}

/**
 * Builds the avatar's two surfaces (webview panel + status-bar glyph) and the
 * controller that keeps them in sync, and registers all of it with VS Code.
 */
function createAvatar(context: vscode.ExtensionContext, log: ClarvisLog): AvatarController {
  const provider = new ButlerViewProvider(context.extensionUri);
  const statusBar = new StatusBarMirror('neutral');
  const avatar = new AvatarController(provider, statusBar, log);

  // State changes originating inside the webview flow back through the controller,
  // so they update the status bar too instead of silently diverging.
  provider.onDidReportState((state) => avatar.setState(state));

  context.subscriptions.push(
    provider.disposable,
    statusBar.disposable,
    vscode.window.registerWebviewViewProvider(ButlerViewProvider.viewId, provider, {
      // Keep the webview alive while the panel is collapsed, so the avatar doesn't
      // reset to its default expression every time the user hides the panel.
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  return avatar;
}

/**
 * Registers the debug command that sets any expression on demand, so every state
 * can be exercised without waiting for a real trigger (a slow build, a failing test).
 */
function registerDebugStateCommand(
  context: vscode.ExtensionContext,
  avatar: AvatarController
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.debug.setState', async () => {
      const picked = await vscode.window.showQuickPick([...BUTLER_STATES], {
        placeHolder: 'Set Clarvis avatar state',
      });
      if (isButlerState(picked)) avatar.setState(picked);
    })
  );
}

/**
 * Starts watching tasks, terminal commands, and debug sessions (M3), and reacting
 * to them on screen.
 *
 * BusyTracker answers "is anything running?", wireBusyTracker feeds it from the
 * three VS Code event sources M1's spike validated, and WatchPresenter decides
 * what the user sees when something finishes.
 */
function startTaskWatching(
  context: vscode.ExtensionContext,
  avatar: AvatarController,
  log: ClarvisLog
): BusyTracker {
  const tracker = new BusyTracker();
  wireBusyTracker(tracker, context);

  const presenter = new WatchPresenter(avatar, (message) => log.write(message));
  presenter.attachTo(tracker);
  context.subscriptions.push({ dispose: () => presenter.dispose() });

  return tracker;
}

/**
 * Starts the session briefing (M4): remembers the job that was failing when the window
 * closed, and reports where things stood shortly after the next launch.
 *
 * Shares M3's tracker rather than subscribing to VS Code events again — the failing
 * job is the same fact both features care about, just on different timescales.
 */
function startPatternMemory(
  context: vscode.ExtensionContext,
  avatar: AvatarController,
  tracker: BusyTracker,
  log: ClarvisLog
): PatternMemory {
  const memory = new PatternMemory(
    new PatternStore(context),
    (message) => log.write(message),
    (message) => {
      // A suggestion, never an action (rule 3): it says what worked last time and
      // stops there. Nothing here writes a file or runs a command.
      avatar.setState('judging');
      void vscode.window.showInformationMessage(message);
      setTimeout(() => avatar.setState('neutral'), 4000);
    }
  );

  void memory.start(tracker, context);
  return memory;
}

function startBriefing(
  context: vscode.ExtensionContext,
  avatar: AvatarController,
  tracker: BusyTracker,
  log: ClarvisLog,
  memory: PatternMemory
): void {
  const briefing = new BriefingService(context, (message) => log.write(message));

  // M5 supplies the briefing's fourth line. M4 needed no changes for this — it was
  // built to omit the line until something could provide it.
  briefing.setPatternHint(() => memory.briefingLine());

  briefing.start(tracker, (lines) => {
    // Speaking, briefly — then back to resting. Voice (M7) will read these aloud;
    // for now the notification is the delivery and the face just marks the moment.
    avatar.setState('talking');
    void vscode.window.showInformationMessage(lines.join(' '));
    setTimeout(() => avatar.setState('neutral'), 3000);
    lines.forEach((line) => log.write(`briefing | ${line}`));
  });

  context.subscriptions.push({ dispose: () => briefing.dispose() });
}

/**
 * Called by VS Code on window close, workspace switch, or extension reload.
 *
 * Nothing to flush yet — persistent state starts at M4. Note that this log line
 * frequently does NOT appear: the extension host often tears the process down
 * before the write is flushed. That's expected, and it's why real teardown state
 * (from M4 onward) is written synchronously via workspace.fs, never via the log.
 */
export function deactivate(): void {
  log?.write('Clarvis deactivated.');
}
