import test from 'node:test';
import assert from 'node:assert/strict';
import { interjectionMessage } from './interjections';

test('an empty queue produces nothing to send', () => {
  // The caller passes this straight into a message whose real payload is the tool
  // results, so "nothing said" has to be an empty string rather than a stray line.
  assert.equal(interjectionMessage([]), '');
});

test('the interruption is framed as outranking the plan in flight', () => {
  // Arriving as one more user message among tool results, an interruption reads as
  // extra context rather than a change of course — and the model finishes what it
  // was doing first, which is what the user interrupted to prevent.
  const message = interjectionMessage(['use the other library']);

  assert.match(message, /takes priority over the plan you were\s*following/);
  assert.match(message, /rather than finishing the old way first/);
  assert.match(message, /- use the other library/);
});

test('it asks him to say what changed', () => {
  // A redirect obeyed silently is indistinguishable from one that was ignored.
  assert.match(interjectionMessage(['stop using tabs']), /say what you changed/);
});

test('several things said in quick succession all arrive', () => {
  // Three sentences typed quickly are three separate messages to VS Code. Dropping
  // two would be worse than useless: the user cannot tell which one survived.
  const message = interjectionMessage(['use pytest', 'and skip the CLI for now', 'call it renamer']);

  assert.match(message, /- use pytest/);
  assert.match(message, /- and skip the CLI for now/);
  assert.match(message, /- call it renamer/);
});
