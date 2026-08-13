import test from 'node:test';
import assert from 'node:assert/strict';
import { milestonePrompt, parseMilestoneSteps } from './milestonePrompt';
import { InterviewState } from './interviewTopics';

const state: InterviewState = {
  answers: [
    { topic: 'what-it-does', text: 'renames files from the command line' },
    { topic: 'language', text: 'Python' },
  ],
};

test('the prompt asks for work, not decisions', () => {
  const prompt = milestonePrompt(state);
  assert.match(prompt, /3 to 6/);
  assert.match(prompt, /actually do and then check off/);
  assert.match(prompt, /belongs in\s*the open questions, not here/);
});

test('the prompt carries what was established', () => {
  assert.match(milestonePrompt(state), /renames files from the command line/);
});

test('the prompt refuses to invent scope that was never asked for', () => {
  assert.match(milestonePrompt(state), /no tests, no packaging, no CI unless they/);
});

test('steps parse one per line', () => {
  const steps = parseMilestoneSteps('Create the entry point\nParse the arguments\nRename the file');
  assert.deepEqual(steps, ['Create the entry point', 'Parse the arguments', 'Rename the file']);
});

test('numbering and bullets the model added anyway are stripped', () => {
  assert.deepEqual(parseMilestoneSteps('1. First thing\n2) Second thing\n- Third thing'), [
    'First thing',
    'Second thing',
    'Third thing',
  ]);
});

test('blank lines are dropped, not kept as empty steps', () => {
  assert.deepEqual(parseMilestoneSteps('One\n\n\nTwo\n'), ['One', 'Two']);
});

test('an overlong list is capped rather than passed through', () => {
  const many = Array.from({ length: 12 }, (_, index) => `Step ${index}`).join('\n');
  assert.equal(parseMilestoneSteps(many).length, 6);
});

test('nothing usable is an empty list, not a fabricated step', () => {
  assert.deepEqual(parseMilestoneSteps('   \n  '), []);
});
