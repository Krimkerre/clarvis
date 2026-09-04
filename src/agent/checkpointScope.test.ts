import test from 'node:test';
import assert from 'node:assert/strict';
import { NO_WORKSPACE, scopeFor } from './checkpointScope';

test('two windows on two projects never share a checkpoint directory', () => {
  // The bug this exists for: one directory, one record, and `begin()` clearing
  // the store at the start of every run — so a run in the second window
  // destroyed the first window's undo without saying anything.
  assert.notEqual(scopeFor('/Users/someone/projects/alpha'), scopeFor('/Users/someone/projects/beta'));
});

test('the same workspace gets the same directory across restarts', () => {
  // Stability is the only property the store needs: undo has to find the copies
  // the run that made them wrote, and that run may have been before a reload.
  assert.equal(scopeFor('/Users/someone/projects/alpha'), scopeFor('/Users/someone/projects/alpha'));
});

test('a window with no folder open is a place, not an empty string', () => {
  assert.equal(scopeFor(undefined), NO_WORKSPACE);
  assert.equal(scopeFor(''), NO_WORKSPACE);
});

test('the name is safe to use as a directory on any filesystem', () => {
  // A workspace root may hold spaces, colons, quotes and non-ASCII; a path
  // component may not, on at least one platform each.
  const awkward = '/Users/someone/Projects/"My Stuff": v2 — final/ünïcode';
  assert.match(scopeFor(awkward), /^[0-9a-f]{16}$/);
});

test('a very long root does not become a very long directory name', () => {
  // Path components have a length limit; roots do not.
  assert.equal(scopeFor('/' + 'nested/'.repeat(200)).length, 16);
});

test('the workspace path is not recoverable from the directory name', () => {
  // A hash rather than the path itself: the store lives outside the workspace,
  // and writing the project's location into a second place is a disclosure
  // nobody asked for.
  const root = '/Users/someone/Projects/secret-client-work';
  assert.equal(scopeFor(root).includes('secret'), false);
  assert.equal(scopeFor(root).includes('Users'), false);
});
