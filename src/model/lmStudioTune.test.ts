import test from 'node:test';
import assert from 'node:assert/strict';
import { needsLoading, parseModelStates, loadFailureReason, staleLoads } from './lmStudioTune';

// The shape /api/v0/models actually returns, trimmed to what this reads.
const BODY = {
  data: [
    { id: 'phi-4-mini-instruct', object: 'model', state: 'loaded', max_context_length: 131072 },
    { id: 'qwen/qwen3-4b-2507', object: 'model', state: 'not-loaded', max_context_length: 262144 },
    { id: 'qwen3.5-9b-optiq', object: 'model', state: 'not-loaded', max_context_length: 262144 },
  ],
};

test('reads ids and states from the real response shape', () => {
  const states = parseModelStates(BODY);
  assert.equal(states.length, 3);
  assert.deepEqual(states[0], { id: 'phi-4-mini-instruct', state: 'loaded' });
});

test('anything malformed reads as no information, never as an error', () => {
  // This whole path is an optimisation; it must never be the reason a reply fails.
  for (const junk of [undefined, null, {}, { data: 'nope' }, { data: [1, 2] }, { data: [{ id: 5 }] }]) {
    assert.deepEqual(parseModelStates(junk), []);
  }
});

test('only models the server says are not loaded get loaded', () => {
  const wanted = ['phi-4-mini-instruct', 'qwen/qwen3-4b-2507'];
  assert.deepEqual(needsLoading(parseModelStates(BODY), wanted), ['qwen/qwen3-4b-2507']);
});

// The rule that keeps this from being an action the user did not ask for: a model
// they loaded themselves is theirs, settings and all.
test('a model already loaded is never touched', () => {
  assert.deepEqual(needsLoading(parseModelStates(BODY), ['phi-4-mini-instruct']), []);
});

test('chat and agent on the same model is one load, not two', () => {
  const same = ['qwen3.5-9b-optiq', 'qwen3.5-9b-optiq'];
  assert.deepEqual(needsLoading(parseModelStates(BODY), same), ['qwen3.5-9b-optiq']);
});

test('a model the server has never heard of is skipped', () => {
  // Probably a name the user typed. Asking the CLI to load it produces an error
  // nobody can act on.
  assert.deepEqual(needsLoading(parseModelStates(BODY), ['something-i-made-up']), []);
});

test('an empty model name is skipped rather than loaded', () => {
  assert.deepEqual(needsLoading(parseModelStates(BODY), ['', 'qwen3.5-9b-optiq']), ['qwen3.5-9b-optiq']);
});

// The reason a load failed comes from stderr, which says something useful. error.message
// is `Command failed: /Users/…/lms load <id> -y` -- the command line, with an absolute
// path in it, which is F25's complaint reproduced.
test('the failure reason comes from stderr, not the command line', () => {
  const stderr = 'Model not found\n\nNo model found that matches model key "nope".\n\nTo see a list of all downloaded models, run:\n\n    lms ls\n';
  const reason = loadFailureReason(stderr, 'Command failed: /Users/someone/.lmstudio/bin/lms load nope -y');
  assert.equal(reason, 'Model not found');
  assert.doesNotMatch(reason, /\/Users\//, 'never an absolute path');
});

test('a guardrail refusal is passed through in LM Studio\'s own words', () => {
  const stderr = 'This model may not be loaded based on your resource guardrails settings.';
  assert.match(loadFailureReason(stderr, 'Command failed'), /resource guardrails/);
});

test('the CLI\'s own suggestion lines are skipped, not reported as the reason', () => {
  const stderr = '\n    lms ls\n\nOut of memory.\n';
  assert.equal(loadFailureReason(stderr, 'x'), 'Out of memory.');
});

test('empty stderr falls back to the first line of the error', () => {
  assert.equal(loadFailureReason('', 'Command failed: boom\nstack trace'), 'Command failed: boom');
});

/**
 * Unloading, which is the half that can do harm.
 *
 * `staleLoads` is the whole decision: everything else is a CLI call. The cases below are
 * the two the user asked for, plus the three that must never fire — because the failure
 * mode here is not "a model stays loaded", it is Clarvis pulling a model out from under
 * someone who was using it.
 */
test('switching to a hosted provider makes every local load stale', () => {
  // Nothing points at LM Studio any more, so nothing Clarvis loaded is wanted.
  assert.deepEqual(staleLoads(['qwen2.5-coder-7b-instruct'], []), ['qwen2.5-coder-7b-instruct']);
});

test('switching to a different local model releases only the old one', () => {
  assert.deepEqual(
    staleLoads(['qwen2.5-coder-7b-instruct'], ['granite-4.0-h-tiny']),
    ['qwen2.5-coder-7b-instruct']
  );
});

test('a mixed setup keeps the half that is still local', () => {
  // Agent on LM Studio, chat moved to Anthropic. The agent's model is still wanted.
  assert.deepEqual(
    staleLoads(['qwen2.5-coder-7b-instruct', 'granite-4.0-h-tiny'], ['granite-4.0-h-tiny']),
    ['qwen2.5-coder-7b-instruct']
  );
});

test('a model the user loaded is never in the set, so it is never unloaded', () => {
  // The guard that matters: `ourLoads` holds what Clarvis loaded, so a model loaded in
  // LM Studio by hand cannot appear here however idle it looks.
  assert.deepEqual(staleLoads([], []), []);
});

test('changing an unrelated setting releases nothing', () => {
  const ours = ['qwen2.5-coder-7b-instruct'];
  assert.deepEqual(staleLoads(ours, ours), []);
});
