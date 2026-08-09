import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayBeSpoken, SpeechOccasion } from './speechScope';

test('briefings and completions may be spoken', () => {
  assert.equal(mayBeSpoken('briefing'), true);
  assert.equal(mayBeSpoken('completion'), true);
});

test('quips never speak', () => {
  // §4.4, and not a soft preference: a voice heckling from the sidebar is the fastest
  // route to someone disabling voice permanently.
  assert.equal(mayBeSpoken('quip'), false);
});

test('pattern hits never speak', () => {
  assert.equal(mayBeSpoken('patternHit'), false);
});

test('the spoken set is exactly two occasions', () => {
  // Guards against a future occasion being added and silently inheriting speech.
  const all: SpeechOccasion[] = ['briefing', 'completion', 'quip', 'patternHit'];
  const spoken = all.filter(mayBeSpoken);

  assert.deepEqual(spoken, ['briefing', 'completion']);
});
