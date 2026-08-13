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
