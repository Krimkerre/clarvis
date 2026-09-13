import assert from 'node:assert/strict';
import { test } from 'node:test';
import { newCheckpoint, type TaskCheckpoint } from '../checkpoint/taskCheckpoint';
import type { CodexSettleFacts } from '../codex/runCore';
import { checkpointFromClarvis, checkpointFromCodex } from './fromSource';

/**
 * The checkpoint a switch writes, from what the stopping engine knows: the task's own history kept, open questions
 * never answered, cut-off work only as uncertain — and never built on another task's or another folder's record.
 */

const ROOT = '/Users/owner/Documents/coding/add-utc-demo';
const NOW = new Date('2026-09-13T02:00:00Z');
const CONTEXT = { workspaceRoot: ROOT, host: 'desktop' as const, now: NOW };

function saved(overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return {
    ...newCheckpoint({ taskId: 'task-1', workspaceRoot: ROOT, host: 'code-server', engine: 'clarvis', task: 'Build milestone 2.', now: new Date('2026-09-13T01:00:00Z'), plan: { fromPlan: true, steps: ['Add the --utc flag'], uncheckedSteps: ['Add the --utc flag'] } }),
    latestFeedback: [{ text: 'Use datetime.', typedAt: '2026-09-13T01:30:00Z', host: 'code-server', delivered: true }],
    ...overrides,
  };
}

function codexFacts(overrides: Partial<CodexSettleFacts> = {}): CodexSettleFacts {
  return {
    taskId: 'task-1',
    session: { id: 'as_1', threadId: 'thread-1', lastTurnId: 'turn-9', lastTurnStatus: 'interrupted', sawHeadCommit: 'abc1234' },
    branch: 'clarvis/add-utc',
    headCommit: 'abc1234',
    changedFiles: ['hello.py'],
    checks: [{ command: 'python3 -m pytest -q', exitCode: 1, outputTail: '1 failed' }],
    feedback: [
      { text: 'Use datetime.', typedAt: '2026-09-13T01:30:00Z', host: 'code-server', delivered: true },
      { text: 'Keep --local.', typedAt: '2026-09-13T01:55:00Z', host: 'desktop', delivered: false },
    ],
    unanswered: [{ engine: 'codex', summary: 'Codex asked to run `pip install pytz`' }],
    uncertain: [{ kind: 'command', summary: 'npm install left-pad', state: 'unknown' }],
    status: 'transferring',
    ...overrides,
  };
}

test("a Codex settle builds on the task's own record: its brief and plan kept, what was said merged once, the thread and Codex home recorded", () => {
  const checkpoint = checkpointFromCodex(saved(), codexFacts(), { ...CONTEXT, homeFingerprint: 'sha256:home' });

  assert.deepEqual([checkpoint.task, checkpoint.plan.steps, checkpoint.engine, checkpoint.status], ['Build milestone 2.', ['Add the --utc flag'], 'codex', 'transferring']);
  assert.deepEqual([checkpoint.git.branch, checkpoint.git.headCommit, checkpoint.changedFiles], ['clarvis/add-utc', 'abc1234', ['hello.py']]);
  assert.deepEqual(checkpoint.latestFeedback.map((note) => [note.text, note.delivered]), [['Use datetime.', true], ['Keep --local.', false]]);
  assert.deepEqual(checkpoint.checks, [{ command: 'python3 -m pytest -q', exitCode: 1, engine: 'codex', ranAt: NOW.toISOString(), outputTail: '1 failed' }]);
  assert.deepEqual(checkpoint.codexSession, { ...codexFacts().session, homeFingerprint: 'sha256:home' });
  assert.deepEqual([checkpoint.unresolvedQuestions, checkpoint.uncertainOperations], [codexFacts().unanswered, codexFacts().uncertain]);
});

test("another task's record, or another folder's, is never built on: a new record is started for this task", () => {
  for (const other of [saved({ taskId: 'another-task' }), saved({ workspaceRoot: `${ROOT}-v2` })]) {
    const checkpoint = checkpointFromCodex(other, codexFacts(), CONTEXT);
    assert.deepEqual([checkpoint.taskId, checkpoint.workspaceRoot, checkpoint.task, checkpoint.plan.steps], ['task-1', ROOT, '', []]);
  }
});

test("a stopped Clarvis-engine run hands on what was typed as undelivered, its step question as unanswered, and a cut-off command as uncertain", () => {
  const checkpoint = checkpointFromClarvis(
    saved(),
    {
      branch: 'clarvis/add-utc',
      headCommit: 'def5678',
      changedFiles: ['hello.py', 'generated.txt'],
      diffStat: [{ path: 'hello.py', added: 2, removed: 1 }],
      dirty: ['notes.md'],
      checks: [{ command: 'npm test', exitCode: 0, engine: 'clarvis', ranAt: NOW.toISOString(), outputTail: 'ok' }],
      typed: ['Also update the README.'],
      question: 'Run `npm test` before committing?',
      interrupted: { kind: 'command', summary: 'runCommand: npm install left-pad', state: 'unknown' },
      lockId: 'pl_1',
    },
    CONTEXT
  );

  assert.deepEqual([checkpoint.engine, checkpoint.status, checkpoint.git.headCommit, checkpoint.git.dirty, checkpoint.lock], ['clarvis', 'transferring', 'def5678', ['notes.md'], { id: 'pl_1', kind: 'clarvis_run' }]);
  assert.deepEqual(checkpoint.latestFeedback.map((note) => [note.text, note.delivered]), [['Use datetime.', true], ['Also update the README.', false]]);
  assert.deepEqual(checkpoint.unresolvedQuestions, [{ engine: 'clarvis', summary: 'Run `npm test` before committing?' }]);
  assert.deepEqual(checkpoint.uncertainOperations, [{ kind: 'command', summary: 'runCommand: npm install left-pad', state: 'unknown' }]);
});
