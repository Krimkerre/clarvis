import test from 'node:test';
import assert from 'node:assert/strict';
import { interviewQuestionPrompt, ensureNamesChoice, looksLikeQuestionBack, answerBackPrompt } from './interviewPrompt';
import { InterviewState } from './interviewTopics';

/**
 * The language topic's first live run asked a scoping question ("Windows or
 * macOS/Linux?") instead of a shortlist, and "preferrably multi-platform" — an OS
 * constraint, not a language — was recorded under `language` with the interview
 * reporting zero open questions. It looked finished; no language had been chosen.
 */

const state: InterviewState = {
  answers: [
    { topic: 'what-it-does', text: 'renames photos by EXIF date' },
    { topic: 'who-and-where', text: 'CLI, local machine' },
  ],
};

test('the language prompt asks for a shortlist, not a question', () => {
  const prompt = interviewQuestionPrompt('language', state);

  assert.match(prompt, /shortlist/i);
  assert.match(prompt, /2 to 4/);
  assert.doesNotMatch(prompt, /Ask ONE question/);
});

test('every option must carry a real cost', () => {
  const prompt = interviewQuestionPrompt('language', state);
  assert.match(prompt, /real\s+cost/i);
});

test('the model is told to output a strict parseable format, not prose', () => {
  // "You pick" and the free-text fallback are now added by code as QuickPick items
  // (Interview.ts's askLanguage) rather than asked for in the model's own text — a
  // wall of text in an input box's prompt field was the exact UX complaint this
  // format change fixes, and code can only build a menu from something parseable.
  const prompt = interviewQuestionPrompt('language', state);
  assert.match(prompt, /Name \| advantage \| cost/);
});

test('the model is told not to ask a scoping question first', () => {
  // The exact failure observed live: platform/OS was asked about before any language
  // was proposed.
  const prompt = interviewQuestionPrompt('language', state);
  assert.match(prompt, /do not ask a preliminary question/i);
});

test('every other topic still gets the plain one-question template', () => {
  const prompt = interviewQuestionPrompt('scope', state);
  assert.match(prompt, /Ask ONE question/);
});

// ------------------------------------------------- F1, naming a delegated choice

test('a remark that only alludes to the choice gets the choice stated first', () => {
  // The verbatim line from 19 Aug. It was JavaScript, and nothing on screen said so —
  // the user found out from the log, by which point the project was a browser page.
  const said = ensureNamesChoice(
    "You've chosen the language that will run anywhere and build nowhere, which is to say you've chosen to debug this in the browser.",
    'JavaScript'
  );
  assert.match(said, /^JavaScript it is\./);
  assert.match(said, /run anywhere and build nowhere/);
});

test('a remark that already names the choice is left exactly as written', () => {
  // The character does the talking wherever it can. This only adds words when the line
  // would otherwise leave the user guessing.
  const line = 'Python for a compliment script. A language most likely to outlive its own performance requirements.';
  assert.equal(ensureNamesChoice(line, 'Python'), line);
});

test('naming is case-insensitive', () => {
  const line = 'python it is, then, with all that implies.';
  assert.equal(ensureNamesChoice(line, 'Python'), line);
});

test('a language whose name ends in punctuation is still recognised', () => {
  // `\bC\+\+\b` never matches — the trailing boundary has no word character to sit
  // against — so a naive check would announce "C++ it is" on top of a line that already
  // said C++.
  for (const [line, choice] of [
    ['C++ it is, and the segfaults with it.', 'C++'],
    ['F# on the CLR, which is a choice.', 'F#'],
    ['C# then. Enterprise beckons.', 'C#'],
  ] as const) {
    assert.equal(ensureNamesChoice(line, choice), line, choice);
  }
});

test('a name that appears only inside another word does not count as naming it', () => {
  const said = ensureNamesChoice('The gorgeous option, obviously.', 'Go');
  assert.match(said, /^Go it is\./);
});

test('an empty remark still states the choice', () => {
  assert.equal(ensureNamesChoice('', 'Rust'), 'Rust it is.');
});

test('no choice to name leaves the line untouched', () => {
  assert.equal(ensureNamesChoice('Some line.', '   '), 'Some line.');
});

test('a reply ending in a question mark is a question asked back, not an answer', () => {
  assert.equal(looksLikeQuestionBack('recommendations on that one?'), true);
  assert.equal(looksLikeQuestionBack("what's the simplest solution?"), true);
});

test('a question mark mid-sentence does not make the whole reply a question', () => {
  assert.equal(looksLikeQuestionBack('is 30 lines ok? either way is fine'), false);
});

test('an ordinary answer is not mistaken for a question', () => {
  assert.equal(looksLikeQuestionBack('Python, run from the CLI'), false);
});

test('answerBackPrompt includes the question and forbids asking one back', () => {
  const prompt = answerBackPrompt('data', 'recommendations on that one?', state);
  assert.match(prompt, /recommendations on that one\?/);
  assert.match(prompt, /do not ask/i);
});
