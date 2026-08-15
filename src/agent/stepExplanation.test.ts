import test from 'node:test';
import assert from 'node:assert/strict';
import { explainStep } from './stepExplanation';

test('a step says what it does, not what the tool is called', () => {
  // Found live: the approval prompt carried `runCommand: python3 -m pip install
  // pillow` and nothing else, so answering it required already knowing the answer.
  const step = explainStep('runCommand', { command: 'python3 -m pip install pillow' });

  assert.doesNotMatch(step.what, /runCommand/);
  assert.match(step.what, /project folder/);
  assert.equal(step.exact, 'python3 -m pip install pillow');
});

test('writing a file says it replaces an existing one', () => {
  // The difference between "creates" and "replaces whatever was there" is the whole
  // reason someone would answer no.
  const step = explainStep('writeFile', { path: 'src/rename.py' });

  assert.match(step.what, /replaces it completely/);
  assert.match(step.title, /src\/rename\.py/);
});

test('an edit and a write both promise the snapshot', () => {
  for (const name of ['writeFile', 'applyEdit']) {
    assert.match(explainStep(name, { path: 'a.ts' }).what, /snapshot/, name);
  }
});

test('a command does not claim to be undoable', () => {
  // The checkpoint covers files. A command can install something or write to a cache
  // outside the snapshot, and "undoable" would be the reassuring half of the truth.
  const step = explainStep('runCommand', { command: 'npm install' });

  assert.doesNotMatch(step.what, /Undoable/);
  assert.match(step.what, /is not/);
});

test('a tool with no entry is admitted to rather than dressed up', () => {
  const step = explainStep('summonBadger', {});

  assert.equal(step.title, 'summonBadger');
  assert.match(step.what, /can't describe/);
});

test('a missing argument does not produce "undefined" in the sentence', () => {
  for (const name of ['writeFile', 'applyEdit', 'runCommand', 'search']) {
    const step = explainStep(name, {});
    assert.doesNotMatch(step.title, /undefined/, name);
    assert.doesNotMatch(step.what, /undefined/, name);
    assert.equal(step.exact, undefined, name);
  }
});
