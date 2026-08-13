import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeAnswerPrompt, cleanSynthesizedAnswer } from './synthesizePrompt';

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
  assert.match(prompt, /say what remains open/);
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
