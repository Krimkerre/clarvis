import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMilestoneTask } from './nextMilestoneTask';

const milestone = { number: 2, title: 'Batch renaming', done: 0, total: 3 };

test('the task points at the plan rather than restating it', () => {
  // By milestone two the interview may have happened last week in another window.
  // The plan is what survived, and it is also the only version that stays true when
  // the user edits it by hand between milestones.
  const task = nextMilestoneTask(milestone, 'Snapshot');

  assert.match(task, /Read plan\.md first/);
  assert.match(task, /Milestone 2 — Batch renaming/);
  assert.match(task, /only the unticked steps/);
});

test('it still asks for step announcements, so progress keeps working', () => {
  assert.match(nextMilestoneTask(milestone, 'Snapshot'), /STEP: <the step, copied from the plan>/);
});

test('it stops at the milestone it was given', () => {
  assert.match(nextMilestoneTask(milestone, 'Snapshot'), /Build milestone 2 and no further/);
});
