import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodingRun } from '../engine/CodingRun';
import { chooseEngine } from '../engine/engineChoice';
import {
  CHAT_MODEL_CODEX_LINE,
  chatModelRefusal,
  chatRunDecision,
  createCodingRun,
  PALETTE_CODEX_LINE,
  paletteRunDecision,
} from './codingRunFactory';

/**
 * The three places that construct runners, and what each may build. The palette never runs Codex, whose
 * questions need the panel; the read-only answer path never talks to Codex at all.
 */

const trusted = { source: 'user' as const, baseUrl: 'http://127.0.0.1:8731', trusted: true };
const codex = chooseEngine({ ...trusted, model: 'ravis/clarvis-codex' });
const clarvis = chooseEngine({ ...trusted, model: 'ravis/clarvis-agent' });
const refused = chooseEngine({ ...trusted, model: 'ravis/clarvis-codex', source: 'workspace' });

test("the chat's run builds whichever engine was chosen, or refuses with the choice's reason", () => {
  assert.deepEqual(chatRunDecision(codex), { run: 'codex' });
  assert.deepEqual(chatRunDecision(clarvis), { run: 'clarvis' });
  assert.deepEqual(chatRunDecision(refused), { run: 'refused', line: refused.engine === 'refused' ? refused.line : '' });
});

test('the palette never runs Codex: it points at the panel, and still refuses a Codex choice that is refused anyway', () => {
  assert.deepEqual(paletteRunDecision(codex), { run: 'refused', line: PALETTE_CODEX_LINE });
  assert.deepEqual(paletteRunDecision(clarvis), { run: 'clarvis' });
  assert.equal(paletteRunDecision(refused).run, 'refused');
});

test('the answer path refuses a chat model that is Codex, before any request; every other chat model answers', () => {
  assert.equal(chatModelRefusal('ravis/clarvis-codex'), CHAT_MODEL_CODEX_LINE);
  assert.equal(chatModelRefusal('ravis/clarvis-codex/gpt-6-astra'), CHAT_MODEL_CODEX_LINE);
  assert.equal(chatModelRefusal('ravis/clarvis-chat'), undefined);
  assert.equal(chatModelRefusal(''), undefined);
});

test('the factory builds only the engine decided on', () => {
  const built: string[] = [];
  const runner = (engine: 'clarvis' | 'codex') => ({ engine }) as unknown as CodingRun;
  const builders = {
    clarvis: () => (built.push('clarvis'), runner('clarvis')),
    codex: () => (built.push('codex'), runner('codex')),
  };

  assert.equal(createCodingRun('codex', builders).engine, 'codex');
  assert.equal(createCodingRun('clarvis', builders).engine, 'clarvis');
  assert.deepEqual(built, ['codex', 'clarvis']);
});
