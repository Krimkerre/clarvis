import test from 'node:test';
import assert from 'node:assert/strict';
import { handoffTask, BUILD_OFFER_QUESTION, standaloneFacingLines } from './handoff';
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
    finding: { class: 'safety', what: 'no dry-run', whyItMatters: 'renames are hard to undo', fixes: ['add a --dry-run flag'] },
    status: 'accepted',
  },
  {
    finding: { class: 'scope', what: 'JPEG only', whyItMatters: 'other formats have EXIF', fixes: ['support all formats'] },
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

test('agreed findings travel as questions to settle, and turned-down ones stay out', () => {
  // Found live: handing over a list of "Clarify whether…" items produced a run that
  // read the plan, found nothing it could do, and stopped.
  const task = handoffTask(state, 'renames photos', verdicts);
  assert.match(task, /report what actually happened/);
  assert.match(task, /Agreed during review[^]*- add a --dry-run flag/);
  assert.doesNotMatch(task, /support all formats/);
});

test('a modified finding is settled in the user\'s own wording', () => {
  const modified: FindingVerdict = {
    finding: { class: 'improvement', what: 'no linter named', whyItMatters: 'x', fixes: ['name a linter'] },
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

test('no steps says so rather than pretending the milestone is empty on purpose', () => {
  const bare: InterviewState = { answers: [{ topic: 'what-it-does', text: 'a thing' }] };
  assert.match(handoffTask(bare, 'a thing', []), /no build steps were written/);
});

test('the task is the no-plan brief: it says there is no plan.md and never sends the agent to one', () => {
  // M9i: a planned build is handed its milestone from plan.md by `nextMilestoneTask`. This task
  // is only ever the brief for a build with no plan behind it.
  const task = handoffTask(state, 'renames photos', verdicts);
  assert.match(task, /there is no plan\.md/);
  assert.doesNotMatch(task, /following the approved plan\.md/);
});

test('the no-plan outcome still offers to write the thing', () => {
  // NO-PLAN-NEEDED fired for the first time on 19 Aug and then ended in silence: the
  // build offer was gated on the plan being approved, so the outcome that most obviously
  // ends in "shall I write it, then" was the only one that offered nothing. §7's M9 exit
  // checklist has said "he offers to just write it instead" since before the branch worked.
  assert.match(BUILD_OFFER_QUESTION['no-plan'], /Shall I just write it\?$/);
  assert.doesNotMatch(BUILD_OFFER_QUESTION['no-plan'], /milestone/i);
});

test('an approved plan is still offered as its first milestone', () => {
  assert.match(BUILD_OFFER_QUESTION.plan, /first milestone/);
});

test('with no plan, the task never sends the agent to read one', () => {
  // Three separate references to plan.md sat in this task text, none ever exercised —
  // the branch that reaches them had not fired until 19 Aug. An agent told to follow a
  // plan.md that was deliberately never written is being sent to look for nothing.
  const { opening, conventions, heading } = standaloneFacingLines('Validatron', 'add comments');

  // Nothing may *direct* the agent to a plan.
  for (const line of [heading, ...conventions]) {
    assert.doesNotMatch(line, /plan\.md/, line);
  }

  // The opening does name plan.md, on purpose: saying there is none preempts a hunt for
  // it, which is the opposite of sending the agent looking.
  assert.match(opening, /there is no plan\.md/);
  assert.match(opening, /too small to need a plan/);
});

test('with no plan, the conventions travel in the task itself', () => {
  // They were still decided in the interview. With no plan.md there is nowhere else for
  // them to live, and dropping them silently would lose an answer the user gave.
  const { conventions } = standaloneFacingLines('Validatron', 'add comments');
  assert.deepEqual(conventions, ['Comments: add comments']);
});

test('with no plan, every answer travels in the task', () => {
  // Found live: "generate a dozen or so, and embed them in the script" was answered, and
  // never reached the agent — the task carried six of the eight topics because plan.md
  // carried the rest. With no plan there is no rest, and the agent wrote five compliments
  // and reported success.
  const { standalone } = standaloneFacingLines('Ego Refresh', undefined, {
    data: 'generate a dozen or so, and embed them in the script',
    linter: 'not needed',
  });

  assert.deepEqual(standalone, [
    'Data: generate a dozen or so, and embed them in the script',
    'Linter: not needed',
  ]);
});

test('answers that were never given add no empty lines', () => {
  const { standalone } = standaloneFacingLines('Ego Refresh', undefined, {});
  assert.deepEqual(standalone, []);
});
