import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPlan } from './PlanWriter';
import { InterviewState } from './interviewTopics';
import { FindingVerdict } from './verdictSummary';

const state: InterviewState = {
  answers: [
    { topic: 'what-it-does', text: 'renames photos by EXIF date' },
    { topic: 'who-and-where', text: 'CLI, local machine' },
    { topic: 'language', text: 'Python', reasoning: 'fast to write, and the libraries are mature' },
    { topic: 'scope', text: 'no GUI' },
    { topic: 'data', text: undefined },
    { topic: 'linter', text: 'yes' },
  ],
};

const verdicts: FindingVerdict[] = [
  {
    finding: { class: 'safety', what: 'no dry-run mode', whyItMatters: 'renames are hard to undo', suggestedResolution: 'add a --dry-run flag' },
    status: 'accepted',
  },
  {
    finding: { class: 'scope', what: 'assumes JPEG only', whyItMatters: 'other formats have EXIF too', suggestedResolution: 'support common formats' },
    status: 'rejected',
    reasoning: 'JPEG-only is fine for v1',
  },
];

test('the title uses the project name when there is one, the seed otherwise', () => {
  const withName = renderPlan({ projectName: 'Snapshot', seed: 'renames photos', state, verdicts: [] });
  assert.match(withName, /^# Snapshot/);
  assert.match(withName, /\*renames photos\*/);

  const withoutName = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(withoutName, /^# renames photos/);
});

test('established answers land in their sections', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(plan, /## 1\. Concept\n\nrenames photos by EXIF date/);
  assert.match(plan, /## 3\. Language\n\n\*\*Python\*\* — fast to write, and the libraries are mature/);
});

test('a section with a recorded question shows what was asked, not just the answer', () => {
  const withQuestion: InterviewState = {
    answers: [{ topic: 'scope', text: 'no GUI', question: 'What should this explicitly not do?' }],
  };
  const plan = renderPlan({ seed: 'renames photos', state: withQuestion, verdicts: [] });
  assert.match(plan, /## 4\. Scope\n\n\*\*Asked:\*\* What should this explicitly not do\?\n\nno GUI/);
});

test('an unanswered topic renders honestly, not invented', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(plan, /## 5\. Data\n\n_Not yet determined\._/);
});

test('open questions list unanswered topics', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(plan, /## 9\. Open Questions\n- data — not yet known/);
});

test('the build checklist is the steps, not the findings', () => {
  // Found live: milestone one was the definition of done plus every finding's
  // suggested fix — all of them clarifications — so the agent read the plan, found
  // nothing it could build, and stopped.
  const plan = renderPlan({
    seed: 'renames photos',
    state,
    verdicts,
    milestones: [
      {
        title: 'A CLI that renames one file',
        steps: [
          { step: 'Create the CLI entry point', check: 'run `photoname --help`, see the usage text' },
          { step: 'Read EXIF dates' },
        ],
      },
      { title: 'Batch renaming', steps: [{ step: 'Accept a folder' }] },
    ],
  });
  // Every milestone is written down, numbered — the numbering is what readMilestones
  // reads back to decide which one is next.
  assert.match(plan, /### Milestone 1 — A CLI that renames one file/);
  assert.match(plan, /### Milestone 2 — Batch renaming/);
  assert.match(plan, /- \[ \] Create the CLI entry point/);
  // The check and a place to put its result, written before there is a result.
  assert.match(plan, /- Check: run `photoname --help`, see the usage text/);
  assert.match(plan, /- Result: not run yet/);
  // A step the model gave no check for still appears; a step is worth more with its
  // test and far more than nothing.
  assert.match(plan, /- \[ \] Read EXIF dates/);
  // Accepted findings are recorded as what was agreed, not as a second checklist —
  // the actionable ones are folded into the steps by whoever wrote them.
  assert.match(plan, /\*\*Agreed during review\*\*[^]*- add a --dry-run flag/);
  assert.doesNotMatch(plan, /- \[ \] add a --dry-run flag/);
});

test('a plan with no milestones says so rather than looking finished', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(plan, /_No milestones written/);
});

test('rejected findings become decisions', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts });
  assert.doesNotMatch(plan, /support common formats/);
  assert.match(plan, /## 8\. Decisions\n- \*\*\[scope\]\*\* assumes JPEG only — rejected\. JPEG-only is fine for v1/);
});

test('a modified finding is settled in the user\'s own words, not the original fix', () => {
  // Found live: modifying a finding to "ESLint" still put the original "name a
  // linter" suggestion in the checklist, contradicting the edit sitting right above it.
  const modified: FindingVerdict = {
    finding: {
      class: 'improvement',
      what: 'no linter was named',
      whyItMatters: 'CI cannot enforce anything without a named tool',
      suggestedResolution: 'Name the linter in the definition of done',
    },
    status: 'modified',
    reasoning: 'ESLint',
  };
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [modified] });
  assert.match(plan, /- ESLint/);
  assert.doesNotMatch(plan, /Name the linter in the definition of done/);
});

test('includes the working-process section and a branch flow section', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(plan, /## 0\. Working Process/);
  assert.match(plan, /## Branch flow/);
});

test('the plan carries conventions in the project\'s own language', () => {
  // A plan that says how to work and nothing about how to write leaves the agent
  // building in whatever style its model reaches for — the drift §0 exists to
  // prevent, which generated projects were inheriting only half of.
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });

  assert.match(plan, /## Conventions/);
  assert.match(plan, /\*\*Python:\*\*/);
  assert.match(plan, /PEP 8/);
  // Not TypeScript's rules wearing a Python heading.
  assert.doesNotMatch(plan, /camelCase/);
});

test('the recorded comment decision lands in the conventions', () => {
  const decided: InterviewState = {
    answers: [
      ...state.answers,
      { topic: 'comment-style', text: 'lean — the code should explain itself' },
    ],
  };

  assert.match(renderPlan({ seed: 'x', state: decided, verdicts: [] }), /only where something is genuinely surprising/);
});
