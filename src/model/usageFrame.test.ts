import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider';
import { providerSpec } from './providers';

/**
 * The stream RAVIS relays once it asks upstreams for their token counts.
 *
 * Since RAVIS 0.28.3 (16 September 2026) RAVIS adds `stream_options.include_usage` to
 * every streamed request that did not say either way, so it can record what the call
 * cost. The upstream then writes `"usage": null` into each frame and ends with one more:
 * `choices` empty, `usage` filled in. OpenRouter already sent that last frame unasked and
 * Clarvis read it as nothing; these pin that both stream paths still do, now that every
 * provider behind RAVIS may send it.
 */

const HEAD = { id: 'c1', object: 'chat.completion.chunk', model: 'gpt-4.1-2025-04-14' };

const STREAM = [
  { ...HEAD, choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }], usage: null },
  { ...HEAD, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: null },
  { ...HEAD, choices: [], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13 } },
]
  .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
  .join('')
  .concat('data: [DONE]\n\n');

function provider(): OpenAiCompatibleProvider {
  const spec = providerSpec('custom');
  assert.ok(spec);
  return new OpenAiCompatibleProvider(spec, async () => undefined, () => 'http://runtime.invalid', () => {});
}

async function withStream<T>(run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(STREAM, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const REQUEST = {
  system: 's',
  messages: [{ role: 'user' as const, content: 'hello' }],
  model: 'ravis/clarvis-chat',
};

test('a plain stream reads the usage frame as no text', async () => {
  const text = await withStream(async () => {
    let said = '';
    for await (const fragment of provider().stream(REQUEST)) said += fragment;
    return said;
  });

  assert.equal(text, 'pong');
});

test('a tool-calling stream reads the usage frame as no text and ends normally', async () => {
  const events = await withStream(async () => {
    const seen: unknown[] = [];
    for await (const event of provider().streamWithTools({ ...REQUEST, tools: [] })) seen.push(event);
    return seen;
  });

  assert.deepEqual(events, [
    { type: 'text', text: 'pong' },
    { type: 'stop', reason: 'end' },
  ]);
});
