import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStepResults, recordMilestonePrompt } from './milestoneReport';

test('the prompt carries the plan and the run report, and forbids inventing outcomes', () => {
  const prompt = recordMilestonePrompt('- [ ] Create the entry point', 'Wrote main.py, ran it, saw usage text');

  assert.match(prompt, /Create the entry point/);
  assert.match(prompt, /Wrote main\.py/);
  assert.match(prompt, /Do not invent an\s*outcome for a check that was never run/);
  // A step nobody mentioned is not done — silence is not completion.
  assert.match(prompt, /a step nobody mentioned is not done/);
});

test('results parse into steps, states and outcomes', () => {
  const results = parseStepResults(
    'Create the entry point | done | prints usage, exit 0\nRead EXIF dates | not done | -'
  );

  assert.deepEqual(results, [
    { step: 'Create the entry point', done: true, result: 'prints usage, exit 0' },
    { step: 'Read EXIF dates', done: false, result: undefined },
  ]);
});

test('a failed check is not done, with the failure kept as the result', () => {
  const [result] = parseStepResults('Read EXIF dates | not done | ModuleNotFoundError: exifread');

  assert.equal(result.done, false);
  assert.equal(result.result, 'ModuleNotFoundError: exifread');
});

test('a result containing a pipe survives intact', () => {
  const [result] = parseStepResults('Build it | done | ran `ls | wc -l`, saw 3');
  assert.equal(result.result, 'ran `ls | wc -l`, saw 3');
});

test('malformed lines are dropped rather than guessed at', () => {
  assert.deepEqual(parseStepResults('some prose with no pipes at all'), []);
  assert.deepEqual(parseStepResults(''), []);
});
