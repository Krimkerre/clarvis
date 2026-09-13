import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseEngine, codexListingHeaders, ENGINE_REFUSAL_LINES, modelsForRole, namesCodex, type EngineInputs } from './engineChoice';

/**
 * Which engine a coding task goes to. Codex spends the owner's ChatGPT plan inside RAVIS, so it is
 * reached only when every rule holds, and anything else that names it is refused with a reason rather
 * than quietly sent somewhere else.
 */

const CHOSEN: EngineInputs = { model: 'ravis/clarvis-codex', source: 'user', baseUrl: 'http://127.0.0.1:8731', trusted: true };

test('ravis/clarvis-codex, chosen in the owner’s own settings, at an address on this Mac, in a trusted folder, runs Codex', () => {
  assert.deepEqual(chooseEngine(CHOSEN), { engine: 'codex' });
  assert.deepEqual(chooseEngine({ ...CHOSEN, baseUrl: 'http://localhost:8731' }), { engine: 'codex' });
  assert.deepEqual(chooseEngine({ ...CHOSEN, model: '  ravis/clarvis-codex ' }), { engine: 'codex' }, 'stray spaces are not a way out');
});

test("every other model is Clarvis's own engine, whoever set it and wherever it points", () => {
  assert.deepEqual(chooseEngine({ ...CHOSEN, model: 'ravis/clarvis-agent' }), { engine: 'clarvis' });
  assert.deepEqual(chooseEngine({ model: 'claude-sonnet-4.5', source: 'workspace', baseUrl: 'https://api.anthropic.com', trusted: false }), {
    engine: 'clarvis',
  });
  assert.deepEqual(chooseEngine({ ...CHOSEN, model: 'ravis/clarvis-codexy' }), { engine: 'clarvis' }, 'a name that only starts the same is not Codex');
});

test('each rule a Codex choice breaks refuses with its own reason and sentence', () => {
  const cases: [Partial<EngineInputs>, string][] = [
    [{ model: 'ravis/clarvis-codex/gpt-6-astra' }, 'codex_variant'],
    [{ source: 'workspace' }, 'repository_setting'],
    [{ source: 'folder' }, 'repository_setting'],
    [{ source: 'default' }, 'repository_setting'],
    [{ baseUrl: 'http://192.168.1.20:8731' }, 'not_loopback'],
    [{ baseUrl: 'not an address' }, 'not_loopback'],
    [{ trusted: false }, 'untrusted'],
  ];

  for (const [change, reason] of cases) {
    const choice = chooseEngine({ ...CHOSEN, ...change });
    assert.deepEqual(choice, { engine: 'refused', reason, line: ENGINE_REFUSAL_LINES[reason as keyof typeof ENGINE_REFUSAL_LINES] }, JSON.stringify(change));
  }
});

test('a repository that chooses Codex is refused even when everything else would allow it', () => {
  // The rule that matters most: a committed .vscode/settings.json must not move its reader onto a paid agent.
  const choice = chooseEngine({ ...CHOSEN, source: 'workspace' });
  assert.equal(choice.engine, 'refused');
  assert.match(choice.engine === 'refused' ? choice.line : '', /Choose it yourself under Models/);
});

test('the listing asks RAVIS for Codex only on this Mac, so no other server is told about it', () => {
  assert.deepEqual(codexListingHeaders('http://127.0.0.1:8731'), { 'X-Clarvis-Engines': 'codex' });
  assert.deepEqual(codexListingHeaders('https://openrouter.ai/api'), {});
});

test('the chat model picker never offers Codex; the coding model picker does', () => {
  const listed = [{ id: 'ravis/clarvis-chat' }, { id: 'ravis/clarvis-codex' }, { id: 'ravis/clarvis-codex/gpt-6-astra' }];
  assert.deepEqual(modelsForRole(listed, 'chat'), [{ id: 'ravis/clarvis-chat' }]);
  assert.deepEqual(modelsForRole(listed, 'agent'), listed);
});

test('namesCodex: the id itself and anything under it, and nothing else', () => {
  assert.equal(namesCodex('ravis/clarvis-codex'), true);
  assert.equal(namesCodex('ravis/clarvis-codex/x'), true);
  assert.equal(namesCodex('ravis/clarvis-codex-mini'), false);
  assert.equal(namesCodex('ravis/codex'), false, 'the old id, renamed on 13 September 2026, has no alias');
  assert.equal(namesCodex(''), false);
});
