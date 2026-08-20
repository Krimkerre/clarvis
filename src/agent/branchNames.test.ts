import test from 'node:test';
import assert from 'node:assert/strict';
import { isRealBase } from './branchNames';

// F10's second edge: a brand-new repository (git init, zero commits) reports HEAD as
// "master" even though nothing has ever been committed there — an unborn ref, not a
// real place to fold work back into.

test('an ordinary branch with real commits is a real base', () => {
  assert.equal(isRealBase('main', false), true);
});

test('an unborn HEAD is never a real base, whatever it is named', () => {
  assert.equal(isRealBase('master', true), false);
});

test('an agent branch is never a real base, born or not', () => {
  assert.equal(isRealBase('clarvis/some-task', false), false);
});
