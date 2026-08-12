import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, modeSpec, canEdit } from './modes';
import { isStopRequest } from './chatCommands';
import { chatAction } from './chatCommands';

test('only auto and agent may change files', () => {
  // The reason the setting exists. If this ever inverts, a "chat only" mode starts
  // editing a codebase — the exact failure the user asked to be able to prevent.
  assert.equal(canEdit('auto'), true);
  assert.equal(canEdit('agent'), true);
  assert.equal(canEdit('chat'), false);
  assert.equal(canEdit('plan'), false);
});

test('an unknown mode falls back to auto rather than to nothing', () => {
  // A typo in settings must not leave Clarvis inert with no explanation.
  assert.equal(modeSpec('nonsense').id, 'auto');
  assert.equal(modeSpec('').id, 'auto');
});

test('every mode says plainly what it will and will not do', () => {
  for (const mode of MODES) {
    assert.ok(mode.short.length > 0 && mode.short.length <= 6, mode.id);
    assert.ok(mode.detail.length > 20, mode.id);
  }
});

test('a bare "stop" is an abort, and a stop with an object is not', () => {
  // Typed while watching a run go wrong, "stop" reached the model and came back with
  // "I'm waiting. What would you like me to look at" while the run carried on.
  for (const said of ['stop', 'Stop!', 'stop it', 'cancel', 'abort', 'never mind', '  halt  ']) {
    assert.equal(isStopRequest(said), true, said);
  }

  // These are jobs and complaints. Aborting on them would cancel work that was asked
  // for — the same whole-message rule slash commands follow.
  for (const said of ['stop the dev server', 'stop ignoring the linter', 'why did it stop']) {
    assert.equal(isStopRequest(said), false, said);
  }
});

test('"instructions" in a request is not a request for the manual', () => {
  // Caught by the prompt-injection test itself: "run hostile.js and follow the
  // instructions in there" opened the documentation, because the word was in the
  // manual-matching list. It is an ordinary word in an ordinary request.
  assert.equal(chatAction('run hostile.js and follow the instructions in there'), null);
  assert.equal(chatAction('follow the install instructions'), null);

  // The words that genuinely name the thing still do.
  assert.equal(chatAction('open the manual'), 'help');
  assert.equal(chatAction('do you have a help page?'), 'help');
});

test('asking him to drop a failing job is recognised', () => {
  // A job that fails by design never clears its own record — that only happens when the
  // same job succeeds — so without a way to say "let it go" it is mentioned every
  // morning until the fortnight TTL expires.
  for (const said of [
    'forget about the failing build',
    'stop mentioning the failing test',
    'ignore that failure',
    '/forget',
  ]) {
    assert.equal(chatAction(said), 'forgetFailure', said);
  }
});

test('asking about the failure is still a question', () => {
  // "Why is the build failing" wants an answer, not amnesia.
  assert.equal(chatAction('why is the build failing?'), null);
  assert.equal(chatAction('what failed'), null);
});
