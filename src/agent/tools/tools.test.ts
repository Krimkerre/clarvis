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

// ---------------------------------------------------------------------------
// Read, list and search — against a real temp workspace, no extension host.
// ---------------------------------------------------------------------------

import { readFile, listFiles, search, MAX_READ_BYTES } from './fileTools';

async function populated(): Promise<string> {
  const root = await workspace();
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules', 'junk'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });

  await fs.writeFile(path.join(root, 'README.md'), '# Title\nhello world\n');
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n// TODO: fix\n');
  await fs.writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');
  await fs.writeFile(path.join(root, 'node_modules', 'junk', 'huge.js'), 'TODO everywhere\n');
  await fs.writeFile(path.join(root, '.git', 'COMMIT_EDITMSG'), 'TODO in git\n');
  return root;
}

test('reading a file returns its text', async () => {
  const root = await populated();
  const result = await readFile(root, 'src/a.ts');

  assert.match(result.text, /export const a = 1/);
  assert.equal(result.truncated, false);
});

test('a file outside the workspace cannot be read', async () => {
  const root = await populated();

  await assert.rejects(() => readFile(root, '../../etc/passwd'));
});

test('a large file is truncated and says so', async () => {
  // Refusing outright would be a worse answer than the first 512KB — but a model
  // reasoning about a fragment it believes is whole produces confident wrong answers,
  // so the cut is always reported.
  const root = await populated();
  await fs.writeFile(path.join(root, 'big.log'), 'x'.repeat(MAX_READ_BYTES + 5000));

  const result = await readFile(root, 'big.log');

  assert.equal(result.truncated, true);
  assert.equal(result.text.length, MAX_READ_BYTES);
  assert.equal(result.bytes, MAX_READ_BYTES + 5000);
});

test('reading a directory is refused with a useful message', async () => {
  const root = await populated();

  await assert.rejects(() => readFile(root, 'src'), /listFiles/);
});

test('listing skips node_modules and .git', async () => {
  // Not a preference: they are never the answer, and walking them turns a one-second
  // listing into a thirty-second one.
  const root = await populated();
  const files = await listFiles(root, { recursive: true });

  assert.ok(files.includes('README.md'));
  assert.ok(files.includes(path.join('src', 'a.ts')));
  assert.ok(!files.some((file) => file.includes('node_modules')), files.join(','));
  assert.ok(!files.some((file) => file.includes('.git')), files.join(','));
});

test('listing returns workspace-relative paths', async () => {
  // Absolute paths in a model's context are noise, and they leak the user's home
  // directory name into every request.
  const root = await populated();
  const files = await listFiles(root, { recursive: true });

  assert.ok(!files.some((file) => path.isAbsolute(file)), files.join(','));
});

test('listing is bounded, so a huge tree cannot flood the context', async () => {
  const root = await populated();
  const files = await listFiles(root, { recursive: true, limit: 2 });

  assert.equal(files.length, 2);
});

test('search finds matches with file and line', async () => {
  const root = await populated();
  const hits = await search(root, /TODO/);

  assert.equal(hits.length, 1);
  assert.equal(hits[0].file, path.join('src', 'a.ts'));
  assert.equal(hits[0].line, 2);
  assert.match(hits[0].text, /TODO: fix/);
});

test('search never reaches into skipped directories', async () => {
  // node_modules and .git both contain "TODO" in this fixture.
  const root = await populated();
  const hits = await search(root, /TODO/);

  assert.ok(!hits.some((hit) => hit.file.includes('node_modules')));
  assert.ok(!hits.some((hit) => hit.file.includes('.git')));
});

test('search is capped, and a global regex does not skip matches', async () => {
  // A global regex carries lastIndex between calls, which drops every other match and
  // reads as the search being flaky rather than wrong.
  const root = await workspace();
  await fs.writeFile(path.join(root, 'many.txt'), Array(50).fill('match here').join('\n'));

  const capped = await search(root, /match/g, { limit: 10 });
  const all = await search(root, /match/g);

  assert.equal(capped.length, 10);
  assert.equal(all.length, 50);
});

test('binary files are skipped by content, not by extension', async () => {
  const root = await workspace();
  await fs.writeFile(path.join(root, 'data.bin'), Buffer.from([0x6d, 0x61, 0x74, 0x63, 0x68, 0x00, 0x01]));

  assert.deepEqual(await search(root, /match/), []);
});

test('one unreadable file does not fail a whole search', async () => {
  const root = await populated();
  await fs.symlink(path.join(root, 'nowhere'), path.join(root, 'broken-link'));

  const hits = await search(root, /TODO/);
  assert.equal(hits.length, 1);
});

// ---------------------------------------------------------------------------
// Edit planning — the decisions, made against strings so they can be tested
// without VS Code. The dangerous part of an editing tool is choosing where to
// write, not the write itself.
// ---------------------------------------------------------------------------

import { planReplace, planWrite, EditRefused } from './editPlan';

test('an ambiguous replacement is refused rather than guessed', () => {
  // The rule that matters most here. A model asking to replace "return null;" in a
  // file with three of them has not said which, and picking the first is a coin flip
  // dressed up as an edit.
  const source = 'function a() {\n  return null;\n}\nfunction b() {\n  return null;\n}\n';

  assert.throws(
    () => planReplace(source, '  return null;', '  return undefined;'),
    (error: EditRefused) => error.reason === 'ambiguous' && error.occurrences === 2
  );
});

test('a unique replacement is applied exactly once', () => {
  const source = 'const a = 1;\nconst b = 2;\n';
  const plan = planReplace(source, 'const b = 2;', 'const b = 3;');

  assert.equal(plan.next, 'const a = 1;\nconst b = 3;\n');
  assert.equal(plan.changedLines, 1);
});

test('text that is not there is refused, with a hint about whitespace', () => {
  // The silent failure this prevents: nothing changes and the model believes it did.
  // Invisible whitespace differences are the usual cause.
  assert.throws(
    () => planReplace('const a = 1;\n', 'const  a = 1;', 'const a = 2;'),
    (error: EditRefused) => error.reason === 'not-found' && /spacing/.test(error.message)
  );
});

test('an empty search string is refused outright', () => {
  // It matches everywhere, so it means nothing — and would insert at position zero.
  assert.throws(() => planReplace('anything', '', 'x'), (error: EditRefused) => error.reason === 'not-found');
});

test('a no-op edit is refused rather than reported as work', () => {
  assert.throws(
    () => planReplace('const a = 1;', 'const a = 1;', 'const a = 1;'),
    (error: EditRefused) => error.reason === 'unchanged'
  );
  assert.throws(
    () => planWrite('same', 'same'),
    (error: EditRefused) => error.reason === 'unchanged'
  );
});

test('writing a new file counts every line as changed', () => {
  const plan = planWrite(undefined, 'one\ntwo\nthree');

  assert.equal(plan.next, 'one\ntwo\nthree');
  assert.equal(plan.changedLines, 3);
});

test('changed-line counts include added and removed lines', () => {
  const plan = planWrite('a\nb\n', 'a\nb\nc\nd\n');

  assert.equal(plan.changedLines, 2);
});

test('replacement is literal, so regex characters are not special', () => {
  // The needle is text a model wrote about the user's code. Treating "$&" or "(a|b)"
  // as a pattern would corrupt the file in a way nobody would predict.
  const source = 'if (a || b) { cost = $5; }\n';
  const plan = planReplace(source, '$5', '$6');

  assert.equal(plan.next, 'if (a || b) { cost = $6; }\n');
});
