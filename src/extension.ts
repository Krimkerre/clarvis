import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('Clarvis');
  context.subscriptions.push(outputChannel);
  outputChannel.appendLine(`[${new Date().toISOString()}] Clarvis activated.`);
}

export function deactivate() {
  outputChannel?.appendLine(`[${new Date().toISOString()}] Clarvis deactivated.`);
}
