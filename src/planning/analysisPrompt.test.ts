import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisPrompt, parseAnalysisResult } from './analysisPrompt';
import { InterviewState } from './interviewTopics';

const state: InterviewState = {
  answers: [
    { topic: 'what-it-does', text: 'stores user passwords for a login page' },
    { topic: 'who-and-where', text: 'a public website' },
    { topic: 'data', text: undefined },
  ],
};

test('the prompt names all four finding classes', () => {
  const prompt = analysisPrompt(state);
  assert.match(prompt, /safety/i);
  assert.match(prompt, /logic/i);
  assert.match(prompt, /scope/i);
  assert.match(prompt, /improvement/i);
});

test('the prompt requires the structured block format', () => {
  const prompt = analysisPrompt(state);
  assert.match(prompt, /class: safety\|logic\|scope\|improvement/);
  assert.match(prompt, /what: /);
  assert.match(prompt, /why: /);
  assert.match(prompt, /fix: /);
});

test('the prompt allows the no-plan-needed outcome', () => {
  assert.match(analysisPrompt(state), /NO-PLAN-NEEDED/);
});

test('parses a well-formed multi-finding response', () => {
  const text = [
    'class: safety',
    'what: passwords are stored in plaintext',
    'why: a leak exposes every user\'s real password',
    'fix: hash and salt before storing',
    '',
    'class: scope',
    'what: "login page" implies accounts, sessions and recovery',
    'why: none of that was described',
    'fix: confirm which of those v1 actually needs',
  ].join('\n');

  const result = parseAnalysisResult(text);
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings[0].class, 'safety');
  assert.equal(result.findings[1].class, 'scope');
  assert.equal(result.noPlanNeeded, undefined);
});

test('recognises NO-PLAN-NEEDED and returns no findings', () => {
  const result = parseAnalysisResult('NO-PLAN-NEEDED: this is a 30-line throwaway script');
  assert.equal(result.findings.length, 0);
  assert.equal(result.noPlanNeeded, 'this is a 30-line throwaway script');
});

test('drops a block missing a required field instead of throwing', () => {
  const text = ['class: logic', 'what: two answers disagree', 'fix: pick one'].join('\n');
  const result = parseAnalysisResult(text);
  assert.equal(result.findings.length, 0);
});

test('drops a block with an invalid class', () => {
  const text = ['class: style', 'what: x', 'why: y', 'fix: z'].join('\n');
  const result = parseAnalysisResult(text);
  assert.equal(result.findings.length, 0);
});

test('empty text is zero findings, not an error', () => {
  const result = parseAnalysisResult('');
  assert.equal(result.findings.length, 0);
  assert.equal(result.noPlanNeeded, undefined);
});
