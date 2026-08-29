import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import { fallbackLogLine, fallbackNotice, fishUnavailableReason } from './fallbackNotice';

test('a missing key is named as a missing key', () => {
  assert.match(fishUnavailableReason(false, true), /no Fish Audio key is stored/);
});

test('a spent cap is named as a spent cap', () => {
  assert.match(fishUnavailableReason(true, false), /cap is used up/);
});

test('no key beats a spent cap', () => {
  // Without a key the cap has never been consumed, so reporting the cap would be
  // both wrong and unactionable — it would send somebody to raise a limit that
  // is not the reason they are hearing the wrong voice.
  assert.match(fishUnavailableReason(false, false), /no Fish Audio key/);
});

test('a provider that can be used says nothing', () => {
  assert.equal(fishUnavailableReason(true, true), '');
});

test('the notice carries the reason, not a restatement of the symptom', () => {
  // The old text was "the preferred voice is unavailable", which told somebody
  // nothing they had not already worked out from hearing the wrong voice.
  const notice = fallbackNotice('no Fish Audio key is stored for this editor', 'fishAudio');

  assert.match(notice, /no Fish Audio key is stored for this editor/);
  assert.match(notice, /system voice/);
});

test('a provider that threw still produces a sentence', () => {
  // `unavailableReason` is optional and a throw yields no reason at all, so the
  // notice must not come out as "Clarvis: , so I'm using the system voice".
  const notice = fallbackNotice('', 'fishAudio');

  assert.match(notice, /the fishAudio voice is unavailable/);
  assert.doesNotMatch(notice, /: ,/);
});

test('the log line names the provider and the reason', () => {
  assert.equal(
    fallbackLogLine('fishAudio', 'no Fish Audio key is stored for this editor'),
    'voice: fishAudio is unavailable (no Fish Audio key is stored for this editor); using the system voice'
  );
});

test('the log line omits an empty reason rather than printing empty brackets', () => {
  assert.equal(fallbackLogLine('fishAudio', ''), 'voice: fishAudio is unavailable; using the system voice');
});

test('the unavailable branch is not empty any more', () => {
  // The whole defect: `isAvailable()` returning false fell through to the system
  // voice with no log and no message, because only a *throw* was handled. This
  // reads the source because the branch itself lives in a file that imports
  // `vscode` and cannot be reached from here — which is the same reason the
  // decision above was extracted in the first place.
  const root = findRepoRoot(__dirname);
  const source = fs.readFileSync(path.join(root, 'src', 'voice', 'VoiceService.ts'), 'utf8');
  const branch = source.slice(
    source.indexOf('if (await this.primary.isAvailable())'),
    source.indexOf('} catch (error) {', source.indexOf('if (await this.primary.isAvailable())'))
  );

  assert.ok(branch.includes('explainUnavailable'), 'declining silently again');
});

function findRepoRoot(start: string): string {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('no package.json above ' + start);
    current = parent;
  }
}
