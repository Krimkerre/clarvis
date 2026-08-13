import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffTask } from './handoff';
import { InterviewState } from './interviewTopics';
import { FindingVerdict } from './verdictSummary';

const state: InterviewState = {
  projectName: 'Snapshot',
  answers: [
    { topic: 'what-it-does', text: 'renames photos by EXIF date' },
    { topic: 'who-and-where', text: 'CLI, local machine' },
    { topic: 'language', text: 'Python' },
    { topic: 'definition-of-done', text: 'renames a folder correctly' },
  ],
};

const verdicts: FindingVerdict[] = [
  {
    finding: { class: 'safety', what: 'no dry-run', whyItMatters: 'renames are hard to undo', suggestedResolution: 'add a --dry-run flag' },
    status: 'accepted',
  },
  {
    finding: { class: 'scope', what: 'JPEG only', whyItMatters: 'other formats have EXIF', suggestedResolution: 'support all formats' },
    status: 'rejected',
    reasoning: 'fine for v1',
  },
];

test('the task names the project and what was established', () => {
  const task = handoffTask(state, 'renames photos', verdicts);
  assert.match(task, /Snapshot/);
  assert.match(task, /Language: Python/);
  assert.match(task, /renames photos by EXIF date/);
});

test('accepted findings become checklist items, rejected ones do not', () => {
  const task = handoffTask(state, 'renames photos', verdicts);
  assert.match(task, /- add a --dry-run flag/);
  assert.doesNotMatch(task, /support all formats/);
});

test('a modified finding contributes the user\'s own wording', () => {
  const modified: FindingVerdict = {
    finding: { class: 'improvement', what: 'no linter named', whyItMatters: 'x', suggestedResolution: 'name a linter' },
    status: 'modified',
    reasoning: 'use ruff',
  };
  const task = handoffTask(state, 'renames photos', [modified]);
  assert.match(task, /- use ruff/);
  assert.doesNotMatch(task, /name a linter/);
});

test('it refuses to build past milestone one', () => {
  assert.match(handoffTask(state, 'renames photos', []), /Do not build past milestone 1/);
});

test('an empty checklist says so rather than inventing work', () => {
  const bare: InterviewState = { answers: [{ topic: 'what-it-does', text: 'a thing' }] };
  assert.match(handoffTask(bare, 'a thing', []), /no checklist items were agreed/);
});
