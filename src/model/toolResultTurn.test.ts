import test from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicMessage } from './AnthropicProvider';
import { toOpenAiMessages } from './OpenAiCompatibleProvider';
import { interjectionMessage } from '../agent/interjections';

/**
 * What the model is actually sent for the turn that carries a step's tool results.
 *
 * The agent loop puts anything the user typed mid-run into that same neutral message, as
 * `content` beside `toolResults`. Up to 0.13.1 both serialisers returned the results and
 * nothing else, so a redirect was logged ("agent: redirected mid-run — …"), removed from
 * the queue, and never reached the model — which carried on the old way as if nobody had
 * spoken. The redirect below is built by the real `interjectionMessage`, as the loop does.
 */

const redirect = interjectionMessage(['no, use the other library']);

// Two results, one failed: the redirect has to land after the last of them, and the
// error flag has to survive the change of shape.
const results = [
  { id: 'call_1', content: 'contents of a.ts' },
  { id: 'call_2', content: 'no matches', isError: true },
];

test('Anthropic: a mid-run redirect reaches the model, after the tool results', () => {
  // Guards the live failure: only the tool_result blocks went out and the redirect was
  // silently dropped. Text placed ahead of the results would be a 400 instead.
  assert.deepEqual(toAnthropicMessage({ role: 'user', content: redirect, toolResults: results }), {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'contents of a.ts' },
      { type: 'tool_result', tool_use_id: 'call_2', content: 'no matches', is_error: true },
      { type: 'text', text: redirect },
    ],
  });
});

test('Anthropic: a step nobody interrupted sends the tool results alone', () => {
  // Guards the fix from breaking every ordinary step: the loop passes '' when nothing
  // was said, and an empty text block is rejected by the API.
  assert.deepEqual(toAnthropicMessage({ role: 'user', content: '', toolResults: results }), {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'call_1', content: 'contents of a.ts' },
      { type: 'tool_result', tool_use_id: 'call_2', content: 'no matches', is_error: true },
    ],
  });
});

test('OpenAI-compatible: a mid-run redirect reaches the model as a user turn after every tool message', () => {
  // Guards the live failure: only the `role: 'tool'` messages went out and the redirect
  // was silently dropped. A user turn wedged between the two would leave call_2
  // unanswered, which is rejected.
  assert.deepEqual(toOpenAiMessages({ role: 'user', content: redirect, toolResults: results }), [
    { role: 'tool', tool_call_id: 'call_1', content: 'contents of a.ts' },
    { role: 'tool', tool_call_id: 'call_2', content: 'no matches' },
    { role: 'user', content: redirect },
  ]);
});

test('OpenAI-compatible: a step nobody interrupted sends the tool messages alone', () => {
  // Guards the fix from putting an empty user turn after every ordinary step.
  assert.deepEqual(toOpenAiMessages({ role: 'user', content: '', toolResults: results }), [
    { role: 'tool', tool_call_id: 'call_1', content: 'contents of a.ts' },
    { role: 'tool', tool_call_id: 'call_2', content: 'no matches' },
  ]);
});
