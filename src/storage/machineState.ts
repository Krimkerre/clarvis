/**
 * The shape of the file a few workspace values are kept in, and the rule for changing it.
 *
 * `workspaceState` is the *browser's* when the editor is code-server (see `workspaceFile.ts`), and
 * two of those values decide what happens to somebody's branches: `clarvis.agent.baseBranch` is
 * where a run is merged back to, and `clarvis.agent.lastRun` is the file list "Start fresh" commits
 * on their behalf. Per browser profile, those are wrong answers waiting to happen, so they live on
 * the machine instead.
 *
 * **Written one key at a time.** Two windows hold the same workspace and neither owns the file:
 * window A loads at activation, window B changes the base branch, and A then finishes a run and
 * writes its last-run record. If A wrote everything it was holding, it would carry its stale base
 * branch back over B's. So a write re-reads, replaces the one key it is about, and keeps the rest
 * of the file as it found it. Last write still wins *per key*, which is the honest answer for a
 * single value per workspace — and the moments that act on these read from disk first.
 */

/** What the file holds. `folder` is diagnosis only: which workspace this file belongs to. */
export interface MachineState {
  folder: string;
  values: Record<string, unknown>;
}

export function emptyState(folder: string): MachineState {
  return { folder, values: {} };
}

/** Rebuilds the file from what was read; anything malformed reads as no value at all. */
export function parseState(raw: unknown, folder: string): MachineState {
  if (!raw || typeof raw !== 'object') return emptyState(folder);
  const candidate = raw as Partial<MachineState>;
  const values = candidate.values;
  return {
    folder: typeof candidate.folder === 'string' ? candidate.folder : folder,
    values: values && typeof values === 'object' && !Array.isArray(values) ? { ...values } : {},
  };
}

/** One key replaced, every other key left exactly as the file had it. */
export function withValue(state: MachineState, key: string, value: unknown): MachineState {
  const values = { ...state.values };
  // `undefined` is how a Memento deletes, and JSON would drop the key anyway — do it here, so
  // "deleted" and "never set" are one state rather than two that behave differently.
  if (value === undefined) delete values[key];
  else values[key] = value;
  return { ...state, values };
}

/**
 * The keys this file owns that are still only in the old key-value store, copied across.
 *
 * Per key rather than per file: a workspace may have a base branch remembered and no last run, and
 * a file that already holds one of them must not be overwritten by the other's absence.
 */
export function migrateInto(
  state: MachineState, owned: readonly string[], held: (key: string) => unknown
): { state: MachineState; moved: string[] } {
  const moved: string[] = [];
  const next = owned.reduce((sofar, key) => {
    if (key in sofar.values) return sofar;
    const value = held(key);
    if (value === undefined) return sofar;
    moved.push(key);
    return withValue(sofar, key, value);
  }, state);
  return { state: next, moved };
}
