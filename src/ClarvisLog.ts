import * as vscode from 'vscode';

/**
 * Clarvis's own debug log, surfaced in VS Code's "Output" panel under "Clarvis".
 *
 * Exists so no caller has to remember to stamp a timestamp — every line gets one,
 * in one place. Also gives the extension a single seam to mute or redirect logging
 * later without touching call sites.
 */
export class ClarvisLog {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Clarvis');
  }

  /** Writes one timestamped line to the output channel. */
  write(message: string): void {
    this.channel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  /** Hands the underlying channel to context.subscriptions for automatic teardown. */
  get disposable(): vscode.Disposable {
    return this.channel;
  }
}
