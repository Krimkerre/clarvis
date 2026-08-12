import test from 'node:test';
import assert from 'node:assert/strict';
import { absorbToolDeltas } from './OpenAiCompatibleProvider';
import { absorbDelta, startsToolBlock } from './AnthropicProvider';

/**
 * The two providers assemble a tool call from fragments, in two different ways, and this
 * is where a malformed call comes from when it comes from anywhere.
 *
 * Untestable until now: it lived inside a `for await` over a network stream. Extracting
 * it to satisfy the complexity rule is what made these possible, which is the argument
 * for the rule better than the number is.
 */

test('OpenAI: a call split across frames keeps what earlier frames established', () => {
  // The shape this exists for: the name arrives once, the id once, and the arguments a
  // few characters at a time — each field has to survive frames that omit it.
  const pending = new Map();

  absorbToolDeltas(pending, [{ index: 0, id: 'call_1', function: { name: 'readFile' } }]);
  absorbToolDeltas(pending, [{ index: 0, function: { arguments: '{"path":' } }]);
  absorbToolDeltas(pending, [{ index: 0, function: { arguments: '"a.ts"}' } }]);

  assert.deepEqual(pending.get(0), { id: 'call_1', name: 'readFile', args: '{"path":"a.ts"}' });
});

test('OpenAI: two calls in one turn do not bleed into each other', () => {
  // Position is the only thing distinguishing them, so an index that was ignored would
  // concatenate two calls into one unparseable argument string.
  const pending = new Map();

  absorbToolDeltas(pending, [
    { index: 0, id: 'a', function: { name: 'readFile', arguments: '{"path":"a"}' } },
    { index: 1, id: 'b', function: { name: 'search', arguments: '{"pattern":"x"}' } },
  ]);

  assert.equal(pending.get(0).name, 'readFile');
  assert.equal(pending.get(1).name, 'search');
});

test('OpenAI: a frame with no tool deltas changes nothing', () => {
  const pending = new Map();
  absorbToolDeltas(pending, undefined);
  assert.equal(pending.size, 0);
});

test('Anthropic: a delta for an open tool block is never spoken aloud', () => {
  // The trap: content_block_delta carries prose *and* tool arguments, and only the index
  // says which. A tool's JSON yielded as text would be read out to the user.
  const pending = new Map([[0, { id: 'x', name: 'readFile', json: '' }]]);

  assert.equal(absorbDelta(pending, 0, { partial_json: '{"path":' }), undefined);
  assert.equal(absorbDelta(pending, 0, { partial_json: '"a.ts"}' }), undefined);
  assert.equal(pending.get(0)!.json, '{"path":"a.ts"}');
});

test('Anthropic: a delta for a block that is not a tool call is text', () => {
  const pending = new Map<number, { id: string; name: string; json: string }>();

  assert.equal(absorbDelta(pending, 0, { text: 'Right.' }), 'Right.');
});

test('Anthropic: only a tool_use block opens a call', () => {
  assert.equal(
    startsToolBlock({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'readFile' } }),
    true
  );
  assert.equal(
    startsToolBlock({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
    false
  );
});
