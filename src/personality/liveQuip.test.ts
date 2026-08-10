import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quipPrompt, sanitiseQuip, MAX_QUIP_LENGTH } from './liveQuip';

test('the prompt states the constraints, not just the mood', () => {
  // A model asked for "a witty remark" returns three sentences of setup, a quoted
  // punchline, and an offer to help. The constraints are the load-bearing part.
  const prompt = quipPrompt({ trigger: 'firstCommitAfterSilence', sharp: false, detail: 'app.js' });

  assert.match(prompt, /One sentence/);
  assert.match(prompt, /Under 100 characters/);
  assert.match(prompt, /never about the user being bad at their job/);
  assert.match(prompt, /Stay polite/);
});

test('the sharper register is unlocked by the session, not by the model', () => {
  assert.match(quipPrompt({ trigger: 'repeatFailure', sharp: true }), /may be pointed/);
  assert.match(quipPrompt({ trigger: 'repeatFailure', sharp: false }), /Stay polite/);
});

test('a clean one-liner passes through unchanged', () => {
  assert.equal(sanitiseQuip('A commit. The repository was starting to worry.'),
    'A commit. The repository was starting to worry.');
});

test('quotes and prefaces are stripped', () => {
  // Both are things models do unprompted, and neither is part of the remark.
  assert.equal(sanitiseQuip('"It lives."'), 'It lives.');
  assert.equal(sanitiseQuip("Here's a remark: It lives."), 'It lives.');
  assert.equal(sanitiseQuip('Clarvis: It lives.'), 'It lives.');
});

test('a second line is dropped, because it always explains the first', () => {
  assert.equal(sanitiseQuip('It lives.\n\nThis plays on the idea of a dormant repo.'), 'It lives.');
});

test('anything too long is rejected rather than trimmed', () => {
  // A truncated joke is worse than a canned one, and the bank is right there.
  assert.equal(sanitiseQuip('x'.repeat(MAX_QUIP_LENGTH + 1)), undefined);
});

test('questions, emoji and exclamation are rejected', () => {
  // An aside that asks something is an invitation to answer. The other two are not
  // this character.
  assert.equal(sanitiseQuip('Shall I run the tests?'), undefined);
  assert.equal(sanitiseQuip('It lives! 🎉'), undefined);
  assert.equal(sanitiseQuip('It lives!'), undefined);
});

test('an empty or absent reply is simply nothing', () => {
  assert.equal(sanitiseQuip(''), undefined);
  assert.equal(sanitiseQuip('   '), undefined);
  assert.equal(sanitiseQuip(undefined), undefined);
});

test('a colon inside a real remark is not mistaken for a preface', () => {
  // "Note: this is fine" would be eaten by a naive prefix strip.
  assert.equal(
    sanitiseQuip('Three failures: I am starting to see a pattern.'),
    'Three failures: I am starting to see a pattern.'
  );
});
