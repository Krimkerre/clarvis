import test from 'node:test';
import assert from 'node:assert/strict';
import { interviewQuestionPrompt } from './interviewPrompt';
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
