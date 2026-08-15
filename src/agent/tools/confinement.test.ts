import test from 'node:test';
import assert from 'node:assert/strict';
import { confinementNote } from './confinement';

const BREW = `Error: Could not symlink bin/go
/opt/homebrew/bin is not writable.
You should change the ownership: sudo chown -R mathias /opt/homebrew`;

test('a confined command denied a write is told the sandbox did it', () => {
  // The live failure this exists for: Homebrew described a working install as broken,
  // and Clarvis passed on `sudo chown -R /opt/homebrew` as if it were the diagnosis.
  const note = confinementNote(true, 1, BREW);

  assert.ok(note);
  assert.match(note, /confined/);
  assert.match(note, /sudo/);
});

test('an ordinary failure gets no note', () => {
  // A note on every failure teaches the model to blame the sandbox for its own bugs.
  assert.equal(confinementNote(true, 1, 'FAIL src/app.test.ts — expected 2, got 3'), undefined);
});

test('nothing is said when the command was not confined', () => {
  // Unconfined, the tool's diagnosis is the real one and should be relayed.
  assert.equal(confinementNote(false, 1, BREW), undefined);
});

test('a command that worked is left alone', () => {
  assert.equal(confinementNote(true, 0, BREW), undefined);
});

test('a killed command with a denial still gets the note', () => {
  // No exit code means killed or timed out, which is not success.
  assert.ok(confinementNote(true, undefined, 'mkdir: /usr/local/lib: Operation not permitted'));
});
