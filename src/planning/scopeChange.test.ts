import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScopeChange, scopeChangePrompt } from './scopeChange';

test('the prompt draws the line between method and behaviour', () => {
  // The distinction is the whole feature. Treating a preference as a scope change
  // puts a sign-off gate in front of "use pytest instead"; treating a new feature as
  // a correction is how a v1 becomes a v3 without anyone deciding to.
  const prompt = scopeChangePrompt('- [ ] Build it', 'A CLI that renames one file', 'also email me the results');

  assert.match(prompt, /A correction changes the method/);
  assert.match(prompt, /adds behaviour nobody planned/);
  assert.match(prompt, /also email me the results/);
});

test('a correction is read as a correction', () => {
  assert.deepEqual(parseScopeChange('CORRECTION'), { kind: 'correction' });
});

test('added scope brings its steps and where they belong', () => {
  const verdict = parseScopeChange(
    [
      'SCOPE: emails the results when a run finishes',
      'WHEN: later',
      'Send an email after each run | run it, check the inbox',
      'Make the address configurable | set it in the config, verify it is used',
    ].join('\n')
  );

  assert.equal(verdict.kind, 'scope');
  if (verdict.kind !== 'scope') return;
  assert.equal(verdict.summary, 'emails the results when a run finishes');
  assert.equal(verdict.placement, 'later');
  assert.equal(verdict.steps.length, 2);
  assert.deepEqual(verdict.steps[0], { step: 'Send an email after each run', check: 'run it, check the inbox' });
});

test('scope the current milestone is wrong without lands now', () => {
  const verdict = parseScopeChange('SCOPE: it must not overwrite files\nWHEN: now\nRefuse to overwrite | run twice, second is refused');

  assert.equal(verdict.kind === 'scope' && verdict.placement, 'now');
});

test('placement defaults to later when it says nothing useful', () => {
  // Interrupting the current milestone is the more disruptive of the two, so it has
  // to be asked for rather than assumed.
  const verdict = parseScopeChange('SCOPE: something new\nAdd the thing | check the thing');

  assert.equal(verdict.kind === 'scope' && verdict.placement, 'later');
});

test('a scope change with no steps is not a scope change', () => {
  // A kickback that stops the build, opens a sign-off gate and then has nothing to
  // add is pure ceremony — worse than the silence it replaced, because it trains
  // people to click through the gate.
  assert.deepEqual(parseScopeChange('SCOPE: something vague\nWHEN: now'), { kind: 'correction' });
});

test('anything unparseable is treated as a correction', () => {
  // The safe default: folding a scope change in as a correction loses a sign-off,
  // while stopping the build over a garbled reply loses the run.
  assert.deepEqual(parseScopeChange('I think maybe you should consider'), { kind: 'correction' });
  assert.deepEqual(parseScopeChange(''), { kind: 'correction' });
});
