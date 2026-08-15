import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunRecord, explainStep, renderRunSummary } from './runLedger';

const events = [
  { kind: 'text' as const, text: 'Reading the failing test to see what it expects.' },
  { kind: 'tool' as const, text: 'Reading app.test.ts', detail: 'readFile: src/app.test.ts', step: 1 },
  { kind: 'text' as const, text: 'The test wants a trailing slash stripped before comparing.' },
  { kind: 'tool' as const, text: 'Editing app.ts', detail: 'applyEdit: src/app.ts', step: 2 },
  { kind: 'text' as const, text: 'Running the suite to confirm.' },
  { kind: 'tool' as const, text: 'Running npm test', detail: 'runCommand: npm test', step: 3 },
  { kind: 'done' as const, text: 'Fixed the trailing-slash comparison in app.ts; tests pass.' },
];

test('narration attaches to the step that follows it, not the one it arrived with', () => {
  const record = buildRunRecord('fix the failing test', 0, events);

  assert.equal(record.steps[0].narration, 'Reading the failing test to see what it expects.');
  assert.equal(record.steps[1].narration, 'The test wants a trailing slash stripped before comparing.');
});

test('the closing text becomes the result, not a step narration', () => {
  const record = buildRunRecord('fix the failing test', 0, events);

  assert.equal(record.result, 'Fixed the trailing-slash comparison in app.ts; tests pass.');
  assert.equal(record.steps.length, 3);
});

test('a declined step is marked, not dropped', () => {
  // "asked to, was told no" is itself an answer to "why didn't you" — it belongs in
  // the record.
  const withDecline = [
    ...events.slice(0, 4),
    { kind: 'tool' as const, text: 'Running npm publish', detail: 'runCommand: npm publish', step: 3 },
    { kind: 'gate' as const, text: 'Skipped: Running npm publish' },
  ];
  const record = buildRunRecord('x', 0, withDecline);

  assert.equal(record.steps[2].declined, true);
  assert.equal(record.steps[2].action, 'runCommand: npm publish');
  // And the step before it, the one actually approved, stays untouched.
  assert.equal(record.steps[1].declined, false);
});

test('files changed is deduplicated, in first-touched order', () => {
  const twoEdits = [
    { kind: 'tool' as const, text: 'Editing app.ts', detail: 'applyEdit: src/app.ts', step: 1 },
    { kind: 'tool' as const, text: 'Editing app.ts again', detail: 'applyEdit: src/app.ts', step: 2 },
    { kind: 'tool' as const, text: 'Writing new.ts', detail: 'writeFile: src/new.ts', step: 3 },
  ];
  const record = buildRunRecord('x', 0, twoEdits);

  assert.deepEqual(record.filesChanged, ['src/app.ts', 'src/new.ts']);
});

test('a command step has no file — "npm test" is not a path', () => {
  const record = buildRunRecord('x', 0, events);

  assert.equal(record.steps[2].file, undefined);
  assert.equal(record.steps[2].action, 'runCommand: npm test');
});

test('a read-only file is not counted as "changed"', () => {
  // Files changed means written to, per the review's own field name — a file only
  // read still shows up on the step that read it, just not in this list.
  const record = buildRunRecord('x', 0, events);

  assert.deepEqual(record.filesChanged, ['src/app.ts']);
  assert.equal(record.steps[0].file, 'src/app.test.ts');
});

test('explainStep matches by file, most recent first', () => {
  const record = buildRunRecord('x', 0, events);
  const step = explainStep(record, 'app.ts');

  assert.equal(step?.narration, 'The test wants a trailing slash stripped before comparing.');
});

test('explainStep matches by command text when there is no file', () => {
  const record = buildRunRecord('x', 0, events);
  const step = explainStep(record, 'npm test');

  assert.equal(step?.narration, 'Running the suite to confirm.');
});

test('explainStep finds nothing for an unrelated question, rather than guessing', () => {
  const record = buildRunRecord('x', 0, events);

  assert.equal(explainStep(record, 'package.json'), undefined);
});

test('the summary names every field the review asked for', () => {
  const record = buildRunRecord('fix the failing test', Date.now(), events);
  const summary = renderRunSummary(record);

  assert.match(summary, /## Intent/);
  assert.match(summary, /## Files changed/);
  assert.match(summary, /## Steps/);
  assert.match(summary, /## Result/);
  assert.match(summary, /## Remaining concern/);
  assert.match(summary, /src\/app\.ts/);
  assert.match(summary, /Fixed the trailing-slash/);
});

test('a run with nothing declined and something changed has no invented concern', () => {
  // Inventing a worry when there is none is the fabricated-confidence rule (§2 rule 6)
  // applied to this feature specifically.
  const record = buildRunRecord('x', 0, events);
  const summary = renderRunSummary(record);

  assert.match(summary, /None recorded\./);
});

test('a run that declined something says so as the remaining concern', () => {
  const withDecline = [
    ...events.slice(0, 4),
    { kind: 'tool' as const, text: 'Running npm publish', detail: 'runCommand: npm publish', step: 3 },
    { kind: 'gate' as const, text: 'Skipped: Running npm publish' },
  ];
  const record = buildRunRecord('x', 0, withDecline);
  const summary = renderRunSummary(record);

  assert.match(summary, /1 step\(s\) were declined/);
});

test('an empty run says so rather than rendering a blank section', () => {
  const record = buildRunRecord('do nothing much', 0, []);
  const summary = renderRunSummary(record);

  assert.match(summary, /none — nothing was touched/);
  assert.match(summary, /the run ended with nothing said/);
});
