import test from 'node:test';
import assert from 'node:assert/strict';
import {
  synthesizeAnswerPrompt,
  cleanSynthesizedAnswer,
  discardsOriginalAnswer,
} from './synthesizePrompt';

test('the prompt includes both answers and forbids inventing detail', () => {
  const prompt = synthesizeAnswerPrompt(
    'who-and-where',
    'locally, with a web interface',
    'same process or over a network?',
    'same process, everything is local'
  );
  assert.match(prompt, /locally, with a web interface/);
  assert.match(prompt, /same process, everything is local/);
  assert.match(prompt, /do not add,\s*infer, or invent/);
});

test('asks for a statement about the project, not about the person', () => {
  // Found live: "They want the linter, but not set up now." — hearsay about the
  // user, in a document describing the project, alongside answers phrased plainly.
  const prompt = synthesizeAnswerPrompt('linter', 'yip', 'set up now, or in principle?', 'nope');
  assert.match(prompt, /never "They want it to run locally"/);
});

test('the settled first answer may never be dropped for the follow-up', () => {
  // This assertion replaces one that checked for "say what remains open" — the clause
  // that caused F2. An off-topic follow-up made the model report the *original* topic
  // as unsettled, discarding an answer the user had given.
  const prompt = synthesizeAnswerPrompt(
    'comment-style',
    'no comments needed',
    'what happens when the file is missing?',
    'clean exit'
  );
  assert.match(prompt, /The first answer is already settled/);
  assert.match(prompt, /never drop the first to describe the second/);
  assert.match(prompt, /never about anything the first answer already settled/);
});

test('asks for prose, not a transcript', () => {
  const prompt = synthesizeAnswerPrompt('scope', 'a', 'q', 'b');
  assert.match(prompt, /not\s*a transcript, not a Q&A/);
});

test('cleanSynthesizedAnswer strips wrapping quotes and whitespace', () => {
  assert.equal(cleanSynthesizedAnswer('  "Runs locally, in one process."  '), 'Runs locally, in one process.');
});

test('cleanSynthesizedAnswer leaves unquoted text untouched', () => {
  assert.equal(cleanSynthesizedAnswer('Runs locally, in one process.'), 'Runs locally, in one process.');
});

// ---------------------------------------------------------------- F2, the guard

test('a synthesis that reports the topic as still open is rejected', () => {
  // The exact output observed on 19 Aug: the user said "no comments needed", and the
  // synthesis replaced it with a claim that comments had never been decided.
  assert.equal(
    discardsOriginalAnswer(
      'no comments needed',
      'The script handles a missing compliments file with a clean exit. The approach to comments remains open.'
    ),
    true
  );
});

test('the ways a model says "unsettled" are all caught', () => {
  const original = 'python';
  for (const wording of [
    'The language remains open.',
    'The choice is still undecided.',
    'This has not been decided yet.',
    'The format was never specified.',
    'The approach is left open for now.',
    'The storage question remains unclear.',
    'That detail is to be determined.',
  ]) {
    assert.equal(discardsOriginalAnswer(original, wording), true, wording);
  }
});

test('an ordinary synthesis is left alone', () => {
  // The guard must not fire on the common case, or every merged answer degrades to the
  // ugly concatenation and the synthesis step stops earning its keep.
  assert.equal(
    discardsOriginalAnswer(
      'no comments needed',
      'The code carries no comments beyond the genuinely surprising, and exits cleanly when the file is absent.'
    ),
    false
  );
});

test('a synthesis describing an open-source licence is not a report of an open question', () => {
  // "open" is a common word. The guard keys on a topic being *left* open, not on the
  // word appearing — a false positive costs a readable answer every time it fires.
  assert.equal(
    discardsOriginalAnswer('MIT', 'The project ships under an open source licence.'),
    false
  );
});

test('nothing to preserve means nothing to reject', () => {
  assert.equal(discardsOriginalAnswer('', 'The language remains open.'), false);
  assert.equal(discardsOriginalAnswer('python', ''), false);
});
