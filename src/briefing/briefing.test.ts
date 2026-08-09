import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecentFiles } from './recentFiles';
import { foldOutcome, activeFailure, parseRecord, FAILURE_TTL_MS } from './lastFailure';
import { buildBriefingLines } from './briefingLines';
import type { Outcome } from '../watch/BusyTracker';

function outcome(overrides: Partial<Outcome> = {}): Outcome {
  return { id: 'a', source: 'task', label: 'npm test', exitCode: 1, durationMs: 5000, ...overrides };
}

// ---------------------------------------------------------------- recent files

test('lists most recently saved first', () => {
  const files = new RecentFiles();
  files.record('a.ts');
  files.record('b.ts');

  assert.deepEqual(files.list(), ['b.ts', 'a.ts']);
});

test('caps at capacity, dropping the oldest', () => {
  const files = new RecentFiles(3);
  ['a', 'b', 'c', 'd'].forEach((f) => files.record(f));

  assert.deepEqual(files.list(), ['d', 'c', 'b']);
});

test('re-saving a file moves it up instead of duplicating it', () => {
  // Saving one file repeatedly while debugging must not erase the memory of the others.
  const files = new RecentFiles(3);
  ['a', 'b', 'c'].forEach((f) => files.record(f));
  files.record('a');

  assert.deepEqual(files.list(), ['a', 'c', 'b']);
});

// ---------------------------------------------------------------- last failure

test('records a failure', () => {
  const next = foldOutcome(undefined, outcome({ exitCode: 1 }), 1000);

  assert.equal(next?.label, 'npm test');
  assert.equal(next?.exitCode, 1);
});

test('a later failure replaces an earlier one', () => {
  const first = foldOutcome(undefined, outcome({ label: 'npm test' }), 1000);
  const second = foldOutcome(first, outcome({ label: 'npm run build' }), 2000);

  assert.equal(second?.label, 'npm run build');
});

test('success on the same job clears the record', () => {
  // The dropped thread is no longer dropped.
  const failed = foldOutcome(undefined, outcome({ label: 'npm test', exitCode: 1 }), 1000);
  const fixed = foldOutcome(failed, outcome({ label: 'npm test', exitCode: 0 }), 2000);

  assert.equal(fixed, undefined);
});

test('success on a different job leaves the record alone', () => {
  // Lint passing says nothing about the test suite still being red.
  const failed = foldOutcome(undefined, outcome({ label: 'npm test', exitCode: 1 }), 1000);
  const unrelated = foldOutcome(failed, outcome({ label: 'npm run lint', exitCode: 0 }), 2000);

  assert.equal(unrelated?.label, 'npm test');
});

test('a cancelled job counts as unfinished, not as success', () => {
  const next = foldOutcome(undefined, outcome({ exitCode: undefined }), 1000);

  assert.equal(next?.label, 'npm test');
  assert.equal(next?.exitCode, undefined);
});

test('a failure older than the TTL is no longer reported', () => {
  const record = { label: 'npm test', exitCode: 1, at: 0 };

  assert.ok(activeFailure(record, FAILURE_TTL_MS - 1));
  assert.equal(activeFailure(record, FAILURE_TTL_MS + 1), undefined);
});

test('malformed persisted state is treated as absent', () => {
  // workspaceState survives crashes and version changes; it isn't automatically trusted.
  assert.equal(parseRecord(undefined), undefined);
  assert.equal(parseRecord('a string'), undefined);
  assert.equal(parseRecord({ label: 'x' }), undefined, 'missing timestamp');
  assert.equal(parseRecord({ at: 1 }), undefined, 'missing label');
  assert.ok(parseRecord({ label: 'npm test', at: 1, exitCode: 1 }));
});

// ---------------------------------------------------------------- lines

test('omits lines it has no facts for', () => {
  const lines = buildBriefingLines({ recentFiles: [] });

  assert.deepEqual(lines, [], 'a fresh window with no history says nothing at all');
});

test('reports branch and dirty count, with correct pluralisation', () => {
  assert.match(
    buildBriefingLines({ git: { branch: 'main', dirtyCount: 1 }, recentFiles: [] })[0],
    /1 file dirty/
  );
  assert.match(
    buildBriefingLines({ git: { branch: 'main', dirtyCount: 3 }, recentFiles: [] })[0],
    /3 files dirty/
  );
  assert.match(
    buildBriefingLines({ git: { branch: 'main', dirtyCount: 0 }, recentFiles: [] })[0],
    /clean/
  );
});

test('shows file names, not full paths', () => {
  const lines = buildBriefingLines({ recentFiles: ['/a/b/checkout.ts', '/a/b/cart.ts'] });

  assert.match(lines[0], /checkout\.ts/);
  assert.ok(!lines[0].includes('/a/b/'), 'paths are noise in a one-line summary');
});

test('distinguishes a failed job from an unfinished one', () => {
  const failed = buildBriefingLines({
    failure: { label: 'npm test', exitCode: 1, at: 0 },
    recentFiles: [],
  })[0];
  const cancelled = buildBriefingLines({
    failure: { label: 'npm test', exitCode: undefined, at: 0 },
    recentFiles: [],
  })[0];

  assert.notEqual(failed, cancelled, 'calling a cancelled job "red" would be a lie');
});

test('caps at four lines', () => {
  const lines = buildBriefingLines({
    git: { branch: 'main', dirtyCount: 2 },
    failure: { label: 'npm test', exitCode: 1, at: 0 },
    recentFiles: ['a.ts', 'b.ts'],
    patternHint: 'Seen this three times this week.',
  });

  assert.equal(lines.length, 4);
});

test('restores a previous session, still newest-first and capped', () => {
  // The briefing reads this before anything has been saved this session, so the
  // restored list is the entire point.
  const files = new RecentFiles(3, ['b.ts', 'a.ts']);
  files.record('c.ts');

  assert.deepEqual(files.list(), ['c.ts', 'b.ts', 'a.ts']);
});

test('restoring more than capacity truncates', () => {
  const files = new RecentFiles(2, ['a', 'b', 'c', 'd']);

  assert.deepEqual(files.list(), ['a', 'b']);
});
