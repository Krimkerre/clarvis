import * as vscode from 'vscode';
import { createHash } from 'crypto';
import { PatternState, emptyState, parseState } from './patterns';

/**
 * Reads and writes the per-project pattern file.
 *
 * Kept under `globalStorageUri` keyed by a hash of the workspace path, rather than in
 * the project folder: this is Clarvis's notes about your project, not an artefact of
 * it. Nobody wants a `.clarvis/` directory turning up in their diff.
 */
export class PatternStore {
  private state: PatternState = emptyState();

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get fileUri(): vscode.Uri {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace';
    const key = createHash('sha256').update(folder).digest('hex').slice(0, 16);
    return vscode.Uri.joinPath(this.context.globalStorageUri, `${key}.json`);
  }

  /** Loads from disk. Any failure — missing, truncated, hand-edited — starts empty. */
  async load(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      this.state = parseState(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      this.state = emptyState();
    }
  }

  get current(): PatternState {
    return this.state;
  }

  /**
   * Replaces the state and writes it out.
   *
   * Written on every change rather than at shutdown, for the reason M0 established:
   * `deactivate()` isn't guaranteed to finish. The file is small enough that batching
   * would be optimising the wrong thing.
   */
  async save(next: PatternState): Promise<void> {
    this.state = next;
    try {
      await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
      await vscode.workspace.fs.writeFile(
        this.fileUri,
        new TextEncoder().encode(JSON.stringify(next))
      );
    } catch {
      // Persisting is best-effort. In-memory state still works for this session, and
      // pattern memory is never worth breaking the editor over.
    }
  }
}
