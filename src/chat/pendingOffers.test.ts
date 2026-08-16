import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerToConsume } from './pendingOffers';

// ---------------------------------------------------------------------------
// The rule this file exists for: stop outranks every pending question except the
// interview, which cancels itself. Written after finding that five offers were
// consulted ahead of the stop check, and two of them ate the word.
// ---------------------------------------------------------------------------

test('stop reaches the stop path while a scope change is waiting to be ruled on', () => {
  // The message used to be read as "no, leave it out of the plan" — a decision the
  // user never made — and the run carried on.
  assert.equal(offerToConsume('stop', ['scope']), 'stop');
});

test('stop reaches the stop path while review findings are waiting', () => {
  // This one fell past "fix" and "add to the plan" into "leave them alone", so it
  // silently discarded the findings as well as failing to stop.
  assert.equal(offerToConsume('stop', ['review']), 'stop');
});

test('stop reaches the stop path whichever offer is armed', () => {
  for (const offer of ['review', 'resume', 'scope', 'build', 'plan'] as const) {
    assert.equal(offerToConsume('stop', [offer]), 'stop', `${offer} must not swallow stop`);
  }
});

test('the interview handles stop itself, so it keeps the message', () => {
  // Mid-interview "stop" means cancel the interview, not stop a run — and cancelling
  // has to unwind the question that is waiting rather than abandon it.
  assert.equal(offerToConsume('stop', ['interview']), 'interview');
});

test('the interview outranks stop even when another offer is also armed', () => {
  assert.equal(offerToConsume('stop', ['scope', 'interview']), 'interview');
});

// ---------------------------------------------------------------------------
// Ordinary precedence, unchanged: the order offers are tried in.
// ---------------------------------------------------------------------------

test('an ordinary message goes to the first armed offer in order', () => {
  assert.equal(offerToConsume('yes', ['build', 'review']), 'review');
  assert.equal(offerToConsume('yes', ['plan', 'scope']), 'scope');
  assert.equal(offerToConsume('yes', ['plan']), 'plan');
});

test('a message with nothing waiting routes normally', () => {
  assert.equal(offerToConsume('what is broken?', []), 'none');
  assert.equal(offerToConsume('stop', []), 'stop');
});
