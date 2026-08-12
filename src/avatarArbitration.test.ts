import test from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_SOURCES, MIN_DWELL_MS, wins } from './avatarArbitration';

test('a run outranks everything else on screen', () => {
  // The case this exists for: a background build finishes three seconds into a
  // five-minute run and its reaction wipes the expression of the work being watched.
  assert.equal(wins('watch', 'agent'), false);
  assert.equal(wins('chat', 'agent'), false);
  assert.equal(wins('agent', 'chat'), true);
});

test('a reply outranks the watcher, and the watcher outranks nothing', () => {
  assert.equal(wins('chat', 'watch'), true);
  assert.equal(wins('watch', 'chat'), false);
  assert.equal(wins('watch', 'idle'), true);
});

test('a source may always update its own expression', () => {
  // Equal rank has to win. A run goes thinking → talking → neutral, and treating its
  // own second write as a fight would freeze the face on the first one.
  for (const source of AVATAR_SOURCES) assert.equal(wins(source, source), true, source);
});

test('the dwell floor is long enough to see and short enough not to lag', () => {
  assert.ok(MIN_DWELL_MS >= 500 && MIN_DWELL_MS <= 1500);
});
