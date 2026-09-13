import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { defaultTokenFolder, TokenStore, type WriteIo } from './tokenStore';

/**
 * The token file is what lets desktop VS Code reattach to a task code-server started, and it holds a
 * capability, so its modes and its atomic writes are asserted on real files rather than taken on trust.
 * Everything runs in a temporary folder; nothing touches the real home folder.
 */

const posix = process.platform !== 'win32';
const SESSION = 'as_01J9ZK4T6Q8M2V7R3N5B1C0D';
const TOKEN = 'ast_FIXTURE_session_token_not_a_secret_AAAAAAAA';
const REISSUED = 'ast_FIXTURE_reissued_token_not_a_secret_BBBBBBB';

function withSandbox(run: (paths: { base: string; root: string; folder: string }) => void): void {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-tokens-'));
  try {
    const root = path.join(base, 'add-utc-demo');
    fs.mkdirSync(root);
    run({ base, root, folder: defaultTokenFolder(path.join(base, 'home')) });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

test('the folder is the one the design names', () => {
  assert.equal(defaultTokenFolder('/Users/owner'), '/Users/owner/.local/share/clarvis/agent-sessions');
});

test('a token is kept in <sha256(root realpath)>.json, the folder 0700 and the file 0600', { skip: !posix }, () => {
  withSandbox(({ root, folder }) => {
    const store = new TokenStore(folder);
    store.save(root, SESSION, TOKEN, 'task-1', new Date('2026-09-13T01:12:00Z'));

    // The temporary folder is itself behind a symlink on macOS, so this also proves the realpath is used.
    const file = path.join(folder, `${sha256(fs.realpathSync.native(root))}.json`);
    assert.equal(store.fileFor(root), file);
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.read(root, SESSION), {
      kind: 'found',
      entry: { token: TOKEN, taskId: 'task-1', savedAt: '2026-09-13T01:12:00.000Z' },
    });
    assert.deepEqual(fs.readdirSync(folder), [path.basename(file)], 'no temporary file is left behind');
  });
});

test('a symlinked path to the same project finds the same token, as the other editor would', { skip: !posix }, () => {
  withSandbox(({ base, root, folder }) => {
    const link = path.join(base, 'link-to-project');
    fs.symlinkSync(root, link);
    const store = new TokenStore(folder);
    store.save(link, SESSION, TOKEN, 'task-1');

    assert.equal(store.read(root, SESSION).kind, 'found');
  });
});

test('a token folder that already exists with looser modes is tightened to 0700', { skip: !posix }, () => {
  withSandbox(({ root, folder }) => {
    fs.mkdirSync(folder, { recursive: true });
    fs.chmodSync(folder, 0o755);
    new TokenStore(folder).save(root, SESSION, TOKEN, 'task-1');

    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  });
});

test('two sessions share one project file; forgetting one keeps the other, and the last takes the file along', () => {
  withSandbox(({ root, folder }) => {
    const store = new TokenStore(folder);
    store.save(root, SESSION, TOKEN, 'task-1');
    store.save(root, 'as_01J9ZKSECOND0000000000000', REISSUED, 'task-2');

    store.forget(root, SESSION);
    assert.deepEqual(store.read(root, SESSION), { kind: 'missing' });
    assert.equal(store.read(root, 'as_01J9ZKSECOND0000000000000').kind, 'found');

    store.forget(root, 'as_01J9ZKSECOND0000000000000');
    assert.equal(fs.existsSync(store.fileFor(root)), false);
    store.forget(root, 'as_01J9ZKSECOND0000000000000');
  });
});

test('a token file others can read, or a symlink in its place, is refused and not read', { skip: !posix }, () => {
  withSandbox(({ base, root, folder }) => {
    const store = new TokenStore(folder);
    store.save(root, SESSION, TOKEN, 'task-1');
    const file = store.fileFor(root);

    fs.chmodSync(file, 0o644);
    assert.deepEqual(store.read(root, SESSION), { kind: 'refused', reason: 'loose-permissions' });

    const elsewhere = path.join(base, 'elsewhere.json');
    fs.renameSync(file, elsewhere);
    fs.chmodSync(elsewhere, 0o600);
    fs.symlinkSync(elsewhere, file);
    assert.deepEqual(store.read(root, SESSION), { kind: 'refused', reason: 'symlink' });

    // Saving replaces the untrusted file rather than merging with it, and leaves the target alone.
    store.save(root, SESSION, REISSUED, 'task-1');
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(elsewhere, 'utf8')).sessions[SESSION].token, TOKEN);
  });
});

test('a file naming another root is not trusted', { skip: !posix }, () => {
  withSandbox(({ root, folder }) => {
    const store = new TokenStore(folder);
    store.save(root, SESSION, TOKEN, 'task-1');
    const file = store.fileFor(root);
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...body, root: '/somewhere/else' }), { mode: 0o600 });

    assert.deepEqual(store.read(root, SESSION), { kind: 'refused', reason: 'unreadable' });
  });
});

test('a write that fails part-way leaves the previous file whole, and no temporary file', () => {
  withSandbox(({ root, folder }) => {
    const store = new TokenStore(folder);
    store.save(root, SESSION, TOKEN, 'task-1');
    const file = store.fileFor(root);
    const before = fs.readFileSync(file, 'utf8');

    const halfWrite: WriteIo = {
      openSync: (target, flags, mode) => fs.openSync(target, flags, mode),
      writeSync: (fd, data) => {
        fs.writeSync(fd, data.slice(0, 20));
        throw new Error('disk full');
      },
      fsyncSync: (fd) => fs.fsyncSync(fd),
      closeSync: (fd) => fs.closeSync(fd),
      renameSync: (from, to) => fs.renameSync(from, to),
    };
    const failedRename: WriteIo = {
      ...halfWrite,
      writeSync: (fd, data) => fs.writeSync(fd, data),
      renameSync: () => {
        throw new Error('rename refused');
      },
    };

    assert.throws(() => new TokenStore(folder, halfWrite).save(root, 'as_01J9ZKSECOND0000000000000', REISSUED, 'task-2'), /disk full/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.throws(() => new TokenStore(folder, failedRename).save(root, 'as_01J9ZKSECOND0000000000000', REISSUED, 'task-2'), /rename refused/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(folder), [path.basename(file)]);
  });
});

test('a malformed token or session id is a bug: it throws before anything is written', () => {
  withSandbox(({ root, folder }) => {
    const store = new TokenStore(folder);

    assert.throws(() => store.save(root, SESSION, 'not-a-token', 'task-1'), TypeError);
    assert.throws(() => store.save(root, 'not a session id', TOKEN, 'task-1'), TypeError);
    assert.equal(fs.existsSync(folder), false);
  });
});
