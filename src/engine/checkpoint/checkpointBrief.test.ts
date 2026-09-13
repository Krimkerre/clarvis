import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catchUpText, renderCheckpoint, UNCERTAIN_HEADING } from './checkpointBrief';
import { newCheckpoint, type TaskCheckpoint } from './taskCheckpoint';

/**
 * What the next engine is told (design §6.2): the task carried on from its branch, what the owner said, what was
 * never answered — and anything uncertain only as something to check, never as something to do again.
 */

const ROOT = '/Users/owner/Documents/coding/add-utc-demo';
const NOW = new Date('2026-09-13T02:00:00Z');
const SAVED = '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';
const SAW = '3f9c2e1d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e';

function carried(): TaskCheckpoint {
  return {
    ...newCheckpoint({ taskId: 'task-1', workspaceRoot: ROOT, host: 'desktop', engine: 'codex', task: 'Build milestone 2.', now: NOW }),
    plan: { file: 'plan.md', fromPlan: true, steps: ['Parse the arguments', 'Add the --utc flag'], uncheckedSteps: ['Add the --utc flag'], milestone: { index: 2, title: 'UTC output' }, nextAction: 'Add the --utc flag' },
    requirements: { checks: ['`python3 -m pytest -q` passes'], exclusions: ['Time zones other than UTC'], rejected: ['Using pytz'] },
    git: { branch: 'clarvis/add-utc', headCommit: SAVED, dirty: [], diffStat: [{ path: 'hello.py', added: 12, removed: 3 }] },
    changedFiles: ['hello.py'],
    checks: [
      { command: 'python3 -m pytest -q', exitCode: 1, engine: 'codex', ranAt: NOW.toISOString(), outputTail: '1 failed' },
      { command: 'python3 hello.py --utc', exitCode: 0, engine: 'codex', ranAt: NOW.toISOString(), outputTail: '' },
    ],
    latestFeedback: [
      { text: 'Already handled: print the date.', typedAt: NOW.toISOString(), host: 'desktop', delivered: true },
      { text: 'Keep the old --local flag too.', typedAt: NOW.toISOString(), host: 'desktop', delivered: false },
    ],
    unresolvedQuestions: [{ engine: 'codex', summary: 'Codex wanted to run `pip install pytz`.' }],
    uncertainOperations: [{ kind: 'command', summary: 'npm install left-pad', state: 'unknown' }],
    codexSession: { id: 'as_1', threadId: 'thread-1', lastTurnStatus: 'interrupted', sawHeadCommit: SAW },
  };
}

test('a fresh brief carries the task on from its branch and saved commit, with every part the next engine needs', () => {
  const brief = renderCheckpoint(carried());

  for (const expected of [
    "You are carrying on a task that Codex started in this project. Its work so far is committed on `clarvis/add-utc` at 9a8b7c6; carry on there.",
    'Where it got to: milestone 2, "UTC output". Next: Add the --utc flag',
    'Steps not done yet:\n- Add the --utc flag',
    'Checks this work must pass:\n- `python3 -m pytest -q` passes',
    'Not part of this task:\n- Time zones other than UTC',
    'do not bring these back:\n- Using pytz',
    'Files changed so far:\n- hello.py (+12 −3)',
    '- `python3 -m pytest -q` failed (exit 1)\n- `python3 hello.py --utc` passed',
    '(it takes priority over the plan):\n- Keep the old --local flag too.',
    'ask again if you still need to):\n- Codex wanted to run `pip install pytz`.',
    'Re-read any file before you edit it',
  ]) {
    assert.ok(brief.includes(expected), `missing: ${expected}\n\n${brief}`);
  }
  assert.doesNotMatch(brief, /Already handled/, 'what was already delivered is not said again');
});

test('an uncertain operation is only ever something to check before repeating — never a step or the next action', () => {
  const checkpoint = carried();
  const brief = renderCheckpoint(checkpoint);
  const catchUp = catchUpText(checkpoint, { headCommit: SAVED, diffStat: checkpoint.git.diffStat });

  assert.equal(brief.split('npm install left-pad').length - 1, 1, 'named once');
  assert.ok(brief.includes(`${UNCERTAIN_HEADING}\n- command: npm install left-pad`), `under the heading that says to check first:\n\n${brief}`);
  assert.match(brief, /command: npm install left-pad \(may or may not have happened\)$/m);
  assert.equal(catchUp.split('npm install left-pad').length - 1, 1);
  assert.match(catchUp, /Not done and uncertain: command: npm install left-pad \(may or may not have happened\) — check before repeating\./);
});

test("the catch-up is the design's words: what changed since Codex last saw the project, the checks, what is uncertain, what is open, what was said", () => {
  const checkpoint = carried();

  const text = catchUpText(checkpoint, { headCommit: SAVED, diffStat: [{ path: 'hello.py', added: 12, removed: 3 }] });

  assert.equal(
    text,
    'While you were stopped, another engine worked on this project. ' +
      'Changes since commit 3f9c2e1 (now 9a8b7c6): hello.py (+12 −3). ' +
      'Checks: `python3 -m pytest -q` failed (exit 1); `python3 hello.py --utc` passed. ' +
      'Not done and uncertain: command: npm install left-pad (may or may not have happened) — check before repeating. ' +
      'Open questions: Codex wanted to run `pip install pytz`.. ' +
      'What the user said meanwhile: Keep the old --local flag too.. ' +
      'Re-read any file before editing it.'
  );
});

test('parts with nothing in them are left out of the brief', () => {
  const bare = newCheckpoint({ taskId: 'task-2', workspaceRoot: ROOT, host: 'desktop', engine: 'clarvis', task: 'Fix it.', now: NOW });

  assert.equal(
    renderCheckpoint(bare),
    "You are carrying on a task that Clarvis's own engine started in this project. Its work so far is in the project.\n\nRe-read any file before you edit it: the other engine may have changed it."
  );
});
