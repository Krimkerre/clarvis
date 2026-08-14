import test from 'node:test';
import assert from 'node:assert/strict';
import { macProfile, sandboxArgv } from './sandboxProfile';

test('the workspace is writable and everything else is not', () => {
  const profile = macProfile('/Users/me/project', []);

  assert.match(profile, /\(deny file-write\*\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/Users\/me\/project"\)\)/);
  // Order is the meaning in SBPL: last match wins, so the allow must follow the deny.
  assert.ok(profile.indexOf('(deny file-write*)') < profile.indexOf('/Users/me/project'));
});

test('build caches are writable too', () => {
  const profile = macProfile('/p', ['/Users/me/.npm', '/Users/me/.cargo']);

  assert.match(profile, /subpath "\/Users\/me\/\.npm"/);
  assert.match(profile, /subpath "\/Users\/me\/\.cargo"/);
});

test('/dev/null is writable, because otherwise nothing works', () => {
  // The first profile denied it, and every command redirecting output failed with
  // "Operation not permitted". A sandbox that breaks `>/dev/null` gets switched off
  // within a day and protects nobody.
  const profile = macProfile('/p', []);

  assert.match(profile, /literal "\/dev\/null"/);
  assert.match(profile, /\/dev\/tty/);
  assert.match(profile, /\/dev\/fd\//);
});

test('a quote in the workspace path cannot end the rule early', () => {
  // The path is wherever someone keeps their code. A profile that can be broken by a
  // folder name is not a boundary.
  const profile = macProfile('/Users/me/we"ird', []);

  assert.match(profile, /subpath "\/Users\/me\/we\\"ird"/);
  assert.doesNotMatch(profile, /subpath "\/Users\/me\/we"ird"/);
});

test('a backslash in the path is escaped as well', () => {
  assert.match(macProfile('/Users/me/back\\slash', []), /back\\\\slash/);
});

test('empty cache entries are dropped rather than becoming a rule for ""', () => {
  // `(subpath "")` is not obviously harmless, and an empty string here would come
  // from a lookup that failed rather than from an intention.
  const profile = macProfile('/p', ['', '/real']);

  assert.doesNotMatch(profile, /subpath ""/);
  assert.match(profile, /subpath "\/real"/);
});

test('the macOS wrapper runs the command through a shell, under the profile', () => {
  const { file, args } = sandboxArgv('sandbox-exec', '/tmp/p.sb', '/ws', [], 'npm test');

  assert.equal(file, 'sandbox-exec');
  assert.deepEqual(args, ['-f', '/tmp/p.sb', '/bin/sh', '-c', 'npm test']);
});

test('the Linux wrapper binds the workspace writable and the rest read-only', () => {
  // bubblewrap reaches the same guarantee from the other direction: nothing is
  // writable unless it was bound that way.
  const { file, args } = sandboxArgv('bwrap', '', '/ws', ['/home/me/.npm'], 'npm test');

  assert.equal(file, 'bwrap');
  assert.deepEqual(args.slice(0, 4), ['--ro-bind', '/', '/', '--dev']);
  assert.ok(args.join(' ').includes('--bind /ws /ws'));
  assert.ok(args.join(' ').includes('--bind /home/me/.npm /home/me/.npm'));
  assert.deepEqual(args.slice(-3), ['/bin/sh', '-c', 'npm test']);
});

test('the command is passed as one argument, never interpolated', () => {
  // It goes to the shell as a single argv entry, so nothing in it can add arguments
  // to the sandbox wrapper itself.
  const { args } = sandboxArgv('sandbox-exec', '/tmp/p.sb', '/ws', [], 'echo "; rm -rf /"');

  assert.equal(args[args.length - 1], 'echo "; rm -rf /"');
  assert.equal(args.filter((argument) => argument.includes('rm -rf')).length, 1);
});
