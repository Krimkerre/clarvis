import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BASE_BRANCH_KEY } from '../agent/AgentBranch';
import { LAST_RUN_KEY } from '../agent/runLedger';
import { MACHINE_KEYS, MachineMemento } from '../storage/machineMemento';

/**
 * What a project remembers, on this machine's disk, through the editor's own file API (20 Sep 2026).
 *
 * `machineState.test.ts` pins the rules; this pins the part that touches disk, and the things a
 * regression would quietly undo: that the moved keys no longer reach `workspaceState`, that a
 * workspace which already had them keeps them, that a key left behind on purpose stays behind, and
 * that what is on disk is readable before anything can ask for it.
 */

const OWNED = MACHINE_KEYS;

function storageFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-machine-state-'));
}

function mementoOn(storage: string, fallback: vscode.Memento): MachineMemento {
  const context = {
    workspaceState: fallback,
    globalState: memento(),
    globalStorageUri: vscode.Uri.file(storage),
  } as unknown as vscode.ExtensionContext;
  return new MachineMemento(context, OWNED, fallback);
}

function stateFiles(storage: string): string[] {
  const folder = path.join(storage, 'state');
  return fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith('.json')) : [];
}

suite('what a project remembers, kept on this machine', () => {
  test('the base branch is written to a file here, and never to the browser-side store', async () => {
    const storage = storageFolder();
    const workspaceState = memento();
    const machine = mementoOn(storage, workspaceState);
    await machine.load();

    await machine.update(BASE_BRANCH_KEY, 'main');
    await machine.update(LAST_RUN_KEY, { intent: 'fix the test', filesChanged: ['src/app.ts'] });

    const [file] = stateFiles(storage);
    assert.ok(file, `nothing under ${storage}/state — this is what code-server never wrote`);
    const written = JSON.parse(fs.readFileSync(path.join(storage, 'state', file), 'utf8'));
    assert.strictEqual(written.values[BASE_BRANCH_KEY], 'main');
    assert.deepStrictEqual(written.values[LAST_RUN_KEY].filesChanged, ['src/app.ts']);
    assert.strictEqual(workspaceState.get(BASE_BRANCH_KEY), undefined,
      'the old path must not quietly come back: a browser profile is not where this belongs');
    assert.strictEqual(workspaceState.get(LAST_RUN_KEY), undefined);
    assert.strictEqual(machine.get(BASE_BRANCH_KEY), 'main', 'and it reads back without a reload');
  });

  test('a workspace that already had them keeps them, and the old copy stays', async () => {
    const storage = storageFolder();
    const workspaceState = memento();
    await workspaceState.update(BASE_BRANCH_KEY, 'develop');
    const machine = mementoOn(storage, workspaceState);

    await machine.load();

    assert.strictEqual(machine.get(BASE_BRANCH_KEY), 'develop', 'moved across on the first load');
    const [file] = stateFiles(storage);
    assert.ok(file, 'and written to the machine, so the browser is no longer the only copy');
    assert.strictEqual(workspaceState.get(BASE_BRANCH_KEY), 'develop',
      'the old copy is left where it was — a migration must not be the thing that loses the data');
  });

  test('a paused interview, an approval and a declined offer moved too, and a permission did not', async () => {
    const storage = storageFolder();
    const workspaceState = memento();
    await workspaceState.update('clarvis.planning.interview', { seed: 'a task', at: 1 });
    await workspaceState.update('clarvis.logCopy.approvedAt', 1_758_000_000);
    await workspaceState.update('clarvis.agent.allowUnconfinedCommands', true);
    const machine = mementoOn(storage, workspaceState);

    await machine.load();
    await machine.update('clarvis.branchFlow.seen', 'main');

    const [file] = stateFiles(storage);
    const written = JSON.parse(fs.readFileSync(path.join(storage, 'state', file), 'utf8'));
    assert.deepStrictEqual(written.values['clarvis.planning.interview'], { seed: 'a task', at: 1 },
      'a half-answered interview is work in progress, not a question worth asking twice');
    assert.strictEqual(written.values['clarvis.logCopy.approvedAt'], 1_758_000_000);
    assert.strictEqual(written.values['clarvis.branchFlow.seen'], 'main');
    assert.strictEqual('clarvis.agent.allowUnconfinedCommands' in written.values, false,
      'a permission granted in one browser must not silently widen to every browser on the machine');
    assert.strictEqual(machine.get('clarvis.agent.allowUnconfinedCommands'), true,
      'it still works, through the editor’s own store');
  });

  test('what is on disk is there before anything can ask, without waiting for a load', async () => {
    const storage = storageFolder();
    const first = mementoOn(storage, memento());
    await first.load();
    await first.update('clarvis.planning.interview', { seed: 'half answered', at: 2 });

    // A window opening now: `get` is synchronous and `activate` cannot await.
    const opening = mementoOn(storage, memento());

    assert.deepStrictEqual(opening.get('clarvis.planning.interview'), { seed: 'half answered', at: 2 },
      'an interview that reads as absent for the first moments is one that looks abandoned');
  });

  test('everything else still goes to the editor, and keys() shows both', async () => {
    const storage = storageFolder();
    const workspaceState = memento();
    const machine = mementoOn(storage, workspaceState);
    await machine.load();

    await machine.update('clarvis.recentFiles', ['src/app.ts']);
    await machine.update(BASE_BRANCH_KEY, 'main');

    assert.deepStrictEqual(workspaceState.get('clarvis.recentFiles'), ['src/app.ts'],
      'a key this does not own is passed straight through');
    assert.deepStrictEqual(machine.get('clarvis.recentFiles'), ['src/app.ts']);
    assert.deepStrictEqual([...machine.keys()].sort(),
      ['clarvis.agent.baseBranch', 'clarvis.recentFiles'],
      'code that walks the keys must still see the ones that moved');
  });

  test("another window's change is picked up, and this window never writes its stale copy back", async () => {
    const storage = storageFolder();
    const here = mementoOn(storage, memento());
    const there = mementoOn(storage, memento());
    await here.load();
    await there.load();
    await here.update(BASE_BRANCH_KEY, 'main');
    await there.refresh();

    // The other window changes the base while this one is still running.
    await there.update(BASE_BRANCH_KEY, 'release');
    // This one finishes its run and writes the record it has been holding.
    await here.update(LAST_RUN_KEY, { intent: 'a long run', filesChanged: ['src/app.ts'] });

    const [file] = stateFiles(storage);
    const written = JSON.parse(fs.readFileSync(path.join(storage, 'state', file), 'utf8'));
    assert.strictEqual(written.values[BASE_BRANCH_KEY], 'release',
      'a stale base branch written back over the other window is how a run merges into the wrong branch');
    assert.strictEqual(here.get(BASE_BRANCH_KEY), 'release', 'and the write refreshed what this window holds');
    await here.refresh();
    assert.deepStrictEqual(here.get<{ filesChanged: string[] }>(LAST_RUN_KEY)?.filesChanged, ['src/app.ts']);
  });
});

function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T) => (values.has(key) ? (values.get(key) as T) : fallback),
    update: async (key: string, value: unknown) => void values.set(key, value),
  } as vscode.Memento;
}
