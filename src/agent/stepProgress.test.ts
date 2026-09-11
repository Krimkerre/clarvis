import test from 'node:test';
import assert from 'node:assert/strict';
import { announcesStep, matchStep, readStepMarkers } from './stepProgress';

test('a marker is found and removed from the text', () => {
  const { announced, text } = readStepMarkers('STEP: Create the entry point\nWriting main.py now.');

  assert.deepEqual(announced, ['Create the entry point']);
  assert.equal(text.trim(), 'Writing main.py now.');
});

test('text with no marker comes back untouched', () => {
  // The common case by a wide margin, and the one that must not be disturbed.
  const original = 'Reading the plan before I touch anything.';
  assert.deepEqual(readStepMarkers(original), { announced: [], text: original });
});

test('several markers in one fragment are all found, in order', () => {
  const { announced } = readStepMarkers('STEP: One\ndid it\nSTEP: Two\ndid that too');
  assert.deepEqual(announced, ['One', 'Two']);
});

test('a marker mid-sentence is not one', () => {
  // "the next STEP: work out the format" is prose, not an announcement. Only a line
  // of its own counts, or ordinary writing starts moving the progress bar.
  const { announced } = readStepMarkers('I will explain the next STEP: work out the format');
  assert.deepEqual(announced, []);
});

test('an announcement matches its step exactly', () => {
  assert.equal(matchStep('Read EXIF dates', ['Create the entry point', 'Read EXIF dates']), 1);
});

test('a reworded announcement still matches', () => {
  // Models drop a trailing clause or swap an article; an exact match would find
  // nothing the moment they did.
  assert.equal(matchStep('create the CLI entry point.', ['Create the CLI entry point that takes a filename']), 0);
});

test('an announcement matching nothing moves nothing', () => {
  // A wrong match puts the bar on the wrong step, which is worse than not moving it.
  assert.equal(matchStep('Deploy to production', ['Create the entry point', 'Read EXIF dates']), undefined);
  assert.equal(matchStep('   ', ['Create the entry point']), undefined);
});

test('a reply that announced a step and did nothing is told apart from a finished one', () => {
  // Found live, 11 September 2026: "continue building" got back just the STEP line, and
  // later the STEP line with its check and result copied out of plan.md. Both ended the
  // run as though the work were done.
  assert.equal(announcesStep('STEP: Add a label showing the timer state'), true);
  assert.equal(
    announcesStep('STEP: Create a tkinter window\n- Check: Run the script; a window appears.\n- Result: not run yet'),
    true
  );
  assert.equal(announcesStep('Added the label and ran the check.'), false);
  assert.equal(announcesStep(''), false);
});
