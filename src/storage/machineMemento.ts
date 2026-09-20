import * as vscode from 'vscode';
import { emptyState, MachineState, migrateInto, parseState, withValue } from './machineState';
import { WorkspaceFile } from './workspaceFile';

/**
 * A `Memento` that keeps a named few keys on this machine, and passes everything else through.
 *
 * VS Code keeps `workspaceState` in the browser when the editor is code-server, so anything there
 * belongs to one browser profile (`workspaceFile.ts` has the measurement). For most keys that is a
 * repeated question at worst. For the two this owns it is a wrong action: `clarvis.agent.baseBranch`
 * is the branch a run is merged back into, and `clarvis.agent.lastRun` is the file list "Start
 * fresh" commits for you.
 *
 * **Owned keys only.** Everything else is handed to `workspaceState` untouched, so moving these two
 * cannot quietly move anything else, and `keys()` answers with both stores' keys — code that walks
 * the keys must still see these.
 *
 * **`get` stays synchronous**, which is what the `Memento` contract promises and what every caller
 * expects, so the file is loaded once at activation and kept in memory. That copy goes stale when
 * another window writes, so `refresh()` re-reads it, and the moments that *act* on these values —
 * starting a run, continuing one, merging back — call it first. Writes never rely on the copy:
 * they re-read and replace one key (`machineState.withValue`).
 */
export class MachineMemento implements vscode.Memento {
  private state: MachineState;
  private readonly file: WorkspaceFile<MachineState>;

  constructor(
    context: vscode.ExtensionContext,
    private readonly owned: readonly string[],
    private readonly fallback: vscode.Memento,
    private readonly log: (message: string) => void = () => undefined
  ) {
    this.file = new WorkspaceFile(context, 'state', parseState);
    this.state = emptyState(this.file.folder);
  }

  /**
   * Reads the file, and moves anything this owns that is still only in the old store.
   *
   * The migrating write goes through `WorkspaceFile.update`, which makes the folder first — a
   * fresh installation has no storage folder, and `writeFile` will not make one.
   */
  async load(): Promise<void> {
    const held = await this.file.read(() => emptyState(this.file.folder));
    const { state, moved } = migrateInto(held, this.owned, (key) => this.fallback.get(key));
    if (moved.length === 0) {
      this.state = state;
      return;
    }
    // The old copy is left where it is. Deleting the only other copy during a migration is how a
    // migration becomes the thing that lost the data.
    this.state = await this.file.update(() => state, (onDisk) =>
      moved.reduce((sofar, key) => withValue(sofar, key, state.values[key]), onDisk));
    this.log(`state: moved ${moved.join(', ')} onto this machine (${this.file.uri.fsPath})`);
  }

  /** What the file says now, for the moments that act on these values. */
  async refresh(): Promise<void> {
    this.state = await this.file.read(() => emptyState(this.file.folder));
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, fallback: T): T;
  get<T>(key: string, fallback?: T): T | undefined {
    if (!this.owns(key)) return this.fallback.get<T>(key, fallback as T);
    const held = this.state.values[key];
    return held === undefined ? fallback : (held as T);
  }

  async update(key: string, value: unknown): Promise<void> {
    if (!this.owns(key)) {
      await this.fallback.update(key, value);
      return;
    }
    this.state = await this.file.update(
      () => emptyState(this.file.folder),
      (onDisk) => withValue(onDisk, key, value)
    );
  }

  /** Both stores' keys: code that enumerates them must still see the two that moved. */
  keys(): readonly string[] {
    return [...new Set([...this.fallback.keys(), ...Object.keys(this.state.values)])];
  }

  private owns(key: string): boolean {
    return this.owned.includes(key);
  }
}

/**
 * Re-reads the machine's copy before acting on it, where the memento is one.
 *
 * The call sites take a plain `Memento` — `AgentBranch` takes something smaller still — so this
 * asks rather than requiring the type everywhere.
 */
export async function refreshed(memento: unknown): Promise<void> {
  const refresh = (memento as { refresh?: () => Promise<void> } | undefined)?.refresh;
  if (typeof refresh === 'function') await refresh.call(memento);
}
