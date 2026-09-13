import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisPrompt, parseAnalysisResult, readAnalysis } from './analysisPrompt';
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

test('every fix line is kept, in the order they were offered', () => {
  // A single-value field map kept only the last one, which silently dropped the
  // obvious fix and left the afterthought as the finding's answer.
  const text = [
    'class: safety',
    'what: passwords are stored in plaintext',
    'why: a leak exposes every real password',
    'fix: hash and salt before storing',
    'fix: drop accounts from v1 entirely',
  ].join('\n');

  const [finding] = parseAnalysisResult(text).findings;
  assert.deepEqual(finding.fixes, ['hash and salt before storing', 'drop accounts from v1 entirely']);
});

test('the prompt asks for alternatives that are actually different', () => {
  // Two rewordings of one answer is a false choice, and a menu of those is worse
  // than a single suggestion — it looks like a decision was offered.
  assert.match(analysisPrompt(state), /real alternative rather than the first one reworded/);
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

test('empty text parses as no findings — whether the review finished is readAnalysis\'s call', () => {
  const result = parseAnalysisResult('');
  assert.equal(result.findings.length, 0);
  assert.equal(result.noPlanNeeded, undefined);
});

// ------------------------- M9i: a review that did not finish is not a clean one

test('the prompt asks for NO-FINDINGS rather than silence', () => {
  const prompt = analysisPrompt(state);
  assert.match(prompt, /^NO-FINDINGS$/m);
  assert.doesNotMatch(prompt, /output nothing/);
});

test('NO-FINDINGS is a finished review with nothing to raise', () => {
  assert.deepEqual(readAnalysis('NO-FINDINGS', false), { findings: [] });
});

test('an empty reply is not a finished review', () => {
  assert.equal(readAnalysis('', false).problem, 'the model sent back nothing');
});

test('prose instead of findings is not a finished review', () => {
  assert.equal(
    readAnalysis('I reviewed the interview and it all looks reasonable.', false).problem,
    'the reply was not in the review format'
  );
});

test('findings, or NO-PLAN-NEEDED, are a finished review', () => {
  const finding = ['class: safety', 'what: x', 'why: y', 'fix: z'].join('\n');
  assert.equal(readAnalysis(finding, false).problem, undefined);
  assert.equal(readAnalysis('NO-PLAN-NEEDED: a thirty-line script', false).problem, undefined);
});

test('a review cut short by the deadline keeps what it found, and says it did not finish', () => {
  const result = readAnalysis(['class: safety', 'what: x', 'why: y', 'fix: z'].join('\n'), true);
  assert.equal(result.findings.length, 1);
  assert.equal(result.problem, 'the model ran out of time');
});
