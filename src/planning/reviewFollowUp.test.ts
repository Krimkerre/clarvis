import test from 'node:test';
import assert from 'node:assert/strict';
import { findingSteps, fixFindingsTask } from './reviewFollowUp';
import { parseAnalysisResult } from './analysisPrompt';

// The real findings the read-back returned against project 2's own diff, trimmed.
const findings = parseAnalysisResult(
  [
    'class: logic',
    'what: chanceOfRainNow returns 0 whenever Current.Time has no exact match in Hourly.Time',
    'why: any mismatch is silently reported as "Chance of rain: 0%"',
    'fix: return an error when no match is found instead of defaulting to 0',
    'fix: derive rain chance from Daily.PrecipitationProbabilityMax[0]',
  ].join('\n')
).findings;

test('a finding becomes a step that is the fix, not the defect', () => {
  // The plan holds work. "Chance of rain is always 0" is not something you can do.
  assert.equal(findingSteps(findings)[0].step, 'return an error when no match is found instead of defaulting to 0');
});

test('the step it becomes carries a check that can fail', () => {
  // Findings exist because a check that could not fail let them through; writing them
  // back with the same kind of check would be the joke telling itself twice.
  const check = findingSteps(findings)[0].check ?? '';

  assert.match(check, /no longer true/);
  assert.match(check, /output would differ/);
});

test('the fix-now task carries the defect, not just the instruction', () => {
  // "Fix the findings" loses the half that matters, and a fix written without it is a
  // rewrite of whatever the model remembers writing.
  const task = fixFindingsTask(findings);

  assert.match(task, /Chance of rain: 0%/);
  assert.match(task, /Why it matters:/);
  assert.match(task, /would have been\s*\n?different before the fix/);
});

test('the fix-now task refuses to be a tidy-up', () => {
  assert.match(fixFindingsTask(findings), /Nothing else — no new/);
});
