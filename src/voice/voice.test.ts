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

import { peakDbfs, recorderCandidates } from './nativeRecorder';

/**
 * A real 16-bit mono WAV carrying the given samples.
 *
 * **This used to be `Buffer.alloc(44)` followed by the samples, and that is why
 * a live bug went unseen for the life of the file.** A header of 44 zero bytes
 * has no chunk structure to get wrong and contributes nothing to a peak, so a
 * reader that skipped a fixed 44 bytes looked correct against it. The recorder
 * we actually use writes a `LIST`/`INFO` chunk before `data`, putting samples at
 * byte 78 — and the 34 bytes of encoder string in between measured -1.9 dBFS,
 * which `hasAudio` read as "there is audio here" for every file it ever saw.
 *
 * Fixtures that are easier than the real thing test something easier than the
 * real thing.
 */
function wav(samples: number[], extraChunks: Buffer = Buffer.alloc(0)): Buffer {
  const body = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, i) => body.writeInt16LE(sample, i * 2));

  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);

  const data = Buffer.alloc(8);
  data.write('data', 0, 'ascii');
  data.writeUInt32LE(body.length, 4);

  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + fmt.length + extraChunks.length + data.length + body.length, 4);
  riff.write('WAVE', 8, 'ascii');

  return Buffer.concat([riff, fmt, extraChunks, data, body]);
}

/**
 * The `LIST`/`INFO` chunk ffmpeg writes, holding its own version string.
 *
 * Reproduced byte-for-byte in shape because its *contents* are the hazard: read
 * as int16 they peak at -1.9 dBFS, well above the silence floor.
 */
function ffmpegInfoChunk(encoder = 'Lavf62.12.102'): Buffer {
  const value = Buffer.from(`${encoder}\0`, 'ascii');
  const isft = Buffer.concat([
    Buffer.from('ISFT', 'ascii'),
    (() => {
      const size = Buffer.alloc(4);
      size.writeUInt32LE(value.length, 0);
      return size;
    })(),
    value,
  ]);
  const payload = Buffer.concat([Buffer.from('INFO', 'ascii'), isft]);
  const header = Buffer.alloc(8);
  header.write('LIST', 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test('a silent recording is distinguishable from a real one', () => {
  // The failure this exists to catch: a denied microphone can return a well-formed
  // file full of zeroes and exit 0, so the exit code alone would report success.
  assert.equal(peakDbfs(wav([0, 0, 0, 0])), -Infinity);
  assert.ok(peakDbfs(wav([0, 8000, -12000, 0])) > -20);
});

test('full-scale audio reads as 0 dBFS', () => {
  assert.ok(Math.abs(peakDbfs(wav([32767]))) < 0.01);
});

test('a silent clip from the recorder we actually use still reads as silent', () => {
  // The regression, in the shape that produced it. ffmpeg puts a LIST/INFO chunk
  // between `fmt ` and `data`; skipping a fixed 44 bytes lands inside that chunk
  // and measures the encoder string. Three real probe runs each reported -1.9
  // dBFS — the peak of the text "Lavf62.12.102" — while the audio itself was at
  // -26.9, and `hasAudio` would therefore have called a denied microphone a
  // success.
  const silent = wav([0, 0, 0, 0], ffmpegInfoChunk());

  assert.equal(peakDbfs(silent), -Infinity);
  assert.equal(hasAudio(silent), false);
});

test('real audio is still found behind that chunk', () => {
  const spoken = wav([0, 9000, -11000, 0], ffmpegInfoChunk());

  assert.ok(peakDbfs(spoken) > -20);
  assert.equal(hasAudio(spoken), true);
});

test('bytes after the data chunk are not counted as samples', () => {
  // `data` carries its own length, and a file may hold chunks after it. Reading
  // to the end of the buffer would measure whatever those contain.
  const quiet = wav([0, 0], ffmpegInfoChunk());
  const trailing = Buffer.from('LIST\x04\x00\x00\x00INFO', 'binary');

  assert.equal(peakDbfs(Buffer.concat([quiet, trailing])), -Infinity);
});

test('something that is not a WAV measures nothing rather than guessing', () => {
  // A recorder that failed and left a text error in the file should not produce
  // a confident level from its bytes.
  assert.equal(peakDbfs(Buffer.from('ffmpeg: Input/output error\n', 'ascii')), -Infinity);
  assert.equal(peakDbfs(Buffer.alloc(0)), -Infinity);
});

test('every platform has at least one recorder candidate', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
    assert.ok(recorderCandidates(platform).length > 0, platform);
  }
});

import { hasAudio, SILENCE_FLOOR_DBFS } from './nativeRecorder';

test('a dead input device reads as silence, despite not being digital zero', () => {
  // Measured on a real machine: a virtual/muted device returns samples of ±1, about
  // -90 dBFS. Testing for exact zero misses precisely the case this exists to catch —
  // the first mic probe reported "-90.3 dBFS" as though it were a level, not a failure.
  const deadDevice = wav([1, -1, 1, -1]);

  assert.ok(peakDbfs(deadDevice) < SILENCE_FLOOR_DBFS);
  assert.equal(hasAudio(deadDevice), false);
  assert.equal(hasAudio(wav([0, 6000, -9000])), true);
});

import { installHint, isRecorderMissing } from './nativeRecorder';

test('every platform gets something the user can actually act on', () => {
  // A "not installed" message with no install line is just a dead end.
  for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
    const hint = installHint(platform);

    assert.ok(hint.missing.length > 0, platform);
    assert.ok(hint.command.length > 0, platform);
    assert.ok(hint.note.length > 0, platform);
  }
});

test('a missing recorder is distinguishable from a failed recording', () => {
  // These need different responses: one is an offer to install something, the other
  // is a genuine error. Conflating them means a real fault reads as "go install X".
  assert.equal(isRecorderMissing(new Error('no recorder available')), true);
  assert.equal(isRecorderMissing(new Error('ffmpeg exited 1 (no signal)')), false);
});

test('markdown emphasis becomes a pause, never a spoken asterisk', () => {
  // The complaint this fixes: "**not**" read aloud as "asterisk asterisk not".
  // The author meant a beat, and silence carries emphasis better than a symbol.
  assert.equal(speakable('That is **not** how it works.'), 'That is, not, how it works.');
  assert.equal(speakable('A *small* change.'), 'A, small, change.');
  assert.ok(!speakable('**bold** and *italic* and _under_').includes('*'));
});

test('long emphasised runs are unwrapped without commas', () => {
  // Commas around a whole clause make the delivery stutter.
  assert.equal(
    speakable('*this entire clause is emphasised here*'),
    'this entire clause is emphasised here'
  );
});

test('bullets and headings are pauses, not spoken punctuation', () => {
  const spoken = speakable('## Findings\n- first thing\n- second thing');

  assert.ok(!spoken.includes('#'));
  assert.ok(!spoken.includes('-'));
  assert.match(spoken, /Findings/);
  assert.match(spoken, /first thing/);
});

test('links are spoken as their words, never their URL', () => {
  // "https colon slash slash" is the worst thing TTS can do to a sentence.
  assert.equal(
    speakable('See [the manual](https://example.com/docs/x?y=1) for more.'),
    'See the manual for more.'
  );
});

test('fenced code is dropped rather than read aloud', () => {
  const spoken = speakable('Try this:\n```ts\nconst x = a && b ? c : d;\n```\nThat should do it.');

  assert.ok(!spoken.includes('const'));
  assert.ok(!spoken.includes('&&'));
  assert.match(spoken, /That should do it/);
});

test('table pipes and rules are silent', () => {
  const spoken = speakable('| a | b |\n---\n| 1 | 2 |');

  assert.ok(!spoken.includes('|'));
  assert.ok(!spoken.includes('---'));
});

test('underscores inside identifiers survive', () => {
  // snake_case is not emphasis. Treating it as such would silently rename things
  // in the spoken version of an answer about code.
  assert.equal(speakable('Call some_helper_function next.'), 'Call some_helper_function next.');
});

test('collapsed markup never leaves a stutter of commas', () => {
  const spoken = speakable('**a** *b* **c**');

  assert.ok(!/,\s*,/.test(spoken), spoken);
  assert.ok(!spoken.startsWith(','), spoken);
});

import { renderTimeout } from './renderTimeout';

test('a long line is given longer to render than a short one', () => {
  // Measured: ~900ms for a one-liner, ~5s for a paragraph. A flat ceiling is either
  // too tight for the long one or pointlessly patient with the short one.
  assert.ok(renderTimeout(1400) > renderTimeout(80));
});

test('the reply that actually failed would now be waited for', () => {
  // Found live: a four-paragraph answer aborted at exactly 15s and dropped to the
  // system voice — the one time he had something worth saying at length.
  assert.ok(renderTimeout(1400) > 15_000);
});

test('the wait is bounded however long the text is', () => {
  // Nothing is blocked while we wait, but a minute of silence after a remark is its
  // own kind of broken.
  assert.equal(renderTimeout(100_000), renderTimeout(50_000));
  assert.ok(renderTimeout(100_000) <= 45_000);
});

test('an empty line still gets a real wait', () => {
  // A short line is short text, not zero work: the request still has to go out.
  assert.ok(renderTimeout(0) >= 5_000);
});
