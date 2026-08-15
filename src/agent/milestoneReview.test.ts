import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTHING_TO_REPORT, reviewPrompt, reviewSummary } from './milestoneReview';
import { parseAnalysisResult } from '../planning/analysisPrompt';

const subject = {
  milestone: 'Fetch and display current weather',
  steps: [
    {
      step: 'Call the API and parse the response',
      check: 'The tool prints temperature, chance of rain, windspeed and direction',
      result: 'printed 27.3°C, 0%, 5.9 km/h from 166°',
    },
  ],
  diff: '+ func chanceOfRainNow() int { return 0 }',
  language: 'Go',
};

test('the prompt asks what would still pass the check', () => {
  // The question that would have caught it: five checks passed over a hard-coded 0
  // because every one of them asked whether output appeared.
  const prompt = reviewPrompt(subject);

  assert.match(prompt, /what broken code\s+would still pass it/);
  assert.match(prompt, /satisfied by output appearing is satisfied by a\s+constant/);
});

test('the prompt carries the steps, their checks and what was claimed', () => {
  const prompt = reviewPrompt(subject);

  assert.match(prompt, /Call the API and parse the response/);
  assert.match(prompt, /Check: The tool prints temperature/);
  assert.match(prompt, /You reported: printed 27\.3/);
});

test('a step with no check is shown as having none, not omitted', () => {
  // A missing check is itself a finding, and hiding it would make the review agree
  // with the plan rather than read it.
  assert.match(reviewPrompt({ ...subject, steps: [{ step: 'Do a thing' }] }), /Check: \(none was written\)/);
});

test('a clean read is a legitimate outcome with a way to say it', () => {
  assert.match(reviewPrompt(subject), new RegExp(NOTHING_TO_REPORT));
  assert.match(reviewPrompt(subject), /padding\s*\n?\s*it with something plausible/);
});

test('findings come back in the same shape the plan analysis uses', () => {
  // The whole reason for the shared shape: the buttons, the parser and the plan
  // writer already understand it.
  const { findings } = parseAnalysisResult(
    [
      'class: logic',
      'what: chanceOfRainNow never matches, so rain is always 0%',
      'why: the tool reports no rain on a rainy day',
      'fix: match on the hour rather than the exact timestamp',
      'fix: read the probability from the daily array instead',
    ].join('\n')
  );

  assert.equal(findings.length, 1);
  assert.equal(findings[0].class, 'logic');
  assert.equal(findings[0].fixes.length, 2);
});

test('the summary counts the ones that are wrong rather than untidy', () => {
  const findings = parseAnalysisResult(
    [
      'class: logic',
      'what: rain is always 0%',
      'why: wrong output',
      'fix: match on the hour',
      '',
      'class: improvement',
      'what: the error cause is discarded',
      'why: harder to diagnose',
      'fix: wrap the original error',
    ].join('\n')
  ).findings;

  assert.match(reviewSummary(findings), /2 things worth raising, 1 of them wrong rather than untidy/);
});

test('nothing found is said, not left as silence', () => {
  // Silence is how a crash looks. A clean read has to be reported as a clean read.
  assert.match(reviewSummary([]), /found nothing worth raising/);
});
