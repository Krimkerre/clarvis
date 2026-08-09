import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * How much log is kept before the file is rotated.
 *
 * One rotation, not a dated archive: this exists so a problem can be looked at after
 * the fact, not so anyone can audit last month. A pair of files bounded at a few
 * megabytes needs no cleanup story.
 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/**
 * Clarvis's own debug log — the Output panel, and a file on disk.
 *
 * The panel alone was not enough. It lives in memory, dies with the window, and cannot
 * be attached to a bug report or read by anyone who is not sitting at the machine — so
 * every "check the log" meant asking the user to copy text out by hand. The file makes
 * the same lines readable after the fact, which is the whole point of a log.
 *
 * Nothing sensitive reaches here by construction: keys live in the OS keychain and are
 * never logged, and error bodies are truncated before they are written (§4.6).
 */
export class ClarvisLog {
  private readonly channel: vscode.OutputChannel;
  private readonly file: string | undefined;

  constructor(storageUri?: vscode.Uri) {
    this.channel = vscode.window.createOutputChannel('Clarvis');

    if (storageUri) {
      try {
        fs.mkdirSync(storageUri.fsPath, { recursive: true });
        this.file = path.join(storageUri.fsPath, 'clarvis.log');
        this.rotateIfLarge();
      } catch {
        // A log that cannot be written is not a reason to fail activation. The panel
        // still works, and this is diagnostics rather than function.
        this.file = undefined;
      }
    }
  }

  /** Writes one timestamped line to the output channel, and to the file if there is one. */
  write(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.channel.appendLine(line);

    if (!this.file) return;
    try {
      // Synchronous on purpose: an async append can lose the last lines written before
      // a crash, and those are exactly the ones worth having.
      fs.appendFileSync(this.file, `${line}\n`);
    } catch {
      // Disk full, permissions changed mid-session. Logging must never throw into a
      // caller that was doing something else.
    }
  }

  /** Where the log file lives, for the "open my log" command. */
  get filePath(): string | undefined {
    return this.file;
  }

  /** Keeps one previous file, so a rotation never loses the run that just failed. */
  private rotateIfLarge(): void {
    if (!this.file) return;

    try {
      if (fs.statSync(this.file).size < MAX_LOG_BYTES) return;
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      // No file yet, which is the normal first-run case.
    }
  }

  /** Hands the underlying channel to context.subscriptions for automatic teardown. */
  get disposable(): vscode.Disposable {
    return this.channel;
  }
}
