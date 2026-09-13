import * as assert from 'assert';
import * as vscode from 'vscode';
import { CHAT_MODEL_CODEX_LINE, chatModelRefusal, chatRunDecision, PALETTE_CODEX_LINE, paletteRunDecision } from '../chat/codingRunFactory';
import { currentEngineChoice } from '../engine/engineHost';
import { ModelService } from '../model/ModelService';

/**
 * The engine seam against real VS Code settings (plan.md M15, C2a): `ravis/codex` chosen in the owner's
 * own settings, at RAVIS on this Mac, is Codex for the chat's run; the command palette never runs it; and
 * the answer path refuses it as a chat model. The rules themselves are unit-tested in
 * `engineChoice.test.ts` and `codingRunFactory.test.ts`; this checks the glue reads the settings the way
 * those tests assume. Settings are written at user scope only — a workspace write would put a
 * `.vscode/settings.json` into the fixture folder in the repository.
 */
suite('engine choice in the extension host (M15 C2a)', () => {
  const set = (key: string, value: unknown) =>
    vscode.workspace.getConfiguration('clarvis').update(key, value, vscode.ConfigurationTarget.Global);

  teardown(async () => {
    for (const key of ['agent.model', 'agent.provider', 'chat.baseUrl.custom']) await set(key, undefined);
  });

  test('ravis/codex in user settings is Codex for the chat, and the palette refuses it with a pointer to the panel', async () => {
    await vscode.extensions.getExtension('Krimkerre.clarvis')?.activate();
    await set('agent.provider', 'custom');
    await set('chat.baseUrl.custom', 'http://127.0.0.1:8731');
    await set('agent.model', 'ravis/codex');
    // Only settings are read for the choice; the key store is never touched.
    const models = new ModelService({} as vscode.ExtensionContext, () => undefined);

    const choice = currentEngineChoice(models);

    if (vscode.workspace.isTrusted) assert.deepStrictEqual(chatRunDecision(choice), { run: 'codex' });
    else assert.strictEqual(chatRunDecision(choice).run, 'refused');
    assert.deepStrictEqual(paletteRunDecision(choice).run, 'refused');
    if (vscode.workspace.isTrusted) assert.deepStrictEqual(paletteRunDecision(choice), { run: 'refused', line: PALETTE_CODEX_LINE });
  });

  test('any other coding model is Clarvis’s own engine, for the chat and the palette alike', async () => {
    await set('agent.model', 'claude-sonnet-4.5');
    const models = new ModelService({} as vscode.ExtensionContext, () => undefined);

    const choice = currentEngineChoice(models);

    assert.deepStrictEqual(chatRunDecision(choice), { run: 'clarvis' });
    assert.deepStrictEqual(paletteRunDecision(choice), { run: 'clarvis' });
  });

  test('the answer path refuses Codex as a chat model', () => {
    assert.strictEqual(chatModelRefusal('ravis/codex'), CHAT_MODEL_CODEX_LINE);
  });
});
