import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDefaultInput, defaultInputDevice } from './defaultInput';

/** Trimmed from this machine's real `system_profiler SPAudioDataType`. */
const REAL = `
    Devices:

        BlackHole 2ch:

          Current SampleRate: 48000
          Transport: Virtual
          Input Source: Default
          Output Source: Default

        MacBook Air Microphone:

          Default Input Device: Yes
          Input Channels: 1
          Manufacturer: Apple Inc.
          Current SampleRate: 48000

        MacBook Air Speakers:

          Default Output Device: Yes
          Default System Output Device: Yes
`;

test('names the device whose block claims the default input', () => {
  // The marker sits *inside* a block rather than at the top, so the name has to
  // be found by walking back to the heading it belongs to.
  assert.equal(parseDefaultInput(REAL), 'MacBook Air Microphone');
});

test('is not fooled by a virtual device listed first', () => {
  // The whole hazard: BlackHole is index 0 in ffmpeg's enumeration and appears
  // above the microphone here. Taking the first block, or the first heading,
  // would name it — and a silent recording would then be blamed on the wrong
  // device.
  assert.notEqual(parseDefaultInput(REAL), 'BlackHole 2ch');
});

test('a default *output* marker does not name an input', () => {
  // `Default Output Device: Yes` sits in the speakers block. Matching loosely on
  // "Default" would report speakers as the microphone, which is worse than
  // saying nothing.
  const outputOnly = REAL.replace('Default Input Device: Yes', 'Input Channels: 1');
  assert.equal(parseDefaultInput(outputOnly), '');
});

test('says nothing when there is nothing to say', () => {
  assert.equal(parseDefaultInput(''), '');
  assert.equal(parseDefaultInput('Devices:\n  no audio hardware\n'), '');
});

test('a marker with no heading above it yields nothing rather than a guess', () => {
  assert.equal(parseDefaultInput('Default Input Device: Yes\n'), '');
});

test('non-macOS reports nothing rather than shelling out', async () => {
  // `system_profiler` is macOS-only, and the `:default` hazard this exists for
  // was measured there. Elsewhere the probe keeps its original wording.
  let ran = false;
  const spy = (() => {
    ran = true;
  }) as unknown as Parameters<typeof defaultInputDevice>[1];

  assert.equal(await defaultInputDevice('linux', spy), '');
  assert.equal(ran, false);
});

test('a failing system_profiler degrades to nothing, not to a throw', async () => {
  // This runs inside a debug command whose job is to report; a diagnostic that
  // dies while diagnosing tells you less than one that says "could not tell".
  const failing = ((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    done: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    done(new Error('spawn failed'), '', '');
  }) as unknown as Parameters<typeof defaultInputDevice>[1];

  assert.equal(await defaultInputDevice('darwin', failing), '');
});

test('reads the name out of a successful call', async () => {
  const ok = ((
    _cmd: string,
    _args: string[],
    _opts: unknown,
    done: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    done(null, REAL, '');
  }) as unknown as Parameters<typeof defaultInputDevice>[1];

  assert.equal(await defaultInputDevice('darwin', ok), 'MacBook Air Microphone');
});
