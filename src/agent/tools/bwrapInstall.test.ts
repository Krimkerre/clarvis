import test from 'node:test';
import assert from 'node:assert/strict';
import { installCommand, packageManagers } from './bwrapInstall';

test('each package manager gets the line that distribution actually uses', () => {
  assert.equal(installCommand('apt-get'), 'sudo apt-get install -y bubblewrap');
  assert.equal(installCommand('pacman'), 'sudo pacman -S --needed bubblewrap');
  assert.equal(installCommand('apk'), 'sudo apk add bubblewrap');
});

test('an unknown distribution gets nothing rather than a guess', () => {
  // Guessing a line that starts with `sudo` is worse than admitting the specifics were
  // never written down — the rule the conventions lookup follows too.
  assert.equal(installCommand('emerge'), undefined);
  assert.equal(installCommand(undefined), undefined);
});

test('every manager probed for has a command to go with it', () => {
  for (const binary of packageManagers()) assert.ok(installCommand(binary), binary);
});

test('nothing is installed without the user, and every line says so', () => {
  // The extension never runs these: it puts the line in a terminal, unexecuted, and
  // the user's own shell asks for the password. An extension that runs sudo on your
  // behalf has become the thing the sandbox exists to prevent.
  for (const binary of packageManagers()) assert.match(installCommand(binary)!, /^sudo /);
});
