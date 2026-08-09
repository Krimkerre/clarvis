import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mayBeSpoken, SpeechOccasion } from './speechScope';

test('briefings, completions and chat replies may be spoken', () => {
  assert.equal(mayBeSpoken('briefing'), true);
  assert.equal(mayBeSpoken('completion'), true);
  // Solicited: an answer to a question you just typed cannot surprise you, which is
  // the only thing this scope exists to prevent.
  assert.equal(mayBeSpoken('chatReply'), true);
});

test('quips and pattern hits are spoken too', () => {
  // Reversed at M8a. Volume is controlled by the §6 interruption budget — how often
  // he surfaces at all — not by muting the funny half of what he says.
  assert.equal(mayBeSpoken('quip'), true);
  assert.equal(mayBeSpoken('patternHit'), true);
});

test('everything he says can be spoken', () => {
  const all: SpeechOccasion[] = ['briefing', 'completion', 'chatReply', 'quip', 'patternHit'];

  assert.deepEqual(all.filter(mayBeSpoken), all);
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

import { playerCandidates } from './nativePlayer';

test('each platform has a headless player', () => {
  // "Headless" is the requirement: no window, no dock icon, no stolen focus.
  assert.equal(playerCandidates('darwin')[0].command, 'afplay');
  assert.equal(playerCandidates('win32')[0].command, 'powershell');
  assert.ok(playerCandidates('linux').length > 1, 'linux audio needs fallbacks');
});

test('the windows player runs hidden', () => {
  const args = playerCandidates('win32')[0].args('C:/tmp/a.mp3').join(' ');

  assert.match(args, /-WindowStyle Hidden/);
});

test('ffplay is invoked without a display window', () => {
  const linux = playerCandidates('linux');
  const ffplay = linux.find((c) => c.command === 'ffplay')!;

  assert.ok(ffplay.args('a.mp3').includes('-nodisp'));
  assert.ok(ffplay.args('a.mp3').includes('-autoexit'), 'must exit so playback end is detectable');
});

test('the file path reaches every player', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
    for (const candidate of playerCandidates(platform)) {
      assert.ok(candidate.args('/tmp/x.mp3').join(' ').includes('/tmp/x.mp3'));
    }
  }
});

import { ENGINES, isKnownEngine } from './enginePicker';

test('engine ids are the documented Fish Audio model header values', () => {
  const ids = ENGINES.map((e) => e.id);

  assert.ok(ids.includes('s2.1-pro-free'));
  assert.ok(ids.includes('s2.1-pro'));
  assert.ok(ids.includes('s2-pro'));
});

test('the default engine is one of the offered engines', () => {
  // A default that isn't in the list would warn on every startup.
  assert.equal(isKnownEngine('s2.1-pro-free'), true);
});

test('a retired engine is recognised as unknown', () => {
  assert.equal(isKnownEngine('s0-ancient'), false);
});

test('every engine explains its tradeoff, not just its name', () => {
  // "s1 vs s1-mini" is meaningless on its own.
  for (const engine of ENGINES) {
    assert.ok(engine.detail.length > 30, `${engine.id} needs a real description`);
  }
});

import { resolveVoiceId, DEFAULT_CURATED_ID, CURATED_VOICES } from './curatedVoices';

test('the curated placeholder resolves to a real voice id', () => {
  // Left unresolved, 'curated:default' would be sent to the API as a literal string.
  assert.equal(resolveVoiceId('curated:default'), DEFAULT_CURATED_ID);
  assert.match(DEFAULT_CURATED_ID, /^[0-9a-f]{16,}$/);
});

test('an explicit fish voice wins over the curated default', () => {
  assert.equal(resolveVoiceId('fish:abc123'), 'abc123');
});

test('the system voice resolves to no fish id at all', () => {
  assert.equal(resolveVoiceId('system'), undefined);
  assert.equal(resolveVoiceId('nonsense'), undefined);
});

test('curated voices are described by sound, never by character', () => {
  // §4.4: qualities are shippable, a named likeness is not.
  const forbidden = /rick|sanchez|morty|character|sounds like/i;

  for (const voice of CURATED_VOICES) {
    assert.ok(!forbidden.test(voice.label), `label names something: ${voice.label}`);
    assert.ok(!forbidden.test(voice.detail), `detail names something: ${voice.detail}`);
  }
});

import { readSavedVoices, withSavedVoice } from './savedVoices';

test('malformed saved-voice entries are dropped, not fatal', () => {
  // The setting is hand-editable, so one bad line must not empty the picker.
  const saved = readSavedVoices({ Gravel: 'abc123', Broken: 42, '': 'xyz', Blank: '  ' });

  assert.deepEqual(saved, [{ name: 'Gravel', id: 'abc123' }]);
  assert.deepEqual(readSavedVoices(undefined), []);
  assert.deepEqual(readSavedVoices(['abc']), []);
});

test('re-saving a known voice renames it instead of duplicating it', () => {
  const existing = [{ name: 'Gravel', id: 'abc123' }];

  assert.deepEqual(withSavedVoice(existing, 'Narrator', 'abc123'), { Narrator: 'abc123' });
  assert.deepEqual(withSavedVoice(existing, ' Second ', 'def456'), {
    Gravel: 'abc123',
    Second: 'def456',
  });
});

import { speakable } from './speakable';

test('an outcome notice reads as a sentence, not a log line', () => {
  // "(probe-build-ok, 2s)" is good to look at and terrible to hear: the brackets
  // become a pause with no cause and "2s" is read as "two ess".
  assert.equal(
    speakable('Finished. Red, I\'m afraid. (probe-build-fail, 2s)'),
    "Finished. Red, I'm afraid. probe-build-fail took 2 seconds."
  );
});

test('durations are spoken as words, with the right plural', () => {
  assert.equal(speakable('It took 1s.'), 'It took 1 second.');
  assert.equal(speakable('It took 45s.'), 'It took 45 seconds.');
  assert.equal(speakable('It took 4.2s.'), 'It took 4.2 seconds.');
  assert.equal(speakable('It took 2m 5s.'), 'It took 2 minutes and 5 seconds.');
  assert.equal(speakable('It took 1m 1s.'), 'It took 1 minute and 1 second.');
  assert.equal(speakable('It took 150ms.'), 'It took 150 milliseconds.');
});

test('inline code markers are never read aloud', () => {
  // The transcript renders these as <code>; spoken, "backtick npm test backtick"
  // is the single fastest way to sound like a machine.
  assert.equal(speakable('`npm test` is still broken.'), 'npm test is still broken.');
});

test('mid-sentence brackets keep their words', () => {
  assert.equal(
    speakable('Branch main (3 files dirty) as of now.'),
    'Branch main, 3 files dirty, as of now.'
  );
});
