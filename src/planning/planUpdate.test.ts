import test from 'node:test';
import assert from 'node:assert/strict';
import { markSteps, milestoneComplete } from './planUpdate';

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
