import test from 'node:test';
import assert from 'node:assert/strict';
import { addSteps, appendMilestone, markSteps, milestoneComplete, milestoneSteps, nextMilestone, readMilestones } from './planUpdate';

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

test('new steps join the milestone they belong to, at the end of its list', () => {
  // Where new work belongs among existing steps is a judgement about the project;
  // guessing would reorder a plan the user approved.
  const updated = addSteps(multi, 1, [{ step: 'Refuse to overwrite', check: 'run twice, second is refused' }]);

  assert.match(updated, /- \[x\] Rename a file\n- \[ \] Refuse to overwrite/);
  assert.match(updated, /- Check: run twice, second is refused/);
  assert.match(updated, /- Result: not run yet/);
  // The milestone after it is untouched.
  assert.match(updated, /### Milestone 2 — Batch renaming\n\n- \[ \] Accept a folder/);
});

test('adding to a milestone that is not there changes nothing', () => {
  assert.equal(addSteps(multi, 9, [{ step: 'Whatever' }]), multi);
});

test('adding nothing changes nothing', () => {
  assert.equal(addSteps(multi, 1, []), multi);
});

test('a new milestone lands at the end, numbered past the last', () => {
  // The numbering is what readMilestones reads back to decide what comes next, so a
  // duplicate would send the build to the wrong place.
  const updated = appendMilestone(multi, 'Email the results', [{ step: 'Send an email', check: 'check the inbox' }]);

  assert.match(updated, /### Milestone 3 — Email the results/);
  assert.equal(readMilestones(updated).length, 3);
  assert.equal(nextMilestone(updated)?.number, 2, 'the unfinished one is still next');
});

test('a new milestone goes above the sections that end the plan', () => {
  // Decisions, Open Questions and Branch flow live at the bottom; a milestone
  // appended after them would read as an afterthought to a different document.
  const withTail = `${multi}\n\n## 8. Decisions\n_None rejected._\n\n## Branch flow\n- trunk: main`;
  const updated = appendMilestone(withTail, 'Email the results', [{ step: 'Send an email' }]);

  assert.ok(updated.indexOf('### Milestone 3') < updated.indexOf('## 8. Decisions'));
});

test('a plan with a finished milestone counts as started, even if the next is untouched', () => {
  // Found live: milestones 1–3 done, 4 untouched, and reopening the window offered
  // nothing. Finishing a milestone is the most likely moment to close a window, and it
  // was the one moment "is this in progress" could not see.
  const plan = [
    '# Forecast',
    '',
    '### Milestone 1 — Fetch weather',
    '- [x] Call the API',
    '- [x] Print it',
    '',
    '### Milestone 2 — Cache it',
    '- [ ] Write the cache',
    '- [ ] Read it back',
  ].join('\n');

  const milestones = readMilestones(plan);

  assert.equal(milestones.some((entry) => entry.done > 0), true);
  // The milestone offered is the next one, and it has no progress of its own.
  assert.equal(nextMilestone(plan)?.number, 2);
  assert.equal(nextMilestone(plan)?.done, 0);
});

test('a plan with nothing ticked anywhere is not work in progress', () => {
  // Offering to continue a freshly approved plan every time the window opens is the
  // nagging §6 exists to prevent.
  const plan = ['# Forecast', '', '### Milestone 1 — Fetch weather', '- [ ] Call the API'].join('\n');

  assert.equal(readMilestones(plan).some((entry) => entry.done > 0), false);
});
