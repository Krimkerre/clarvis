import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';
import { secretStoreDetail, secretStoreLabel } from './secretStoreLabel';

test('the desktop keeps saying keychain, because there it is true', () => {
  assert.equal(secretStoreLabel(undefined), 'the system keychain');
  assert.match(secretStoreDetail(undefined), /system keychain/);
});

test('a remote host is never called a keychain', () => {
  // §7.2: never label it identically unless proven equivalent. It was measured
  // on code-server 4.135.0 and it is not: `context.secrets` resolves to
  // LocalStorageSecretStorageProvider — the browser's localStorage, AES-GCM
  // under a key whose client half sits in cleartext in the same blob and whose
  // server half is a world-readable file. No OS keyring exists in the install.
  for (const host of ['ssh-remote', 'dev-container', 'wsl', 'code-server']) {
    // The short label is substituted into "stored in ___", so the word itself
    // would be the claim.
    assert.doesNotMatch(secretStoreLabel(host), /keychain/i, host);
    // The long one may *deny* a keychain — "rather than an OS keychain" is the
    // honest sentence, and the first draft of this test failed it for containing
    // the word. What must not appear is the affirmative.
    assert.doesNotMatch(secretStoreDetail(host), /\bin (the|your) (system |OS )?keychain/i, host);
    assert.match(secretStoreDetail(host), /rather than an OS keychain/, host);
  }
});

test('the remote wording still promises what remains true', () => {
  // The two guarantees that survive the host change are the ones people act on:
  // it is not in a settings file, and it is not in the log.
  const detail = secretStoreDetail('code-server');

  assert.match(detail, /settings file/);
  assert.match(detail, /log/);
  assert.match(detail, /weaker than the desktop/);
});

test('an empty remoteName is desktop, not remote', () => {
  // `vscode.env.remoteName` is `undefined` on the desktop, but a defensive
  // caller passing '' must not be told it is remote — that would put the weaker
  // wording in front of every desktop user.
  assert.equal(secretStoreLabel(''), 'the system keychain');
});

test('no user-facing string asserts a keychain unconditionally', () => {
  // The defect this file exists for: eleven places said "keychain" outright,
  // including the text shown when a key is stored. A source scan is the only
  // way to catch the twelfth, since these strings live in files that import
  // `vscode` and cannot be reached from here.
  const root = findRepoRoot(__dirname);
  const offenders: string[] = [];
  for (const file of sources(path.join(root, 'src'))) {
    const text = fs.readFileSync(file, 'utf8');
    text.split('\n').forEach((line, at) => {
      // Only strings shown to a person: a quoted or templated sentence. Comments
      // and doc blocks may still say keychain — they describe the desktop case
      // and are read by people who can see the surrounding context.
      const shown = /(phrase|placeHolder|Message|line:|title:|detail:)/.test(line);
      if (shown && /keychain/i.test(line) && !line.includes('secretStoreLabel')
          && !line.includes('secretStoreDetail')) {
        offenders.push(`${path.relative(root, file)}:${at + 1}`);
      }
    });
  }

  assert.deepEqual(offenders, [], 'these claim an OS keychain on every host');
});

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function findRepoRoot(start: string): string {
  let current = start;
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('no package.json above ' + start);
    current = parent;
  }
}
