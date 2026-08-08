import * as vscode from 'vscode';
import { ButlerViewProvider, BUTLER_STATES, ButlerState } from './panels/ButlerViewProvider';

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let currentState: ButlerState = 'neutral';

const STATE_GLYPHS: Record<ButlerState, string> = {
  neutral: '$(circle-outline)',
  judging: '$(eye)',
  impressed: '$(thumbsup)',
  thinking: '$(sync~spin)',
  talking: '$(comment)',
  surprised: '$(warning)',
};

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Clarvis');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine(`[${new Date().toISOString()}] Clarvis activated.`);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = STATE_GLYPHS[currentState];
  statusBarItem.tooltip = `Clarvis: ${currentState}`;
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const setState = (state: ButlerState) => {
    currentState = state;
    statusBarItem.text = STATE_GLYPHS[state];
    statusBarItem.tooltip = `Clarvis: ${state}`;
    provider.setState(state);
  };

  const provider = new ButlerViewProvider(context.extensionUri, setState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ButlerViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('clarvis.debug.setState', async () => {
      const picked = await vscode.window.showQuickPick([...BUTLER_STATES], {
        placeHolder: 'Set Clarvis avatar state',
      });
      if (picked) setState(picked as ButlerState);
    })
  );
}

export function deactivate() {
  outputChannel?.appendLine(`[${new Date().toISOString()}] Clarvis deactivated.`);
}
