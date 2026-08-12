import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { detectTestCommand } from '../testCommand';

async function project(files: Record<string, string>): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'clarvis-test-cmd-')));
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(root, name), contents);
  }
  return root;
}

test('a declared npm test script is used', async () => {
  const root = await project({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }) });

  assert.equal(await detectTestCommand(root), 'npm test');
});

test("npm's placeholder script is not treated as a test command", async () => {
  // `npm init` writes a script that prints "no test specified" and exits 1. Running it
  // reports a failure that means nothing, immediately after an edit — the worst moment
  // to be told something is broken when it isn't.
  const root = await project({
    'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
  });

  assert.equal(await detectTestCommand(root), undefined);
});

test('other ecosystems are recognised by what they declare', async () => {
  assert.equal(await detectTestCommand(await project({ 'Cargo.toml': '[package]' })), 'cargo test');
  assert.equal(await detectTestCommand(await project({ 'go.mod': 'module x' })), 'go test ./...');
  assert.equal(await detectTestCommand(await project({ 'pytest.ini': '[pytest]' })), 'pytest');
});

test('a project that declares nothing gets no guess', async () => {
  // Silence is the right answer: a wrong guess runs something unexpected right after
  // an edit, when the user is least able to tell what went wrong.
  assert.equal(await detectTestCommand(await project({ 'README.md': '# x' })), undefined);
  assert.equal(await detectTestCommand(undefined), undefined);
});

test('a malformed package.json does not throw', async () => {
  const root = await project({ 'package.json': '{ not json' });

  assert.equal(await detectTestCommand(root), undefined);
});
