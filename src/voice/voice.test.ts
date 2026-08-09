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

import { cacheKey, selectForEviction, CACHE_LIMIT_BYTES } from './voiceCache';

test('the same utterance caches to one key', () => {
  assert.equal(cacheKey('hello', 'v1', 's1'), cacheKey('hello', 'v1', 's1'));
});

test('changing voice or engine is a different cache entry', () => {
  // Otherwise switching either appears to do nothing, because the old audio replays.
  const base = cacheKey('hello', 'v1', 's1');

  assert.notEqual(base, cacheKey('hello', 'v2', 's1'), 'voice must affect the key');
  assert.notEqual(base, cacheKey('hello', 'v1', 's2.1-pro'), 'engine must affect the key');
  assert.notEqual(base, cacheKey('goodbye', 'v1', 's1'), 'text must affect the key');
});

test('a cache under the limit evicts nothing', () => {
  const entries = [{ key: 'a', bytes: 10, lastUsed: 1 }];

  assert.deepEqual(selectForEviction(entries, 100), []);
});

test('eviction removes least-recently-used first, and only enough to fit', () => {
  const entries = [
    { key: 'old', bytes: 60, lastUsed: 1 },
    { key: 'mid', bytes: 60, lastUsed: 2 },
    { key: 'new', bytes: 60, lastUsed: 3 },
  ];

  assert.deepEqual(selectForEviction(entries, 130), ['old'], 'stops as soon as it fits');
});

test('the cache limit is a real number, not accidentally zero', () => {
  assert.ok(CACHE_LIMIT_BYTES > 1024 * 1024);
});
