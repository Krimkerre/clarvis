import * as vscode from 'vscode';
import { ButlerViewProvider, BUTLER_STATES, ButlerState } from './panels/ButlerViewProvider';

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
  // file goes through here so the webview and the status bar always agree.
  const setState = (state: ButlerState) => {
    currentState = state;
    statusBarItem.text = STATE_GLYPHS[state];
    statusBarItem.tooltip = `Clarvis: ${state}`;
    provider.setState(state); // pushes {type:'state', name} into the webview via postMessage
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
}

// Called by VS Code on window close / workspace switch / extension reload.
// There's no persistent state to flush yet (that starts at M4) — this just logs
// the teardown so M0's "does deactivate actually run" checklist item has a signal
// to look for.
export function deactivate() {
  outputChannel?.appendLine(`[${new Date().toISOString()}] Clarvis deactivated.`);
}
