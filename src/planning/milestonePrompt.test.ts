import test from 'node:test';
import assert from 'node:assert/strict';
import { milestonePrompt, milestonesFrom, parseMilestones, parseMilestoneSteps } from './milestonePrompt';
import { InterviewState } from './interviewTopics';

const state: InterviewState = {
  answers: [
    { topic: 'what-it-does', text: 'renames files from the command line' },
    { topic: 'language', text: 'Python' },
  ],
};

test('the prompt asks for work, not decisions', () => {
  const prompt = milestonePrompt(state);
  assert.match(prompt, /2 to 6/);
  assert.match(prompt, /actually do and then check off/);
  assert.match(prompt, /belongs in\s*the open questions, not here/);
});

test('the prompt carries what was established', () => {
  assert.match(milestonePrompt(state), /renames files from the command line/);
});

test('the prompt refuses to invent scope that was never asked for', () => {
  assert.match(milestonePrompt(state), /no packaging or CI unless they were asked for/);
});

test('every step is asked to carry the check that proves it works', () => {
  // A checklist you can only tick by believing yourself is not a checklist. The check
  // is written now, with the step — after the code exists it becomes a description of
  // whatever got built rather than a test of what was meant.
  const prompt = milestonePrompt(state);
  assert.match(prompt, /the check that proves it works/);
  assert.match(prompt, /Not "verify it works"/);
  assert.match(prompt, /The step \| the check that proves it works/);
});

test('accepted findings are offered for folding, work only', () => {
  // Both halves matter. Folding all of them in is what emptied milestone one — a
  // clarification is not a build step. Dropping all of them loses the fixes the user
  // just agreed to. Only the model reading both can tell which is which.
  const prompt = milestonePrompt(state, [
    {
      finding: { class: 'safety', what: 'no dry run', whyItMatters: 'x', fixes: ['add a --dry-run flag'] },
      status: 'accepted',
    },
  ]);

  assert.match(prompt, /- add a --dry-run flag/);
  assert.match(prompt, /Fold the ones that describe actual work/);
  assert.match(prompt, /Leave out the ones that only ask a question/);
});

test('a modified finding is offered in the user\'s own words', () => {
  const prompt = milestonePrompt(state, [
    {
      finding: { class: 'improvement', what: 'no linter', whyItMatters: 'x', fixes: ['name a linter'] },
      status: 'modified',
      reasoning: 'set up ruff',
    },
  ]);

  assert.match(prompt, /- set up ruff/);
  assert.doesNotMatch(prompt, /name a linter/);
});

test('no findings means no folding instructions cluttering the prompt', () => {
  assert.doesNotMatch(milestonePrompt(state), /Fold the ones/);
});

test('steps parse one per line, with their checks', () => {
  const steps = parseMilestoneSteps('Create the entry point | run it with --help\nRename the file | the file is renamed');
  assert.deepEqual(steps, [
    { step: 'Create the entry point', check: 'run it with --help' },
    { step: 'Rename the file', check: 'the file is renamed' },
  ]);
});

test('a step with no check is kept rather than dropped', () => {
  // Worth less than one with a check, worth far more than nothing.
  assert.deepEqual(parseMilestoneSteps('Create the entry point'), [{ step: 'Create the entry point' }]);
});

test('a check containing a pipe survives intact', () => {
  const steps = parseMilestoneSteps('Build it | run `ls | wc -l` and see 3');
  assert.deepEqual(steps, [{ step: 'Build it', check: 'run `ls | wc -l` and see 3' }]);
});

test('numbering and bullets the model added anyway are stripped', () => {
  assert.deepEqual(parseMilestoneSteps('1. First thing\n2) Second thing\n- Third thing'), [
    { step: 'First thing' },
    { step: 'Second thing' },
    { step: 'Third thing' },
  ]);
});

test('blank lines are dropped, not kept as empty steps', () => {
  assert.deepEqual(parseMilestoneSteps('One\n\n\nTwo\n'), [{ step: 'One' }, { step: 'Two' }]);
});

test('an overlong list is capped rather than passed through', () => {
  const many = Array.from({ length: 12 }, (_, index) => `Step ${index}`).join('\n');
  assert.equal(parseMilestoneSteps(many).length, 6);
});

test('nothing usable is an empty list, not a fabricated step', () => {
  assert.deepEqual(parseMilestoneSteps('   \n  '), []);
});

test('the prompt asks for milestones, first one the smallest thing that runs', () => {
  const prompt = milestonePrompt(state);
  assert.match(prompt, /up to 4 milestones/);
  assert.match(prompt, /smallest thing that runs end to end/);
  assert.match(prompt, /MILESTONE: what this one delivers/);
});

test('milestones parse with their titles and steps', () => {
  const milestones = parseMilestones(
    [
      'MILESTONE: A CLI that renames one file',
      'Create the entry point | run it with --help',
      'Rename a file | the file is renamed',
      'MILESTONE: Batch renaming',
      'Accept a folder | point it at a folder, all files renamed',
    ].join('\n')
  );

  assert.equal(milestones.length, 2);
  assert.equal(milestones[0].title, 'A CLI that renames one file');
  assert.deepEqual(milestones[0].steps, [
    { step: 'Create the entry point', check: 'run it with --help' },
    { step: 'Rename a file', check: 'the file is renamed' },
  ]);
  assert.equal(milestones[1].title, 'Batch renaming');
});

test('a flat list with no header is kept as one milestone', () => {
  // A model that ignores the header has still done the useful part. Throwing it away
  // to punish a formatting mistake would leave the plan empty — the exact failure
  // this section exists to prevent.
  const milestones = parseMilestones('Create the entry point | run it\nRename a file | it renames');

  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].steps.length, 2);
});

test('a milestone with no steps is dropped rather than rendered empty', () => {
  const milestones = parseMilestones('MILESTONE: Nothing here\nMILESTONE: Real one\nA step | a check');

  assert.equal(milestones.length, 1);
  assert.equal(milestones[0].title, 'Real one');
});

test('more milestones than the cap are ignored, not crammed in', () => {
  const many = Array.from({ length: 9 }, (_, index) => `MILESTONE: ${index}\nA step | a check`).join('\n');
  assert.equal(parseMilestones(many).length, 4);
});

// ------------------------- F5: a rejection is a decision, and it must reach here

/** The live case from 19 Aug, verbatim. */
const rejectedFileFormat = {
  finding: {
    class: 'scope' as const,
    what: 'The script needs to read and parse a compliments file, but no decision has been made about the file format.',
    whyItMatters: 'The plan says what data to load but not how it is stored.',
    fixes: ['Specify the file format (newline-delimited, JSON, CSV) before writing code.'],
  },
  status: 'rejected' as const,
  reasoning: 'no separate file, embed compliments in script',
};

test('a rejected finding reaches the planner instead of being filtered away', () => {
  // It used to be dropped before this prompt was built, so the planner worked from the
  // interview alone — whose data answer had said the compliments would live in a file.
  // Three seconds after "no separate file", step one was "Create a compliments data file".
  const prompt = milestonePrompt(state, [], [rejectedFileFormat]);

  assert.match(prompt, /turned them down/);
  assert.match(prompt, /no separate file, embed compliments in script/);
});

test('the planner is told not to build what was turned down', () => {
  const prompt = milestonePrompt(state, [], [rejectedFileFormat]);
  assert.match(prompt, /Do not plan any of these/);
});

test('a rejection reason outranks an earlier interview answer', () => {
  // The reason is usually not a reason at all but a decision, given later than the answer
  // it overrides. Without this the model has two contradictory statements and no rule for
  // choosing, and it picked the older one.
  const prompt = milestonePrompt(state, [], [rejectedFileFormat]);
  assert.match(prompt, /it was made\s*after everything above and wins over anything it contradicts/);
});

test('a rejection with no reason still says it was turned down', () => {
  const prompt = milestonePrompt(state, [], [{ ...rejectedFileFormat, reasoning: undefined }]);
  assert.match(prompt, /turned down, no reason given/);
});

test('no rejections adds nothing to the prompt', () => {
  // The block must not appear as an empty heading when every finding was accepted.
  const prompt = milestonePrompt(state, [], []);
  assert.doesNotMatch(prompt, /turned them down/);
  assert.doesNotMatch(prompt, /Do not plan any of these/);
});

// ------------------------- M9i: a refusal is not a milestone, and a short list says so

test('a refusal is not drawn as a milestone', () => {
  // The flat-list leniency above kept "Sorry, I cannot…" as the only step of a milestone called
  // v1 — and it was drawn into the plan and offered as a build.
  const planned = milestonesFrom('Sorry, I cannot produce milestones for this.', false);
  assert.deepEqual(planned.milestones, []);
  assert.match(planned.problem ?? '', /no step with a check/);
});

test('steps with checks are milestones, with nothing wrong', () => {
  const planned = milestonesFrom('MILESTONE: v1\nCreate the entry point | run it with --help', false);
  assert.equal(planned.milestones.length, 1);
  assert.equal(planned.problem, undefined);
});

test('a flat list is still usable when its steps carry checks', () => {
  assert.equal(milestonesFrom('Create the entry point | run it\nRename a file | it renames', false).problem, undefined);
});

test('a list in which no step carries a check has nothing that could be shown to work', () => {
  assert.deepEqual(milestonesFrom('MILESTONE: v1\nCreate the entry point\nRename a file', false).milestones, []);
});

test('nothing at all is said to be nothing', () => {
  assert.equal(milestonesFrom('', false).problem, 'the model sent back nothing');
});

test('a list cut short by the deadline is kept, and said to have run out of time', () => {
  const planned = milestonesFrom('MILESTONE: v1\nCreate the entry point | run it', true);
  assert.equal(planned.milestones.length, 1);
  assert.equal(planned.problem, 'the model ran out of time');
  assert.deepEqual(milestonesFrom('', true), { milestones: [], problem: 'the model ran out of time' });
});
