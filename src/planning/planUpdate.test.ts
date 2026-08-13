import test from 'node:test';
import assert from 'node:assert/strict';
import { markSteps, milestoneComplete, milestoneSteps, nextMilestone, readMilestones } from './planUpdate';

const plan = [
  '## 7. Milestone 1 — v1',
  '',
  '**Build:**',
  '- [ ] Create the CLI entry point',
  '  - Check: run `photoname --help`, see the usage text',
  '  - Result: not run yet',
  '- [ ] Read EXIF dates',
  '  - Check: run it on a photo, see the date printed',
  '  - Result: not run yet',
  '',
  '## 8. Decisions',
  '- something the user wrote themselves',
].join('\n');

test('a finished step is ticked and its result recorded in place', () => {
  const updated = markSteps(plan, [
    { step: 'Create the CLI entry point', done: true, result: 'prints usage, exit 0' },
  ]);

  assert.match(updated, /- \[x\] Create the CLI entry point/);
  assert.match(updated, /- Result: prints usage, exit 0/);
  // Replaced, not appended: "not run yet" must not survive under its own answer.
  assert.doesNotMatch(updated, /- \[x\] Create the CLI entry point\n[^]*?not run yet\n[^]*?Read EXIF/);
});

test('steps not mentioned are left exactly as they were', () => {
  const updated = markSteps(plan, [{ step: 'Create the CLI entry point', done: true }]);

  assert.match(updated, /- \[ \] Read EXIF dates/);
  assert.match(updated, /- something the user wrote themselves/);
});

test('a step that failed its check is recorded, not ticked', () => {
  // A failing check is a result. Ticking it anyway is how a plan starts lying.
  const updated = markSteps(plan, [
    { step: 'Read EXIF dates', done: false, result: 'ModuleNotFoundError: no module named exifread' },
  ]);

  assert.match(updated, /- \[ \] Read EXIF dates/);
  assert.match(updated, /- Result: ModuleNotFoundError/);
});

test('a step already ticked is never unticked', () => {
  // A second run reports on work finished by the first; unmarking it would be a lie.
  const done = plan.replace('- [ ] Create the CLI entry point', '- [x] Create the CLI entry point');
  const updated = markSteps(done, [{ step: 'Create the CLI entry point', done: false }]);

  assert.match(updated, /- \[x\] Create the CLI entry point/);
});

test('a reworded step still matches, on punctuation and case alone', () => {
  const updated = markSteps(plan, [{ step: 'create the CLI entry point.', done: true }]);
  assert.match(updated, /- \[x\] Create the CLI entry point/);
});

test('a genuinely different step is not ticked by accident', () => {
  // Ticking a neighbouring step is worse than ticking none at all.
  const updated = markSteps(plan, [{ step: 'Create the config file', done: true }]);
  assert.match(updated, /- \[ \] Create the CLI entry point/);
});

test('a milestone is complete only when every step is ticked', () => {
  assert.equal(milestoneComplete(plan), false);
  assert.equal(
    milestoneComplete(plan.replace(/- \[ \]/g, '- [x]')),
    true
  );
});

test('a plan with no steps at all is not "complete"', () => {
  assert.equal(milestoneComplete('# A plan\n\nNothing here yet.'), false);
});

const multi = [
  '## 7. Milestones',
  '',
  '### Milestone 1 — A CLI that renames one file',
  '',
  '- [x] Create the entry point',
  '- [x] Rename a file',
  '',
  '### Milestone 2 — Batch renaming',
  '',
  '- [ ] Accept a folder',
  '- [ ] Rename every file in it',
].join('\n');

test('each milestone reports its own progress', () => {
  assert.deepEqual(readMilestones(multi), [
    { number: 1, title: 'A CLI that renames one file', done: 2, total: 2 },
    { number: 2, title: 'Batch renaming', done: 0, total: 2 },
  ]);
});

test('the next milestone is the first with work left in it', () => {
  // Read back out of the file rather than held in memory: a build resumed next week
  // in a new window has nothing else to consult.
  assert.equal(nextMilestone(multi)?.number, 2);
});

test('a plan finished to the end has no next milestone', () => {
  assert.equal(nextMilestone(multi.replace(/- \[ \]/g, '- [x]')), undefined);
});

test('a milestone half done is still the next one, not skipped', () => {
  const half = multi.replace('- [ ] Accept a folder', '- [x] Accept a folder');
  assert.equal(nextMilestone(half)?.number, 2);
});

test('steps outside any milestone heading are not counted against one', () => {
  // The Agreed-during-review list is bullets too; miscounting those as steps would
  // make a finished milestone look unfinished forever.
  assert.deepEqual(readMilestones('- [ ] a stray step\n### Milestone 1 — Real\n- [x] done'), [
    { number: 1, title: 'Real', done: 1, total: 1 },
  ]);
});

test('a milestone\'s steps are read back for the progress display', () => {
  assert.deepEqual(milestoneSteps(multi, 2), ['Accept a folder', 'Rename every file in it']);
});

test('every step is returned, ticked or not', () => {
  // "Step 3 of 5" means the third of five. Dropping finished ones would renumber the
  // list mid-build and march the bar backwards.
  assert.deepEqual(milestoneSteps(multi, 1), ['Create the entry point', 'Rename a file']);
});

test('a milestone that is not there has no steps', () => {
  assert.deepEqual(milestoneSteps(multi, 9), []);
});
