import test from 'node:test';
import assert from 'node:assert/strict';
import { gateOutcome } from './gateDecision';
import { classifyCommand } from './Gate';

/**
 * The gate's *effect*, which nothing tested.
 *
 * `Gate.test.ts` covers which commands are dangerous and `explainGate` covers how that
 * is worded. Neither reaches the question the gate exists to answer: does saying no
 * actually stop the command. That decision sat inside a private method of a class
 * importing `vscode`, unreachable from this suite, so the most consequential branch in
 * the agent was the least covered one.
 */

// A real verdict, from the real classifier, so these tests move when it does.
const install = classifyCommand('npm install left-pad');
const sudo = classifyCommand('sudo rm -rf /');
const harmless = classifyCommand('ls -la');

test('the classifier still produces the verdicts these tests are about', () => {
  // Guards the rest: if `classifyCommand` stopped flagging installs, every assertion
  // below would pass by testing the ungated path while claiming to test the gate.
  assert.ok(install, 'an install should be gated');
  assert.equal(install?.category, 'dependency');
  assert.ok(sudo, 'sudo should be gated');
  assert.equal(harmless, undefined, 'an ordinary listing should not be gated');
});

test('refusing stops the command', () => {
  const outcome = gateOutcome(install, 'refused', true);
  assert.equal(outcome.run, false);
});

test('a refusal tells the model not to retry', () => {
  // An agent told only that something failed tries again, and each retry is another
  // modal — which is how a person learns to approve things to make the dialogs stop.
  const outcome = gateOutcome(install, 'refused', true);
  assert.match(String(outcome.toldTheModel), /declined/i);
  assert.match(String(outcome.toldTheModel), /retry/i);
});

test('approving runs it, and inside the sandbox', () => {
  const outcome = gateOutcome(install, 'approved', true);
  assert.equal(outcome.run, true);
  assert.equal(outcome.confined, true);
});

test('choosing to step out runs it unconfined', () => {
  const outcome = gateOutcome(install, 'unconfined', true);
  assert.equal(outcome.run, true);
  assert.equal(outcome.confined, false);
});

test('a category that may not leave the sandbox stays in it however it is answered', () => {
  // `mayEscapeConfinement` allows dependency and privilege only. Anything else
  // answering 'unconfined' is an answer to a question that was never asked, and it must
  // not become an escape by arriving in the wrong field.
  const destructive = classifyCommand('rm -rf src');
  assert.ok(destructive);
  assert.notEqual(destructive?.category, 'dependency');
  assert.equal(gateOutcome(destructive, 'unconfined', true).confined, true);
});

test('an ungated command runs without anyone being asked', () => {
  // The ordinary case, and the one that must not become conditional on an answer to a
  // question nobody put.
  const outcome = gateOutcome(harmless, undefined, true);
  assert.equal(outcome.run, true);
  assert.equal(outcome.confined, true);
});

test('stepping out of a standing sandbox is marked as an escape', () => {
  // `escapes` rather than `!confined`, because the second is also true where there was
  // never a sandbox — and those want opposite handling: one was permitted at a modal,
  // the other has permitted nothing and still owes the person a separate question.
  assert.equal(gateOutcome(install, 'unconfined', true).escapes, true);
  assert.equal(gateOutcome(install, 'unconfined', false).escapes, false);
  assert.equal(gateOutcome(install, 'approved', true).escapes, false);
});

test('with no sandbox, stepping out is not a concession anyone can make', () => {
  // Nothing is confined, so "run it unconfined" grants nothing — and treating it as a
  // grant would skip the separate refusal that the sandbox-less case has of its own.
  const outcome = gateOutcome(install, 'unconfined', false);
  assert.equal(outcome.run, true);
  assert.equal(outcome.confined, false);
});

test('a gated command with no answer at all does not run unconfined', () => {
  // Defensive: an answer that never arrived is not permission. It stays inside
  // whatever confinement the machine has.
  const outcome = gateOutcome(install, undefined, true);
  assert.equal(outcome.confined, true);
});
