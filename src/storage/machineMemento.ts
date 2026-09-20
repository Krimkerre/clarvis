import { readFileSync } from 'fs';
import * as vscode from 'vscode';
import { emptyState, MachineState, migrateInto, parseState, withValue } from './machineState';
import { WorkspaceFile } from './workspaceFile';

/**
 * A `Memento` that keeps a named few keys on this machine, and passes everything else through.
 *
 * VS Code keeps `workspaceState` in the browser when the editor is code-server, so anything there
 * belongs to one browser profile (`workspaceFile.ts` has the measurement) — absent in a second
 * browser, gone when site data is cleared. `MACHINE_KEYS` is what that costs enough to move.
 *
 * **Owned keys only.** Everything else is handed to `workspaceState` untouched, so moving these
 * cannot quietly move anything else, and `keys()` answers with both stores' keys — code that walks
 * the keys must still see them.
 *
 * **`get` stays synchronous**, which is what the `Memento` contract promises and what every caller
 * expects, so the file is loaded once at activation and kept in memory. That copy goes stale when
 * another window writes, so `refresh()` re-reads it, and the moments that *act* on these values —
 * starting a run, continuing one, merging back — call it first. Writes never rely on the copy:
 * they re-read and replace one key (`machineState.withValue`).
 */
/**
 * The keys kept on this machine, and why each earns it.
 *
 * **Deliberately not here.** `clarvis.agent.allowUnconfinedCommands` is a permission the owner
 * grants for a project, and moving it would widen a grant made in one browser to every browser on
 * the machine — a decision for the owner, not a side effect of a storage change.
 * `clarvis.bridge.identity` holds the token a window registers to NERVIS with, and a credential
 * belongs where the editor puts credentials rather than in a plain file. `clarvis.recentFiles` and
 * `clarvis.agent.checkpoint` rebuild themselves from use.
 */
export const MACHINE_KEYS = [
  // Wrong actions if read from the wrong browser: where a run is folded back to, and the file list
  // "Start fresh" commits (20 September 2026).
  'clarvis.agent.baseBranch',
  'clarvis.agent.lastRun',
  // Work in progress: a planning interview paused halfway, and the task NERVIS handed over.
  'clarvis.planning.interview',
  'clarvis.nervisTask',
  // Answers already given, which a second browser would ask for again: the log copy's approval and
  // how far it has been copied, the branch-flow question, a declined planning offer, a declined
  // offer to set git up.
  'clarvis.logCopy.approvedAt',
  'clarvis.logCopy.progress',
  'clarvis.logCopy.on',
  'clarvis.branchFlow.seen',
  'clarvis.branchFlow.kept',
  'clarvis.planning.offerDeclined',
  'clarvis.agent.gitOfferDeclined',
  // What was in the way last time, which chat answers "why did that fail" from.
  'clarvis.agent.lastMissing',
  'clarvis.lastFailure',
] as const;

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
    // **Read before anything can ask.** `get` is synchronous, `activate` cannot await, and a value
    // that reads as absent for the first moments is a paused interview that looks abandoned or an
    // approval that looks unasked. Node's own read, because this is the one moment the editor's
    // asynchronous file API cannot serve; every write still goes through it.
    this.state = this.readNow();
  }

  private readNow(): MachineState {
    try {
      return parseState(JSON.parse(readFileSync(this.file.uri.fsPath, 'utf8')), this.file.folder);
    } catch {
      return emptyState(this.file.folder);
    }
  }

  /**
   * Reads the file, and moves anything this owns that is still only in the old store.
   *
   * The migrating write goes through `WorkspaceFile.update`, which makes the folder first — a
   * fresh installation has no storage folder, and `writeFile` will not make one.
   */
  async load(): Promise<void> {
    const held = this.readNow();
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

  /** The same, without waiting — for a caller that has no `await` to spare. */
  refreshNow(): void {
    this.state = this.readNow();
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
