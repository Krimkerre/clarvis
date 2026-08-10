import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SHAPE, character, characterWith } from './character';

test('the voice comes last, after whatever rules the surface adds', () => {
  // Character-first was tried and lost. In chat the voice sat four hundred words above
  // a tool loop, and the reply opened with "Got it", narrated what it had read, praised
  // the file and closed with a question — four things the brief bans outright. Recency
  // is the only lever that reaches past a summarise-the-document prior.
  const prompt = characterWith('Rule one.', 'Rule two.');

  assert.ok(prompt.indexOf('Rule one.') < prompt.indexOf('Never neutral'));
  assert.ok(prompt.endsWith(character().slice(-40)));
});

test('the answer shape is checkable rather than tasteful', () => {
  // "Be brief" is a preference a model can satisfy in six sentences. After a tool loop
  // only rules with an observable pass/fail survive.
  assert.match(ANSWER_SHAPE, /At most three sentences/);
  assert.match(ANSWER_SHAPE, /Do not open with an acknowledgement/);
  assert.match(ANSWER_SHAPE, /Do not end with a question/);
});
