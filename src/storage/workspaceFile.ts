import { createHash } from 'crypto';
import * as vscode from 'vscode';

/**
 * A JSON file of Clarvis's own, one per workspace, on the machine running the extension host.
 *
 * **The reason this exists rather than `workspaceState`** (20 September 2026). VS Code keeps
 * workspace state in the *browser* when the editor is code-server: E-C7's recovery test killed the
 * extension host mid-answer and found that nothing had been written on the machine at all, and the
 * same editor opened in a second browser showed an empty history. Anything kept there belongs to
 * one browser profile and is lost when that browser's site data is cleared. `globalStorageUri` is
 * the machine in either editor — the owner's own machine either way, and in the browser case this
 * does put the contents on the server's disk, where nothing was written before.
 *
 * Named by a hash of the workspace folder, as `memory/PatternStore.ts` names its notes, under an
 * `area` folder so two kinds of file cannot collide. Each write re-reads first and hands the
 * caller what is on disk, so a second window's change is never silently overwritten; the write
 * itself goes through a temporary file renamed into place, so a crash mid-write leaves the
 * previous file rather than half of a new one.
 */
export class WorkspaceFile<T> {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly area: string,
    private readonly parse: (raw: unknown, folder: string) => T,
    private readonly folderOf: () => string =
      () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace'
  ) {}

  get folder(): string {
    return this.folderOf();
  }

  private get directory(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, this.area);
  }

  get uri(): vscode.Uri {
    const key = createHash('sha256').update(this.folder).digest('hex').slice(0, 16);
    return vscode.Uri.joinPath(this.directory, `${key}.json`);
  }

  /** What is on disk. A missing, truncated or hand-edited file reads as `whenMissing()`. */
  async read(whenMissing: () => T): Promise<T> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      return this.parse(JSON.parse(new TextDecoder().decode(bytes)), this.folder);
    } catch {
      return whenMissing();
    }
  }

  /** `change` applied to what is on disk right now, written whole and atomically. */
  async update(whenMissing: () => T, change: (held: T) => T): Promise<T> {
    const next = change(await this.read(whenMissing));
    // The directory may not exist on a fresh installation, and `writeFile` will not make it.
    await vscode.workspace.fs.createDirectory(this.directory);
    const temporary = vscode.Uri.joinPath(this.directory, `.${process.pid}-${Date.now()}.writing`);
    await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(next)));
    await vscode.workspace.fs.rename(temporary, this.uri, { overwrite: true });
    return next;
  }
}
