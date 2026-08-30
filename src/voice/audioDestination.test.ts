import assert from 'node:assert/strict';
import test from 'node:test';

import { audioDestination, audioDestinationReason, UI_KIND_WEB } from './audioDestination';

const DESKTOP = 1;

test('desktop VS Code on the local machine plays on the host', () => {
  // The case where the host *is* the listener's machine, and where playing
  // natively is better: no encoding, no round trip, and the player process
  // exiting is the finished signal.
  assert.equal(audioDestination(DESKTOP, undefined), 'host');
});

test('a browser workbench plays through the webview', () => {
  // code-server, a tunnel, github.dev. The extension host is a server and a
  // spawned player performs to an empty room — the FAIL this rule exists for.
  assert.equal(audioDestination(UI_KIND_WEB, undefined), 'webview');
});

test('a remote extension host plays through the webview even from desktop', () => {
  // Remote SSH, WSL, a dev container: `uiKind` is Desktop and the machine
  // running the extension is still not the one with the speakers. Checking
  // `uiKind` alone would misroute every one of these.
  assert.equal(audioDestination(DESKTOP, 'ssh-remote'), 'webview');
});

test('a browser workbench is enough on its own, whatever remoteName says', () => {
  // Deliberate: what code-server reports for `remoteName` varies by version, so
  // the rule does not depend on it. Both forms land in the same place.
  assert.equal(audioDestination(UI_KIND_WEB, undefined), 'webview');
  assert.equal(audioDestination(UI_KIND_WEB, 'localhost'), 'webview');
});

test('an unknown uiKind with no remote is treated as local', () => {
  // Fails towards the behaviour that has always shipped rather than towards a
  // round trip nobody asked for. A wrong guess here is audible immediately,
  // which is the kind of wrong that gets fixed.
  assert.equal(audioDestination(undefined, undefined), 'host');
});

test('the reason names which axis decided, because both are invisible otherwise', () => {
  assert.match(audioDestinationReason(UI_KIND_WEB, undefined), /browser/);
  assert.match(audioDestinationReason(DESKTOP, 'wsl'), /remote \(wsl\)/);
  assert.match(audioDestinationReason(DESKTOP, undefined), /this machine/);
});
