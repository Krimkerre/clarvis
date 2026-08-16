import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planJob } from './jobDecision';
import { routeFor } from './routing';

const AGENT = routeFor('fix the failing test');
const ANSWER = routeFor('what is broken?');

// ---------------------------------------------------------------------------
// The mode gate. This is what stands between a convincing sentence and Clarvis
// writing to your files, and until now nothing tested it.
// ---------------------------------------------------------------------------

test('a mode that cannot edit never produces a job, however the message reads', () => {
  for (const mode of ['chat', 'plan'] as const) {
    assert.deepEqual(planJob('fix the failing test', mode, AGENT, false), { kind: 'none' });
  }
});

test('the mode gate outranks an escalation', () => {
  // "do it" with something to refer back to is the strongest signal there is, and it
  // still does not get past a mode that cannot edit.
  assert.deepEqual(planJob('do it', 'chat', ANSWER, true), { kind: 'none' });
});

test('the editing modes do produce a job for work', () => {
  for (const mode of ['auto', 'agent', 'unattended'] as const) {
    assert.equal(planJob('fix the failing test', mode, AGENT, false).kind, 'job');
  }
});

// ---------------------------------------------------------------------------
// Escalation: "do it" means the thing just answered, not this message.
// ---------------------------------------------------------------------------

test('"do it" escalates the previous answer when there is one', () => {
  assert.deepEqual(planJob('do it', 'auto', ANSWER, true), { kind: 'escalate' });
});

test('"do it" with nothing to refer back to is not an escalation', () => {
  // Otherwise the task would be undefined and the run would start on nothing.
  assert.notEqual(planJob('do it', 'auto', ANSWER, false).kind, 'escalate');
});

// ---------------------------------------------------------------------------
// Why, and who says so.
// ---------------------------------------------------------------------------

test('agent mode says so plainly; the other editing modes explain what they saw', () => {
  const inAgent = planJob('fix the failing test', 'agent', AGENT, false);
  const inAuto = planJob('fix the failing test', 'auto', AGENT, false);

  assert.equal(inAgent.kind === 'job' && inAgent.because, 'Agent mode — treating that as a job.');
  assert.equal(inAuto.kind === 'job' && inAuto.because, AGENT.because);
});

// ---------------------------------------------------------------------------
// The classifier, and the one mode that must never reach it.
// ---------------------------------------------------------------------------

test('plan mode is never sent to the classifier', () => {
  // §0: planning may touch plan.md and nothing else, so a message that merely sounds
  // like work must not become work — not even on the model's say-so.
  const anything = planJob('the photo renamer should handle HEIC', 'plan', ANSWER, false);
  assert.deepEqual(anything, { kind: 'none' });
});

test('a message the verb list missed is worth one model call', () => {
  assert.equal(planJob('the tests are still red', 'auto', ANSWER, false).kind, 'classify');
});

test('a plain question is neither a job nor worth classifying', () => {
  assert.deepEqual(planJob('what is broken?', 'auto', ANSWER, false), { kind: 'none' });
});
