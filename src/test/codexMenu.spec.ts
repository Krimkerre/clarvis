import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { CODEX_MENU_LINES } from '../chat/codexMenu';
import { CodexMenu, storedCodexChoice } from '../chat/codexMenuHost';
import { CodexGitGlue } from '../engine/codex/codexGit';
import { ModelService } from '../model/ModelService';
import { ButlerViewProvider } from '../panels/ButlerViewProvider';

/**
 * The bowtie's fold-out and Codex's undo copies against the real extension host (plan.md M15, C2b+). The menu's rules
 * are unit-tested in `codexMenu.test.ts` and `bowtieMenu.test.ts`; this checks the glue that imports vscode: the panel
 * carries the menu and its scripts in order, the bowtie menu, API config and a Codex pick each reach the extension as
 * the events the chat listens to, the Codex section is drawn disabled while another coding model is chosen (and a pick
 * then changes nothing), and the undo copies a Codex change takes are kept where Clarvis: Undo Last Agent Run finds
 * them. Settings are written at user scope only.
 */
suite('the bowtie fold-out and the undo copies in the extension host (M15 C2b+)', () => {
  const set = (key: string, value: unknown) =>
    vscode.workspace.getConfiguration('clarvis').update(key, value, vscode.ConfigurationTarget.Global);

  teardown(async () => {
    for (const key of ['agent.model', 'codex.model', 'codex.effort']) await set(key, undefined);
  });

  test('the panel carries the menu, and the bowtie menu, API config and a Codex pick each reach the extension', async () => {
    const extension = vscode.extensions.getExtension('Krimkerre.clarvis');
    assert.ok(extension);
    await extension.activate();
    const provider = new ButlerViewProvider(extension.extensionUri);
    let receive: (message: unknown) => void = () => undefined;
    const webview = {
      options: {},
      html: '',
      cspSource: 'vscode-webview://clarvis-test',
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        receive = listener;
        return { dispose: () => undefined };
      },
      postMessage: async () => true,
    };
    const view = { webview, visible: true, onDidDispose: () => ({ dispose: () => undefined }), onDidChangeVisibility: () => ({ dispose: () => undefined }) };
    const heard: string[] = [];
    provider.onDidOpenBowtieMenu(() => heard.push('menu'));
    provider.onDidRequestModels(() => heard.push('api config'));
    provider.onDidChooseCodex((picked) => heard.push(`codex ${String(picked.model)} ${String(picked.effort)}`));

    provider.resolveWebviewView(view as unknown as vscode.WebviewView);
    const html = webview.html;
    assert.ok(html.includes('id="clarvis-bowtie-menu"'), 'the menu container');
    assert.ok(html.includes('id="clarvis-run-status"'), "the run's status line");
    const menuScript = html.indexOf('root.ClarvisBowtieMenu = { createBowtieMenu }');
    const chatScript = html.indexOf('ClarvisBowtieMenu.createBowtieMenu(');
    assert.ok(menuScript !== -1 && chatScript !== -1 && menuScript < chatScript, 'the menu script comes before the chat that creates it');

    receive({ type: 'bowtie-menu' });
    receive({ type: 'models' });
    receive({ type: 'codex-choice', model: 'gpt-6-astra', effort: 'high' });
    assert.deepEqual(heard, ['menu', 'api config', 'codex gpt-6-astra high']);
    provider.disposable.dispose();
  });

  test('with another coding model, the Codex section is drawn disabled, pointing at API config, and a pick changes nothing', async () => {
    await vscode.extensions.getExtension('Krimkerre.clarvis')?.activate();
    await set('agent.model', 'claude-sonnet-4.5');
    const posted: unknown[] = [];
    // Only settings are read for the coding model; the key store is never touched.
    const models = new ModelService({} as vscode.ExtensionContext, () => undefined);
    const menu = new CodexMenu({ models, post: (message) => posted.push(message), log: () => undefined, taskRunning: () => false });

    await menu.opened();
    const message = posted[0] as { type: string; state: { enabled: boolean; line?: string } };
    assert.equal(message.type, 'codex-menu');
    assert.equal(message.state.enabled, false);
    assert.equal(message.state.line, CODEX_MENU_LINES.onlyForCodex);

    await menu.chose({ model: 'gpt-6-astra', effort: 'high' });
    assert.deepEqual(storedCodexChoice(), { model: undefined, effort: undefined });
  });

  test("a Codex change's undo copies are kept where Undo Last Agent Run finds them: a file's contents, and a file Codex adds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-undo-copies-'));
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-undo-store-'));
    try {
      fs.writeFileSync(path.join(root, 'app.ts'), 'before\n');
      const kept = new Map<string, unknown>();
      const memento = { get: (key: string) => kept.get(key), update: async (key: string, value: unknown) => void kept.set(key, value), keys: () => [...kept.keys()] };
      const context = { globalStorageUri: vscode.Uri.file(storage), workspaceState: memento, globalState: memento } as unknown as vscode.ExtensionContext;

      const glue = new CodexGitGlue(context, root, () => undefined);
      const capture = (paths: string[]) => glue.captureBeforeChange(paths);
      await capture(['app.ts', 'src/new.ts']);
      await capture(['app.ts']);
      fs.writeFileSync(path.join(root, 'app.ts'), 'after\n');

      const record = kept.get('clarvis.agent.checkpoint') as { task: string; entries: { file: string; copy?: string; created: boolean }[] };
      assert.equal(record.task, 'a Codex task');
      assert.deepEqual(record.entries.map((entry) => [entry.file, entry.created]), [['app.ts', false], [path.join('src', 'new.ts'), true]], 'each file once');
      assert.equal(fs.readFileSync(record.entries[0].copy as string, 'utf8'), 'before\n', 'the copy is from before the change');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(storage, { recursive: true, force: true });
    }
  });
});
