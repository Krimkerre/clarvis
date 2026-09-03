import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VERDICT_REASON, verifySecretFile } from './secretFile';

/** A regular file's `mode` carries file-type bits above the permission bits. */
const fileMode = (permissions: number) => 0o100000 | permissions;

const regularFile = (permissions: number) => ({
  isSymbolicLink: () => false,
  isFile: () => true,
  mode: fileMode(permissions),
});

test('a 0600 regular file is ok', () => {
  assert.equal(verifySecretFile(regularFile(0o600)), 'ok');
});

test('a symlink is refused, even one that ultimately resolves to a 0600 file', () => {
  const stats = { isSymbolicLink: () => true, isFile: () => true, mode: fileMode(0o600) };
  assert.equal(verifySecretFile(stats), 'symlink');
});

test('a directory is refused', () => {
  const stats = { isSymbolicLink: () => false, isFile: () => false, mode: 0o40700 };
  assert.equal(verifySecretFile(stats), 'not-a-file');
});

test('a loosely-permissioned file is refused on a platform with POSIX modes', () => {
  assert.equal(verifySecretFile(regularFile(0o644), 'darwin'), 'loose-permissions');
  assert.equal(verifySecretFile(regularFile(0o666), 'linux'), 'loose-permissions');
});

test('permission bits are not checked on win32, since they are not meaningful there', () => {
  assert.equal(verifySecretFile(regularFile(0o644), 'win32'), 'ok');
});

test('every non-ok verdict has a one-sentence reason', () => {
  for (const verdict of ['symlink', 'not-a-file', 'loose-permissions'] as const) {
    assert.ok(VERDICT_REASON[verdict].length > 0);
  }
});
