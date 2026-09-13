import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRevision, changedLine, conflictLine, parseRevision, readRevision, revisionPrompt, withNote } from './planRevision';
import { renderPlan } from './PlanWriter';
import { InterviewState } from './interviewTopics';

/**
 * Typed feedback, applied to a drafted plan (M9i). The draft is a real rendered plan, so a
 * splice that disturbs a section it was not asked to touch shows up against the shape
 * `renderPlan` actually writes, and `readMilestones` actually reads back.
 */

const state: InterviewState = {
  projectName: 'Repair Log',
  answers: [
    { topic: 'what-it-does', text: 'Track repair jobs' },
    { topic: 'who-and-where', text: 'Me, on my own laptop' },
    { topic: 'scope', text: 'Jobs, photos, and cloud sync between devices' },
    { topic: 'linter', text: 'none' },
    { topic: 'comment-style', text: 'only where it is not obvious' },
  ],
};

const draft = renderPlan({
  projectName: 'Repair Log',
  seed: 'Track repair jobs',
  state,
  verdicts: [],
  milestones: [
    {
      title: 'First job',
      steps: [
        { step: 'Store a job locally', check: 'create one, restart, it is still listed' },
        { step: 'Sync jobs to the cloud', check: 'the job appears on a second device' },
      ],
    },
  ],
});

const SCOPE = ['SECTION: ## 4. Scope', 'Jobs and photos, kept on this machine.', 'END SECTION'].join('\n');

/** The plan with one section's text taken out, so everything around it can be compared. */
function without(text: string, heading: string): string {
  const start = text.indexOf(`${heading}\n`);
  return text.slice(0, start) + text.slice(text.indexOf('\n## ', start + 1));
}

test('the model is shown the draft and the feedback, and told the shape to answer in', () => {
  const prompt = revisionPrompt(draft, 'keep everything local');

  assert.ok(prompt.includes(draft));
  assert.match(prompt, /keep everything local/);
  assert.match(prompt, /SECTION: <the section heading line/);
  assert.match(prompt, /^END SECTION$/m);
  assert.match(prompt, /NO-CHANGE:/);
  assert.match(prompt, /must never be output: "## 0\. Working Process[^]*"## Branch flow"/);
});

test('a changed section is read with its heading and its text', () => {
  assert.deepEqual(parseRevision(SCOPE), { changes: [{ heading: '## 4. Scope', body: 'Jobs and photos, kept on this machine.\n' }] });
});

test('a reply cut off before its last END SECTION is not applied at all, not even the finished part', () => {
  assert.equal(parseRevision(`${SCOPE}\nSECTION: ## 5. Data\nLocal files only`), undefined);
});

test('NO-CHANGE is read as its reason', () => {
  assert.deepEqual(parseRevision('NO-CHANGE: it already keeps everything local'), { noChange: 'it already keeps everything local' });
});

test('prose is not a revision', () => {
  assert.equal(parseRevision('Sure! I have removed cloud sync from the plan.'), undefined);
});

test('only the named section changes, and everything around it is left exactly as it was', () => {
  const result = applyRevision(draft, [{ heading: '## 4. Scope', body: 'Jobs and photos, kept on this machine.' }]);

  assert.ok('text' in result);
  assert.match(result.text, /## 4\. Scope\n\nJobs and photos, kept on this machine\.\n\n## 5\. Data/);
  assert.equal(without(result.text, '## 4. Scope'), without(draft, '## 4. Scope'));
});

test('a heading the draft does not have is refused', () => {
  const result = applyRevision(draft, [{ heading: '## 4. Scope and budget', body: 'x' }]);
  assert.ok('problem' in result);
  assert.match(result.problem, /does not have/);
});

test('the working process and the branch flow are never rewritten from typed feedback', () => {
  for (const heading of ['## 0. Working Process — Plan Mode vs. Code Mode', '## Branch flow']) {
    const result = applyRevision(draft, [{ heading, body: 'Just build it.' }]);
    assert.ok('problem' in result, heading);
    assert.match(result.problem, /never changes/);
  }
});

test('the same section rewritten twice is refused', () => {
  const change = { heading: '## 4. Scope', body: 'x' };
  const result = applyRevision(draft, [change, change]);
  assert.ok('problem' in result);
  assert.match(result.problem, /twice/);
});

test('a rewrite that would leave nothing to build is refused', () => {
  const result = applyRevision(draft, [{ heading: '## 7. Milestones', body: 'We will see how it goes.' }]);
  assert.ok('problem' in result);
  assert.match(result.problem, /no milestone/);
});

test('a heading inside a fenced block is not a section of the plan', () => {
  const fenced = `${draft}\n\`\`\`\n## 4. Scope\n\`\`\`\n`;
  assert.ok('text' in applyRevision(fenced, [{ heading: '## 4. Scope', body: 'x' }]));
});

test('a revision that lands names the sections it changed', () => {
  const revision = readRevision(draft, SCOPE, false);

  assert.ok('text' in revision);
  assert.deepEqual(revision.changed, ['4. Scope']);
  assert.equal(changedLine(revision), 'Changed 4. Scope. Read it over, then approve it or say what else should change.');
});

test('a revision cut short by the deadline leaves the draft unchanged, and says so', () => {
  const revision = readRevision(draft, SCOPE, true);
  assert.ok('unchanged' in revision);
  assert.match(revision.unchanged, /draft is unchanged/);
});

test('a refused revision says why the draft is unchanged', () => {
  const revision = readRevision(draft, 'SECTION: ## Branch flow\nnone\nEND SECTION', false);
  assert.ok('unchanged' in revision);
  assert.match(revision.unchanged, /^I could not apply that — it tried to rewrite "## Branch flow"/);
});

test('NO-CHANGE leaves the draft unchanged, with its reason', () => {
  assert.deepEqual(readRevision(draft, 'NO-CHANGE: it is already local', false), {
    unchanged: 'Nothing in the draft needed to change for that: it is already local',
  });
});

test('with no model, feedback goes under Notes before the milestones, and more feedback joins it', () => {
  const noted = withNote(draft, 'keep everything local');

  assert.match(noted, /## Notes\n\n- keep everything local\n\n## 7\. Milestones/);
  assert.match(withNote(noted, 'no accounts'), /## Notes\n\n- keep everything local\n- no accounts\n\n## 7\. Milestones/);
  assert.match(changedLine({ changed: ['Notes'], asNote: true }), /went under Notes/);
});

test('an edit made while revising is named back with the feedback it displaced', () => {
  assert.match(conflictLine('keep everything local'), /kept your edits and did not apply "keep everything local"/);
});
