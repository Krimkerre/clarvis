import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readCredentialFile } from './credentialFile';

/**
 * Every file here is a temporary one holding a fixture value. The real credential file is never read.
 */

const posix = process.platform !== 'win32';
const CREDENTIAL = 'fixture-client-clarvis-not-a-secret';

function withFolder(run: (folder: string) => void): void {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-credential-'));
  try {
    run(folder);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

test('a 0600 file holding one credential gives that credential, without its newline', { skip: !posix }, () => {
  withFolder((folder) => {
    const file = path.join(folder, 'clarvis-ravis.token');
    fs.writeFileSync(file, `${CREDENTIAL}\n`, { mode: 0o600 });

    assert.deepEqual(readCredentialFile(file), { ok: true, credential: CREDENTIAL });
    assert.deepEqual(readCredentialFile(`  ${file}  `), { ok: true, credential: CREDENTIAL });
  });
});

test('~/ in the setting is the home folder', { skip: !posix }, () => {
  withFolder((folder) => {
    fs.writeFileSync(path.join(folder, 'token'), CREDENTIAL, { mode: 0o600 });

    assert.deepEqual(readCredentialFile('~/token', 'darwin', folder), { ok: true, credential: CREDENTIAL });
  });
});

test('no setting, a relative path, or a missing file gives a reason and no credential', () => {
  withFolder((folder) => {
    assert.deepEqual(readCredentialFile(undefined), { ok: false, reason: 'not_set' });
    assert.deepEqual(readCredentialFile('   '), { ok: false, reason: 'not_set' });
    assert.deepEqual(readCredentialFile('relative/clarvis-ravis.token'), { ok: false, reason: 'not_absolute' });
    assert.deepEqual(readCredentialFile(path.join(folder, 'absent.token')), { ok: false, reason: 'missing' });
  });
});

test('a file others can read, a symlink, or a folder is refused, not read', { skip: !posix }, () => {
  withFolder((folder) => {
    const loose = path.join(folder, 'loose.token');
    fs.writeFileSync(loose, CREDENTIAL, { mode: 0o600 });
    fs.chmodSync(loose, 0o644);
    const good = path.join(folder, 'good.token');
    fs.writeFileSync(good, CREDENTIAL, { mode: 0o600 });
    const link = path.join(folder, 'link.token');
    fs.symlinkSync(good, link);

    assert.deepEqual(readCredentialFile(loose), { ok: false, reason: 'loose-permissions' });
    assert.deepEqual(readCredentialFile(link), { ok: false, reason: 'symlink' });
    assert.deepEqual(readCredentialFile(folder), { ok: false, reason: 'not-a-file' });
  });
});

test('an empty file, or one holding more than one token, gives no credential', { skip: !posix }, () => {
  withFolder((folder) => {
    const empty = path.join(folder, 'empty.token');
    fs.writeFileSync(empty, '\n', { mode: 0o600 });
    const two = path.join(folder, 'two.token');
    fs.writeFileSync(two, `${CREDENTIAL}\nanother-one\n`, { mode: 0o600 });

    assert.deepEqual(readCredentialFile(empty), { ok: false, reason: 'empty' });
    assert.deepEqual(readCredentialFile(two), { ok: false, reason: 'unreadable' });
  });
});
