import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headline } from '../headline';

test('the last substantial line is what gets spoken', () => {
  // The model narrates as it goes and summarises at the end, so the summary is at the
  // bottom — and the summary is the only sentence anyone is waiting for.
  const narration = [
    'Right, let me have a look at that.',
    'Found the comment on the first line.',
    'Changed the comment to dubbawubbalublub in plan.md.',
  ].join('\n');

  assert.equal(headline(narration), 'Changed the comment to dubbawubbalublub in plan.md.');
});

test('the branch note is not the result', () => {
  // "Your own work on master is untouched" is machinery, and it is also the literal
  // last line of every run — so a naive "speak the last line" would say it every time.
  const narration = [
    'Created a new milestone/1 branch off master, and recorded it in plan.md.',
    '',
    "Your own work on `master` is untouched — my changes are on a temp branch.",
  ].join('\n');

  assert.match(headline(narration)!, /milestone\/1/);
});

test('a short reply is still spoken rather than met with silence', () => {
  // "Done." is a poor summary and a worse silence.
  assert.equal(headline('Done.'), 'Done.');
});

test('nothing said means nothing spoken', () => {
  assert.equal(headline(''), undefined);
  assert.equal(headline('\n  \n'), undefined);
  assert.equal(headline('Your own work on `main` is untouched.'), undefined);
});

test('a long summary is cut at a sentence, not mid-word', () => {
  const long = `${'A'.repeat(150)}. ${'B'.repeat(120)}.`;
  const spoken = headline(long)!;

  assert.ok(spoken.length <= 201, spoken.length.toString());
  assert.ok(spoken.endsWith('.') || spoken.endsWith('…'), spoken.slice(-20));
});
