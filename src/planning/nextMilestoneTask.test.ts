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
  assert.match(nextMilestoneTask(milestone, 'Snapshot'), /finish in seconds/);
});

test('the task says which milestone this is out of how many', () => {
  // Found live: "That's Milestone 4 finished — Milestone 5, if there is one, is a
  // separate conversation." There were four, and the plan he had just read said so.
  const all = [
    { number: 1, title: 'Fetch', done: 2, total: 2 },
    { number: 2, title: 'Cache', done: 0, total: 3 },
    { number: 3, title: 'Forecast', done: 0, total: 2 },
  ];

  assert.match(nextMilestoneTask(all[1], 'Forecast', all), /Milestone 2 of 3/);
});

test('later milestones are named so the code can accommodate them', () => {
  // A cache written with no idea a week forecast is coming is how a build paints
  // itself into a corner one milestone at a time.
  const all = [
    { number: 1, title: 'Fetch', done: 2, total: 2 },
    { number: 2, title: 'Cache', done: 0, total: 3 },
    { number: 3, title: 'Week forecast', done: 0, total: 2 },
  ];
  const task = nextMilestoneTask(all[1], 'Forecast', all);

  assert.match(task, /Milestone 3 — Week forecast/);
  assert.match(task, /Do not build any of that now/);
});

test('the last milestone is told it is the last one', () => {
  const all = [
    { number: 1, title: 'Fetch', done: 2, total: 2 },
    { number: 2, title: 'Polish', done: 0, total: 1 },
  ];
  const task = nextMilestoneTask(all[1], 'Forecast', all);

  assert.match(task, /last milestone in the plan/);
  assert.match(task, /There is not\./);
  // And it must not also tell him to stop before a milestone that does not exist.
  assert.doesNotMatch(task, /the next one is a\s*separate decision/);
});

test('a task with no milestone list still works, and claims no totals', () => {
  const task = nextMilestoneTask({ number: 2, title: 'Cache', done: 0, total: 3 }, 'Forecast');

  assert.match(task, /Milestone 2 — Cache/);
  assert.doesNotMatch(task, /of \d+ —/);
  assert.doesNotMatch(task, /last milestone/);
});
