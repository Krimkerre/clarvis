import test from 'node:test';
import assert from 'node:assert/strict';
import { absorbStreamEvent } from './streamNarration';
import { ReplyStateReader } from '../chat/replyState';

test('a tag split across two text events never reaches a visible fragment', () => {
  // The exact defect from 20 Aug. Streaming used to yield event.text directly, and only
  // stripped a second copy built for the log — after every fragment was already on
  // screen. "[[tal" + "king]] I'm a butler" reached the transcript with the tag intact.
  const reader = new ReplyStateReader();
  const calls: import('../model/ModelProvider').ToolCall[] = [];

  const first = absorbStreamEvent({ type: 'text', text: '[[tal' }, calls, reader, '');
  const second = absorbStreamEvent({ type: 'text', text: "king]] I'm a butler." }, calls, reader, first.narration);

  assert.equal(first.visible, '');
  assert.equal(second.visible, "I'm a butler.");
  assert.equal(reader.state, 'talking');
});

test('narration accumulates the raw text, unstripped, for the log', () => {
  // The log line and the eventual commit message want the full narration including
  // whatever led the tag — stripping happens for the reader's `visible` output, not for
  // what gets recorded about the turn.
  const reader = new ReplyStateReader();
  const calls: import('../model/ModelProvider').ToolCall[] = [];

  const { narration } = absorbStreamEvent({ type: 'text', text: '[[judging]] That failed.' }, calls, reader, '');
  assert.equal(narration, '[[judging]] That failed.');
});

test('a tool call is recorded and shows nothing', () => {
  const reader = new ReplyStateReader();
  const calls: import('../model/ModelProvider').ToolCall[] = [];
  const call = { id: '1', name: 'readFile', args: { path: 'a.ts' } };

  const outcome = absorbStreamEvent({ type: 'toolCall', call }, calls, reader, 'so far');
  assert.deepEqual(calls, [call]);
  assert.equal(outcome.visible, '');
  assert.equal(outcome.narration, 'so far');
});

test('a reply with no tag at all streams normally', () => {
  const reader = new ReplyStateReader();
  const calls: import('../model/ModelProvider').ToolCall[] = [];

  const outcome = absorbStreamEvent({ type: 'text', text: 'Ran the tests. They pass.' }, calls, reader, '');
  assert.equal(outcome.visible, 'Ran the tests. They pass.');
});
