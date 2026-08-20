import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, isCompatible, OpenRouterModel } from './openrouterCatalog';

function model(overrides: Partial<OpenRouterModel> = {}): OpenRouterModel {
  return {
    id: 'vendor/model',
    supported_parameters: ['tools', 'temperature'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    pricing: { prompt: '0.000001' },
    context_length: 128_000,
    ...overrides,
  };
}

test('a model without tool support is excluded', () => {
  // The failure this prevents: a chat-capable model accepts the request, ignores the
  // tools, and the agent appears to do nothing at all.
  assert.equal(isCompatible(model({ supported_parameters: ['temperature'] })), false);
  assert.equal(isCompatible(model()), true);
});

test('non-text models are excluded even when they support tools', () => {
  // Image and audio endpoints sit in the same list and fail on the first question.
  assert.equal(
    isCompatible(model({ architecture: { input_modalities: ['image'], output_modalities: ['text'] } })),
    false
  );
  assert.equal(
    isCompatible(model({ architecture: { input_modalities: ['text'], output_modalities: ['image'] } })),
    false
  );
});

test('missing fields are treated as unsupported, not as permission', () => {
  // A third party will omit fields eventually. Assuming capability when it is unstated
  // means the user finds out mid-run.
  assert.equal(isCompatible({ id: 'x' }), false);
  assert.equal(isCompatible(model({ supported_parameters: undefined })), false);
  assert.equal(isCompatible(model({ architecture: undefined })), false);
});

test('the catalogue sorts cheapest first, with free models at the top', () => {
  const catalog = buildCatalog({
    data: [
      model({ id: 'mid', pricing: { prompt: '0.000005' } }),
      model({ id: 'free', pricing: { prompt: '0' } }),
      model({ id: 'dear', pricing: { prompt: '0.00006' } }),
    ],
  });

  assert.deepEqual(catalog.map((entry) => entry.id), ['free', 'mid', 'dear']);
  assert.match(catalog[0].detail, /free/);
});

test('one malformed entry does not empty the picker', () => {
  // This response comes from a third party; a single odd row must cost one row.
  const catalog = buildCatalog({
    data: [null, 'nonsense', { id: 42 }, model({ id: 'good' })],
  });

  assert.deepEqual(catalog.map((entry) => entry.id), ['good']);
  assert.deepEqual(buildCatalog(undefined), []);
  assert.deepEqual(buildCatalog({ data: 'not an array' }), []);
});

test('context and price are readable at a glance', () => {
  // "1048576" and "0.000000079996" tell nobody anything.
  const [big] = buildCatalog({ data: [model({ context_length: 1_048_576 })] });
  const [small] = buildCatalog({ data: [model({ context_length: 8192 })] });

  assert.match(big.detail, /1\.0M context/);
  assert.match(small.detail, /8K context/);
  assert.match(big.detail, /\$1\.00\/M in/);
});

import { buildOpenAiCatalog, describeOwner, isLikelyChatModel } from './openaiCatalog';

test('non-chat OpenAI models are filtered out of the picker', () => {
  // The list mixes in embeddings, speech and image models. Picking one produces an
  // unhelpful 400 and the reasonable conclusion that Clarvis is broken.
  for (const id of [
    'text-embedding-3-large',
    'tts-1-hd',
    'whisper-1',
    'dall-e-3',
    'omni-moderation-latest',
    'gpt-4o-realtime-preview',
    'gpt-4o-audio-preview',
  ]) {
    assert.equal(isLikelyChatModel(id), false, id);
  }
});

test('chat models survive the filter', () => {
  for (const id of ['gpt-5', 'gpt-4.1-mini', 'o3', 'chatgpt-4o-latest', 'llama3.1:70b']) {
    assert.equal(isLikelyChatModel(id), true, id);
  }
});

test('an OpenAI-style list sorts newest first when dates are present', () => {
  const catalog = buildOpenAiCatalog({
    data: [
      { id: 'old-model', created: 100 },
      { id: 'new-model', created: 900 },
      { id: 'text-embedding-3-small', created: 500 },
    ],
  });

  assert.deepEqual(catalog.map((entry) => entry.id), ['new-model', 'old-model']);
});

test('a list without dates sorts alphabetically rather than arbitrarily', () => {
  // Local runtimes omit `created`. An unstable order means the list reshuffles between
  // openings, which makes a familiar model impossible to find twice.
  const catalog = buildOpenAiCatalog({ data: [{ id: 'zephyr' }, { id: 'llama3' }, { id: 'mistral' }] });

  assert.deepEqual(catalog.map((entry) => entry.id), ['llama3', 'mistral', 'zephyr']);
});

test('a malformed OpenAI list degrades to what parses', () => {
  assert.deepEqual(buildOpenAiCatalog({ data: [null, { id: 5 }, { id: 'gpt-5' }] }).map((e) => e.id), [
    'gpt-5',
  ]);
  assert.deepEqual(buildOpenAiCatalog('nonsense'), []);
});

// --------------------------------- what a model says about itself beyond its name

test('the schema placeholder is not read out as an owner', () => {
  // LM Studio returns organization_owner for every model, so a local list read
  // "by organization_owner" all the way down — a column of noise.
  assert.equal(describeOwner('bonsai-27b', 'organization_owner'), 'chat model');
});

test('the id supplies the owner the field withheld', () => {
  // Local ids are usually vendor/name, and the prefix is the real answer — already in
  // hand, no second request needed.
  assert.equal(describeOwner('prism-ml/bonsai-27b', 'organization_owner'), 'by prism-ml');
  assert.equal(describeOwner('lmstudio-community/Qwen3-Coder-Next-MLX-4bit', undefined), 'by lmstudio-community');
});

test('a real owner is still used', () => {
  assert.equal(describeOwner('claude-opus-5', 'anthropic'), 'by anthropic');
});

test('an owner that merely repeats the provider is dropped', () => {
  // "by openai" under a provider already labelled OpenAI is a word that says nothing.
  assert.equal(describeOwner('gpt-5', 'openai'), 'chat model');
});

test('a bare id with nothing to say says so plainly', () => {
  assert.equal(describeOwner('llama3', undefined), 'chat model');
});

test('the catalogue uses it', () => {
  const catalog = buildOpenAiCatalog({
    data: [{ id: 'prism-ml/bonsai-27b', owned_by: 'organization_owner' }],
  });
  assert.equal(catalog[0].detail, 'by prism-ml');
});
