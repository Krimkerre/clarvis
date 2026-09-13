import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CODEX_STATE_ROUTE, exampleNamed } from '../../test/fakes/relayContract';
import { newCheckpoint, type TaskCheckpoint, type TransferStep } from '../checkpoint/taskCheckpoint';
import type { CodexState } from '../relay/relayTypes';
import { codexStartFor, holderFor, mayMove, mayReleaseLock, switchConfirmLine, TRANSFER_STEPS } from './transferState';

/**
 * The switch's rules on their own (design §6.2): steps in order, the lock never let go during a switch, and
 * Codex taking a task back on its idle session, a resumed thread, or a fresh brief — decided by what RAVIS says.
 */

const signedIn = () => structuredClone(exampleNamed(CODEX_STATE_ROUTE, 'signed in, three projects busy, read by a named caller').response.body) as CodexState & { home: { fingerprint: string } };

function withCodexSession(session: Partial<NonNullable<TaskCheckpoint['codexSession']>> = {}): TaskCheckpoint {
  const home = signedIn().home.fingerprint;
  return {
    ...newCheckpoint({ taskId: 'task-1', workspaceRoot: '/root', host: 'desktop', engine: 'clarvis', task: 'Build it.', now: new Date(0) }),
    codexSession: { id: 'as_1', threadId: 'thread-1', lastTurnStatus: 'interrupted', homeFingerprint: home, ...session },
  };
}

test('steps go forward one at a time; any step before started can fail; nothing moves after started or failed', () => {
  let previous: TransferStep | undefined;
  for (const step of TRANSFER_STEPS) {
    assert.equal(mayMove(previous, step), true, `${previous} → ${step}`);
    previous = step;
  }
  assert.equal(mayMove(undefined, 'confirming'), false, 'no skipping ahead');
  assert.equal(mayMove('stopping', 'settling'), false);
  assert.equal(mayMove('saved', 'stopping'), false, 'no going back');
  for (const step of TRANSFER_STEPS.slice(0, -1)) assert.equal(mayMove(step, 'failed'), true, `${step} → failed`);
  assert.equal(mayMove(undefined, 'failed'), false);
  assert.deepEqual([mayMove('started', 'failed'), mayMove('failed', 'stopping')], [false, false]);
});

test('the lock is never let go during a switch; outside one, or after one failed, only once processes are gone and the work saved', () => {
  for (const step of TRANSFER_STEPS) {
    assert.equal(mayReleaseLock({ step, processesGone: true, saved: true }), false, `during ${step}`);
  }
  for (const step of [undefined, 'failed'] as const) {
    assert.equal(mayReleaseLock({ step, processesGone: true, saved: true }), true);
    assert.equal(mayReleaseLock({ step, processesGone: false, saved: true }), false, 'something still running');
    assert.equal(mayReleaseLock({ step, processesGone: true, saved: false }), false, 'work not saved');
  }
});

test('Codex takes a task back on its idle session when RAVIS still keeps it, and never on another session', () => {
  const checkpoint = withCodexSession();

  assert.deepEqual(codexStartFor(checkpoint, signedIn(), 'as_1'), { kind: 'catch_up', sessionId: 'as_1' });
  assert.notEqual(codexStartFor(checkpoint, signedIn(), 'as_2').kind, 'catch_up');
});

test('otherwise it resumes the thread only in the same Codex home, on the confirmed account, on a proven Codex; else it starts fresh', () => {
  const resumable = withCodexSession();
  assert.deepEqual(codexStartFor(resumable, signedIn(), undefined), { kind: 'resume', threadId: 'thread-1' });

  const cases: [string, TaskCheckpoint, CodexState][] = [
    ['no thread', withCodexSession({ threadId: undefined }), signedIn()],
    ['another Codex home', withCodexSession({ homeFingerprint: 'sha256:another' }), signedIn()],
    ['no home recorded', withCodexSession({ homeFingerprint: undefined }), signedIn()],
    ['a different account', resumable, { ...signedIn(), account: { fingerprint_matches: false } }],
    ['signed out', resumable, { ...signedIn(), account: null }],
    ['an untested Codex', resumable, { ...signedIn(), runtime: { ...signedIn().runtime, verdict: 'untested' } }],
    ['unproven file rules', resumable, { ...signedIn(), runtime: { ...signedIn().runtime, strict_rules: 'unproven' } }],
    ['never used Codex', { ...resumable, codexSession: undefined }, signedIn()],
  ];
  for (const [why, checkpoint, codex] of cases) assert.deepEqual(codexStartFor(checkpoint, codex, undefined), { kind: 'brief' }, why);
});

test("the confirmation names what it costs, in the design's words; the holder is the engine's kind", () => {
  assert.equal(switchConfirmLine('codex', 'ravis/clarvis-codex'), "Stop and continue this task with Codex? That uses your ChatGPT plan's allowance.");
  assert.equal(
    switchConfirmLine('clarvis', 'ravis/clarvis-agent'),
    'Stop Codex and continue this task with ravis/clarvis-agent? That uses your API providers, which RAVIS counts as spend.'
  );
  assert.deepEqual([holderFor('codex'), holderFor('clarvis')], ['codex_session', 'clarvis_run']);
});
