import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { isInside, resolveInWorkspace, PathRefused } from './workspacePaths';

// ---------------------------------------------------------------------------
// Containment, as pure string logic. These are the cases that must never pass,
// tested here because several of them are awkward to create on a real disk.
// ---------------------------------------------------------------------------

test('a sibling directory sharing a prefix is not inside', () => {
  // The classic containment bug: startsWith('/work') accepts '/workspace-secrets'.
  assert.equal(isInside('/work', '/workspace-secrets/passwords', 'linux'), false);
  assert.equal(isInside('/work', '/work/src/index.ts', 'linux'), true);
});

test('the root itself is inside', () => {
  assert.equal(isInside('/work', '/work', 'linux'), true);
});

test('traversal out and back is judged on where it lands', () => {
  // '/work/../work/x' is legitimate; '/work/../etc/passwd' is not. Only resolution
  // tells them apart, which is why the check resolves before comparing.
  assert.equal(isInside('/work', '/work/../work/x', 'linux'), true);
  assert.equal(isInside('/work', '/work/../etc/passwd', 'linux'), false);
  assert.equal(isInside('/work', '/work/a/../../etc/passwd', 'linux'), false);
});

test('case handling follows the platform, because the filesystem does', () => {
  // On macOS the two are the same file, so refusing would break real paths. On Linux
  // they are different files, so folding case would accept one that must be refused.
  assert.equal(isInside('/Work', '/work/file.ts', 'darwin'), true);
  assert.equal(isInside('/Work', '/work/file.ts', 'linux'), false);
});

// ---------------------------------------------------------------------------
// Resolution against a real filesystem, including the symlink case a textual
// check cannot see.
// ---------------------------------------------------------------------------

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clarvis-tools-'));
  // The temp dir itself is often a symlink on macOS (/var -> /private/var), so the
  // root is realpathed here — otherwise every test would fail for the wrong reason.
  return fs.realpath(dir);
}

test('a relative path resolves from the workspace, not the process cwd', async () => {
  const root = await workspace();
  const resolved = await resolveInWorkspace(root, 'src/index.ts');

  assert.equal(resolved, path.join(root, 'src/index.ts'));
});

test('traversal outside the workspace is refused', async () => {
  const root = await workspace();

  await assert.rejects(
    () => resolveInWorkspace(root, '../../etc/passwd'),
    (error: PathRefused) => error.reason === 'outside-workspace'
  );
});

test('an absolute path outside the workspace is refused', async () => {
  const root = await workspace();

  await assert.rejects(
    () => resolveInWorkspace(root, '/etc/passwd'),
    (error: PathRefused) => error.reason === 'outside-workspace'
  );
});

test('a symlink pointing outside the workspace is refused', async () => {
  // The case a textual check passes without blinking: the path is plainly inside the
  // project, and the file it names is not.
  const root = await workspace();
  const outside = await workspace();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'innocent.txt'));

  await assert.rejects(
    () => resolveInWorkspace(root, 'innocent.txt'),
    (error: PathRefused) => error.reason === 'outside-workspace'
  );
});

test('a symlinked directory pointing outside is refused too', async () => {
  const root = await workspace();
  const outside = await workspace();
  await fs.mkdir(path.join(outside, 'stuff'));
  await fs.writeFile(path.join(outside, 'stuff', 'file.txt'), 'private');
  await fs.symlink(path.join(outside, 'stuff'), path.join(root, 'linked'));

  await assert.rejects(
    () => resolveInWorkspace(root, 'linked/file.txt'),
    (error: PathRefused) => error.reason === 'outside-workspace'
  );
});

test('a symlink staying inside the workspace is allowed', async () => {
  // Monorepos are full of these. Refusing them all would be safe and useless.
  const root = await workspace();
  await fs.mkdir(path.join(root, 'packages'));
  await fs.writeFile(path.join(root, 'packages', 'a.ts'), 'export {}');
  await fs.symlink(path.join(root, 'packages'), path.join(root, 'link'));

  const resolved = await resolveInWorkspace(root, 'link/a.ts');
  assert.equal(resolved, path.join(root, 'link/a.ts'));
});

test('a file that does not exist yet is allowed, so new files can be written', async () => {
  const root = await workspace();
  const resolved = await resolveInWorkspace(root, 'src/brand/new/file.ts');

  assert.equal(resolved, path.join(root, 'src/brand/new/file.ts'));
});

test('a new file under a symlinked-out directory is still refused', async () => {
  // The reason the nearest *existing* ancestor is realpathed rather than the leaf:
  // otherwise "create a file" becomes the way out of the workspace.
  const root = await workspace();
  const outside = await workspace();
  await fs.symlink(outside, path.join(root, 'escape'));

  await assert.rejects(
    () => resolveInWorkspace(root, 'escape/new-file.txt'),
    (error: PathRefused) => error.reason === 'outside-workspace'
  );
});

test('no open folder refuses everything, with a reason of its own', async () => {
  await assert.rejects(
    () => resolveInWorkspace(undefined, 'anything.ts'),
    (error: PathRefused) => error.reason === 'no-workspace'
  );
});

test('a refusal names the path but never leaks what it pointed at', async () => {
  // The message goes to the model and into the transcript. Echoing the resolved
  // target would hand back the very path the refusal exists to protect.
  const root = await workspace();
  const outside = await workspace();
  await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'innocent.txt'));

  const error = await resolveInWorkspace(root, 'innocent.txt').then(
    () => undefined,
    (e: PathRefused) => e
  );

  assert.ok(error instanceof PathRefused);
  assert.match(error.message, /innocent\.txt/);
  assert.ok(!error.message.includes(outside), error.message);
});
