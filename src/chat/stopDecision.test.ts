import test from 'node:test';
import assert from 'node:assert/strict';
import { stepAfterAsking, stopReply } from './stopDecision';

// Reported 11 September 2026: Stop pressed while "Do it / Skip this step" waited stopped
// nothing until someone answered, and Stop pressed over "fold this into master?" said
// "Nothing to stop" and left the question in the panel.

test('a step answered with nobody pressing Stop runs or is skipped', () => {
  assert.equal(stepAfterAsking(true, false), 'run');
  assert.equal(stepAfterAsking(false, false), 'skip');
});

test('a "Do it" that lands after Stop does not start the step', () => {
  // The click raced the stop; the stop was the instruction.
  assert.equal(stepAfterAsking(true, true), 'stop');
});

test('a question released by Stop ends the run rather than reading as a decline', () => {
  // Stop cancels the question, which comes back unanswered. Read as a decline, the model
  // would be told the user refused the step and the chat would say "Skipped".
  assert.equal(stepAfterAsking(false, true), 'stop');
});

test('a question still waiting after the run has finished is something to stop', () => {
  assert.equal(stopReply({ busy: false, waiting: true, runWillSayIt: false }), 'stopped');
});

test('with nothing running and nothing asked, there is nothing to stop', () => {
  assert.equal(stopReply({ busy: false, waiting: false, runWillSayIt: false }), 'nothing to stop');
});

test('a run in progress reports its own stop, so the chat adds nothing', () => {
  assert.equal(stopReply({ busy: true, waiting: true, runWillSayIt: true }), 'silent');
  assert.equal(stopReply({ busy: true, waiting: false, runWillSayIt: true }), 'silent');
  // A chat reply being cut off has no ending of its own to report.
  assert.equal(stopReply({ busy: true, waiting: false, runWillSayIt: false }), 'stopped');
});

test('planning pauses, with a question on screen or a model still working out the next one', () => {
  // M9i: planning is never busy in Busy's sense, so a stop between its questions answered
  // "Nothing to stop" — and the next question arrived anyway.
  assert.equal(stopReply({ busy: false, waiting: false, runWillSayIt: false, planning: true }), 'paused');
  assert.equal(stopReply({ busy: false, waiting: true, runWillSayIt: false, planning: true }), 'paused');
});
