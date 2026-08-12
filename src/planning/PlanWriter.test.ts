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

test('an unanswered topic renders honestly, not invented', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(plan, /## 5\. Data\n\n_Not yet determined\._/);
});

test('open questions list unanswered topics', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(plan, /## 9\. Open Questions\n- data — not yet known/);
});

test('accepted findings become exit-checklist items, rejected findings become decisions', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts });
  assert.match(plan, /- \[ \] add a --dry-run flag/);
  assert.doesNotMatch(plan, /- \[ \] support common formats/);
  assert.match(plan, /## 8\. Decisions\n- \*\*\[scope\]\*\* assumes JPEG only — rejected\. JPEG-only is fine for v1/);
});

test('a modified finding\'s checklist item is the user\'s rewrite, not the original fix', () => {
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
  assert.match(plan, /- \[ \] ESLint/);
  assert.doesNotMatch(plan, /Name the linter in the definition of done/);
});

test('includes the working-process section and a branch flow section', () => {
  const plan = renderPlan({ seed: 'renames photos', state, verdicts: [] });
  assert.match(plan, /## 0\. Working Process/);
  assert.match(plan, /## Branch flow/);
});
