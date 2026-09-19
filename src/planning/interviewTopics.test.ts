import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTED_QUESTION, fillDefaults, InterviewState, knownFacts, nextTopic, openQuestions, readyToDraft } from './interviewTopics';

const empty: InterviewState = { answers: [] };

test('a fresh interview starts with what it does', () => {
  assert.equal(nextTopic(empty), 'what-it-does');
});

test('the core topics come before language or the linter', () => {
  const state: InterviewState = { answers: [{ topic: 'what-it-does', text: 'renames photos' }] };
  assert.equal(nextTopic(state), 'who-and-where');
});

test('language becomes askable once who-and-where is settled, before scope or data', () => {
  // §4.9: language sits *between* the core topics once there is enough shape for a
  // shortlist, not tacked on at the end after everything else.
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: 'renames photos' },
      { topic: 'who-and-where', text: 'CLI, runs locally' },
    ],
  };
  assert.equal(nextTopic(state), 'language');
});

test('a detected language is never asked about', () => {
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: 'renames photos' },
      { topic: 'who-and-where', text: 'CLI, runs locally' },
    ],
    languageDetected: 'Python',
  };
  assert.equal(nextTopic(state), 'scope');
});

test('comment style is asked in the same final round as the linter', () => {
  // Both are questions about how the code gets written rather than what it does, and
  // asking either before the project has a shape reads as a style opinion about
  // something that does not exist yet.
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: 'renames photos' },
      { topic: 'who-and-where', text: 'CLI, runs locally' },
      { topic: 'language', text: 'Python' },
      { topic: 'scope', text: 'no GUI' },
      { topic: 'data', text: 'reads EXIF, writes nothing' },
      { topic: 'definition-of-done', text: 'renames a folder correctly' },
      { topic: 'linter', text: 'yes' },
    ],
  };
  assert.equal(nextTopic(state), 'comment-style');
});

test('a plan is not draftable until the comment question has been asked', () => {
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: 'a thing' },
      { topic: 'who-and-where', text: 'somewhere' },
      { topic: 'scope', text: 'not much' },
      { topic: 'linter', text: 'yes' },
    ],
  };
  assert.equal(readyToDraft(state), false);
});

test('the linter is asked last, after everything else', () => {
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: 'renames photos' },
      { topic: 'who-and-where', text: 'CLI, runs locally' },
      { topic: 'language', text: 'Python' },
      { topic: 'scope', text: 'no GUI' },
      { topic: 'data', text: 'reads EXIF, writes nothing' },
      { topic: 'definition-of-done', text: 'renames a folder of photos correctly' },
    ],
  };
  assert.equal(nextTopic(state), 'linter');
});

test('"I don\'t know yet" settles a topic without answering it', () => {
  // A recorded unknown still counts as asked — it must not be asked again.
  const state: InterviewState = { answers: [{ topic: 'data', text: undefined }] };
  assert.notEqual(nextTopic(state), 'data');
});

test('nothing is ready to draft until the linter question has been asked', () => {
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: 'a thing' },
      { topic: 'who-and-where', text: 'somewhere' },
      { topic: 'scope', text: 'not much' },
    ],
  };
  assert.equal(readyToDraft(state), false);
});

test('draftable once the must-haves and the final-round questions are settled', () => {
  // Data and definition-of-done are not in the must-have list: a seed can be draftable
  // without them if the user never got that far, and they become open questions instead.
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: 'a thing' },
      { topic: 'who-and-where', text: 'somewhere' },
      { topic: 'scope', text: 'not much' },
      { topic: 'linter', text: 'yes' },
      { topic: 'comment-style', text: 'lean' },
    ],
  };
  assert.equal(readyToDraft(state), true);
});

test('open questions are the ones recorded as unknown, in order', () => {
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: 'a thing' },
      { topic: 'data', text: undefined },
      { topic: 'definition-of-done', text: undefined },
    ],
  };
  assert.deepEqual(
    openQuestions(state).map((a) => a.topic),
    ['data', 'definition-of-done']
  );
});

// ── "Draft it now" and the short way (19 September 2026) ─────────────────────

test('defaults fill only what nobody answered, each marked as a default, and the draft can start', () => {
  const state: InterviewState = {
    answers: [
      { topic: 'what-it-does', text: "a Python script that prints today's date" },
      { topic: 'scope', text: 'just the date, nothing else' },
    ],
  };

  const filled = fillDefaults(state, (text) => (/python/i.test(text) ? 'Python' : undefined));

  assert.deepEqual(filled, ['who-and-where', 'data', 'definition-of-done', 'language', 'linter', 'comment-style']);
  assert.equal(state.answers.find((a) => a.topic === 'scope')?.text, 'just the date, nothing else', 'an answer is kept');
  assert.equal(state.answers.find((a) => a.topic === 'scope')?.defaulted, undefined);
  for (const answer of state.answers.filter((a) => filled.includes(a.topic))) {
    assert.equal(answer.defaulted, true);
    assert.equal(answer.question, DEFAULTED_QUESTION);
  }
  assert.equal(state.answers.find((a) => a.topic === 'language')?.text, 'Python', 'a language already named is used');
  assert.equal(readyToDraft(state), true);
});

test('data stays an open question and the linter is not a recorded No', () => {
  const state: InterviewState = { answers: [{ topic: 'what-it-does', text: 'a tiny tool' }] };
  fillDefaults(state, () => undefined);

  assert.equal(state.answers.find((a) => a.topic === 'data')?.text, undefined, 'data drives the safety review');
  assert.ok(openQuestions(state).some((a) => a.topic === 'data'));
  assert.equal(state.answers.find((a) => a.topic === 'language')?.text, undefined, 'no language guessed');
  assert.doesNotMatch(state.answers.find((a) => a.topic === 'linter')?.text ?? '', /^no\b/i);
});

test('later prompts are told a default is a default', () => {
  const state: InterviewState = { answers: [{ topic: 'what-it-does', text: 'a tiny tool' }] };
  fillDefaults(state, () => undefined);
  assert.match(knownFacts(state), /who-and-where: .+ \(a default, not asked\)/);
  assert.doesNotMatch(knownFacts(state), /what-it-does: a tiny tool \(a default/);
});
