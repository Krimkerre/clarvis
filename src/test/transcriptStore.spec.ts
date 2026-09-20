import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Session } from '../chat/history';
import { TranscriptStore } from '../chat/transcriptStore';

/**
 * Conversations on this machine's disk, through the editor's own file API (20 September 2026).
 *
 * `transcriptFile.test.ts` pins the rules; this pins the part that touches disk — the file lands
 * where it is meant to, the old key-value store is read once and then left alone, and a clear is a
 * delete. Run in the extension host, because `vscode.workspace.fs` is the thing under test.
 */

const said = (text: string, at = 1): Session => ({ startedAt: at, turns: [{ speaker: 'user', text, at }] });

function storeIn(storage: string, workspaceState: vscode.Memento): TranscriptStore {
  const context = {
    workspaceState,
    globalState: memento(),
    globalStorageUri: vscode.Uri.file(storage),
  } as unknown as vscode.ExtensionContext;
  return new TranscriptStore(context, () => undefined);
}

function storageFolder(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-chat-storage-'));
}

function chatFiles(storage: string): string[] {
  const chats = path.join(storage, 'chats');
  return fs.existsSync(chats) ? fs.readdirSync(chats).filter((name) => name.endsWith('.json')) : [];
}

suite('where a conversation is kept', () => {
  test('a saved conversation is a file on this machine, named for the workspace', async () => {
    const storage = storageFolder();
    const store = storeIn(storage, memento());

    await store.save(said('is this on disk?'));

    const [file] = chatFiles(storage);
    assert.ok(file, `no file under ${storage}/chats — this is what code-server never wrote`);
    const written = JSON.parse(fs.readFileSync(path.join(storage, 'chats', file), 'utf8'));
    assert.strictEqual(written.live[0].session.turns[0].text, 'is this on disk?');
    assert.strictEqual(written.folder, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? 'no-workspace',
      'the folder travels in the file, so a moved project is recognisable');
    assert.deepStrictEqual(chatFiles(storage).filter((name) => name.startsWith('.')), [],
      'the temporary file it writes through is renamed away');
  });

  test('conversations already in the old key-value store are read once, and then the file is used', async () => {
    const storage = storageFolder();
    const workspaceState = memento();
    await workspaceState.update('clarvis.chat.current', said('unfinished'));
    await workspaceState.update('clarvis.chat.history', [said('from before')]);
    const store = storeIn(storage, workspaceState);

    const before = await store.read();
    assert.strictEqual(before.live[0].session.turns[0].text, 'unfinished');
    assert.strictEqual(before.history[0].turns[0].text, 'from before');

    await store.save(said('and now this'));

    assert.deepStrictEqual((await store.history()).map((one) => one.turns[0].text), ['from before'],
      'the archive came across');
    assert.ok(workspaceState.get('clarvis.chat.current'), 'the old copy is left where it was, not deleted');
  });

  test('two windows on one workspace keep both conversations', async () => {
    const storage = storageFolder();
    const first = storeIn(storage, memento());
    const second = storeIn(storage, memento());

    await first.save(said('from the first window'));
    await second.save(said('from the second'));
    await first.save(said('the first, again'));

    const live = (await second.read()).live.map((one) => one.session.turns[0].text).sort();
    assert.deepStrictEqual(live, ['from the second', 'the first, again']);
  });

  test('what an earlier window left behind is filed, and clearing is a delete', async () => {
    const storage = storageFolder();
    const crashed = storeIn(storage, memento());
    await crashed.save(said('asked before the crash', 1));

    const fresh = storeIn(storage, memento());
    const filed = await fresh.fileLeftovers(Date.now() + 1000);

    assert.deepStrictEqual(filed.map((one) => one.turns[0].text), ['asked before the crash']);
    assert.deepStrictEqual((await fresh.history()).map((one) => one.turns[0].text), ['asked before the crash']);

    await fresh.save(said('something private'));
    await fresh.forget();

    const [file] = chatFiles(storage);
    assert.ok(!fs.readFileSync(path.join(storage, 'chats', file), 'utf8').includes('something private'),
      'Clear Conversation clears the file too, or it returns on the next reload');
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
