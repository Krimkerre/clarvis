import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { BASE_BRANCH_KEY } from '../agent/AgentBranch';
import { LAST_RUN_KEY } from '../agent/runLedger';
import { MachineMemento } from '../storage/machineMemento';

/**
 * The branch memory on this machine's disk, through the editor's own file API (20 September 2026).
 *
 * `machineState.test.ts` pins the rules; this pins the part that touches disk, and the two things
 * a regression would quietly undo: that these keys no longer reach `workspaceState`, and that a
 * workspace which already had them keeps them.
 */

const OWNED = [BASE_BRANCH_KEY, LAST_RUN_KEY];

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

suite('the branch memory, kept on this machine', () => {
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

  test('everything else still goes to the editor, and keys() shows both', async () => {
    const storage = storageFolder();
    const workspaceState = memento();
    const machine = mementoOn(storage, workspaceState);
    await machine.load();

    await machine.update('clarvis.planning.offerDeclined', true);
    await machine.update(BASE_BRANCH_KEY, 'main');

    assert.strictEqual(workspaceState.get('clarvis.planning.offerDeclined'), true,
      'a key this does not own is passed straight through');
    assert.strictEqual(machine.get('clarvis.planning.offerDeclined'), true);
    assert.deepStrictEqual([...machine.keys()].sort(),
      ['clarvis.agent.baseBranch', 'clarvis.planning.offerDeclined'],
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
