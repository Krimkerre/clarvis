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

test('the build list is the steps; findings are named as questions', () => {
  // Found live: handing over a list of "Clarify whether…" items produced a run that
  // read the plan, found nothing it could do, and stopped.
  const task = handoffTask(state, 'renames photos', verdicts, [
    { step: 'Create the entry point', check: 'run `photoname --help`' },
  ]);
  assert.match(task, /Milestone 1 — build these[^]*- Create the entry point/);
  // The check travels with the step, and running it is part of the job.
  assert.match(task, /Check: run `photoname --help`/);
  assert.match(task, /report what actually happened/);
  assert.match(task, /Agreed during review[^]*- add a --dry-run flag/);
  assert.doesNotMatch(task, /support all formats/);
});

test('a modified finding is settled in the user\'s own wording', () => {
  const modified: FindingVerdict = {
    finding: { class: 'improvement', what: 'no linter named', whyItMatters: 'x', suggestedResolution: 'name a linter' },
    status: 'modified',
    reasoning: 'use ruff',
  };
  const task = handoffTask(state, 'renames photos', [modified], [{ step: 'Create the entry point' }]);
  assert.match(task, /- use ruff/);
  assert.doesNotMatch(task, /name a linter/);
});

test('it refuses to build past milestone one', () => {
  assert.match(handoffTask(state, 'renames photos', []), /Do not build past milestone 1/);
});

test('no steps says so rather than pretending the milestone is empty on purpose', () => {
  const bare: InterviewState = { answers: [{ topic: 'what-it-does', text: 'a thing' }] };
  assert.match(handoffTask(bare, 'a thing', []), /no build steps were written/);
});
