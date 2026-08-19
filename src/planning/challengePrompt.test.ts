import test from 'node:test';
import assert from 'node:assert/strict';
import { challengePrompt, parseChallengeResult } from './challengePrompt';
import { InterviewState } from './interviewTopics';

const state: InterviewState = {
  answers: [{ topic: 'what-it-does', text: 'a simulation with AI agents' }],
};

test('the prompt includes the answer and asks for FINE or one follow-up', () => {
  const prompt = challengePrompt('scope', 'it takes everything into account', state);
  assert.match(prompt, /it takes everything into account/);
  assert.match(prompt, /FINE/);
  assert.match(prompt, /ONE follow-up question/);
});

test('the bar is unusable, not imperfect (M9h part 4)', () => {
  // It used to ask whether the answer was "specific enough to plan against — no
  // meaningful ambiguity, no unstated assumption, no risk worth flagging". Almost no
  // short human answer clears that, so the honest reply was nearly always a follow-up:
  // five of seven topics on the 19 Aug walk.
  const prompt = challengePrompt('scope', 'repeats are fine', state);
  assert.match(prompt, /ONLY if it is unusable as it stands/);
  assert.match(prompt, /Anything you can reasonably act on is FINE/);
  assert.match(prompt, /When in doubt, FINE/);
});

test('the prompt forbids the three ways pushbacks actually went wrong', () => {
  // Each clause is one observed failure, not a general instruction to behave: asking for
  // precision a thirty-line script did not need, wandering onto another subject, and
  // re-asking a question one second after it was answered.
  const prompt = challengePrompt('comment-style', 'no comments needed', state);
  assert.match(prompt, /Do not ask for precision the work does not need/);
  assert.match(prompt, /subject this topic is not about/);
  assert.match(prompt, /never re-ask something already answered/);
});

test('parses FINE as no follow-up needed', () => {
  assert.deepEqual(parseChallengeResult('FINE'), { fine: true });
  assert.deepEqual(parseChallengeResult('fine.'), { fine: true });
});

test('parses a follow-up question', () => {
  const result = parseChallengeResult('What specifically does "everything" include?');
  assert.deepEqual(result, { fine: false, followUp: 'What specifically does "everything" include?' });
});

test('empty response is treated as fine rather than blocking', () => {
  assert.deepEqual(parseChallengeResult(''), { fine: true });
});

test('only the first line of a multi-line reply is used as the follow-up', () => {
  const result = parseChallengeResult('What counts as "everything"?\nSome extra rambling.');
  assert.deepEqual(result, { fine: false, followUp: 'What counts as "everything"?' });
});

// ------------------------------------- M9h part 4: the parser fails toward silence

test('an ordinary way of saying yes is not a pushback', () => {
  // The defect: only the exact string FINE counted, so every other phrasing of "yes"
  // became a question to ask. Each parse failure cost the user an interruption.
  for (const reply of [
    'FINE',
    'fine.',
    'Fine, that is specific enough to plan against.',
    'Fine — nothing ambiguous here.',
  ]) {
    assert.deepEqual(parseChallengeResult(reply), { fine: true }, reply);
  }
});

test('a reply that is not a question is not asked as one', () => {
  // A model that comments instead of answering used to have its commentary put to the
  // user as a follow-up question. Failing toward silence costs nothing: the answer stays
  // as the user wrote it, which is where it started.
  for (const reply of [
    'The answer seems reasonable given the project size.',
    'No follow-up needed.',
    'This contradicts nothing established so far.',
  ]) {
    assert.deepEqual(parseChallengeResult(reply), { fine: true }, reply);
  }
});

test('a real follow-up question still gets asked', () => {
  // The narrowing must not make the mechanism inert — an answer that genuinely cannot be
  // planned against should still earn its one question.
  assert.deepEqual(parseChallengeResult('What counts as "everything" here?'), {
    fine: false,
    followUp: 'What counts as "everything" here?',
  });
});
