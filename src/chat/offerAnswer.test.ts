import test from 'node:test';
import assert from 'node:assert/strict';
import { offerAnswer } from './offerAnswer';

test('a plain yes or no is an answer', () => {
  for (const yes of ['yes', 'Yes', 'sure', 'go on', 'ok', 'do it']) assert.equal(offerAnswer(yes), 'yes', yes);
  for (const no of ['no', 'No', 'nope', 'not now', 'leave it', 'later']) assert.equal(offerAnswer(no), 'no', no);
});

test('a question is never an answer, however it starts', () => {
  // Found live, seconds after the previous fix shipped: "anything wrong in here?" was
  // filed as a decline and answered with "Noted. I will not bring it up again here."
  assert.equal(offerAnswer('anything wrong in here?'), 'unrelated');
  // And the nastier one: opens with a refusal, is plainly a question.
  assert.equal(offerAnswer('no idea, what is wrong here?'), 'unrelated');
});

test('getting on with something else drops the offer rather than declining it', () => {
  // An offer appears unprompted while someone was already typing. Consuming that as a
  // refusal both loses their message and records a decision they never made.
  assert.equal(offerAnswer('fix the failing test'), 'unrelated');
  assert.equal(offerAnswer('read plan.md and tell me what you think'), 'unrelated');
});

test('a refusal inside a longer sentence is not a refusal', () => {
  // Substring matching on "no" files "there is nothing wrong" as a decline.
  assert.equal(offerAnswer('there is nothing wrong with it'), 'unrelated');
});

test('a question-specific word counts as yes only for the question that offered it', () => {
  // "add" answers a scope offer; on its own it is not agreement to anything else.
  assert.equal(offerAnswer('add it to the plan', ['add']), 'yes');
  assert.equal(offerAnswer('add it to the plan'), 'unrelated');
  // "continue" answers a paused build, and used to be the one word the build offer
  // recognised that no other offer did.
  assert.equal(offerAnswer('continue', ['continue']), 'yes');
});

test('the shared vocabulary reaches every offer that supplies its own words', () => {
  // The drift this replaced: "do it" was a yes to a scope change and not to a build,
  // "sure" to a build and not to a review. Both now come from one list.
  for (const word of ['do it', 'sure', 'go on', 'yep']) {
    assert.equal(offerAnswer(word, ['add']), 'yes', `${word} should answer a scope offer`);
    assert.equal(offerAnswer(word, ['continue']), 'yes', `${word} should answer a build offer`);
  }
});

test('a question is not an answer, even when it opens with the offer own word', () => {
  // "add it?" is someone asking, not agreeing — and agreeing writes to plan.md.
  assert.equal(offerAnswer('add it?', ['add']), 'unrelated');
});
