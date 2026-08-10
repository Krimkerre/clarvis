import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Tests about the tests.
 *
 * This file exists because of a real, silent failure: the test script used
 * `out/**` + `/*.test.js` **unquoted**, which `sh` expands to exactly one directory
 * level. Every test two levels deep — `out/agent/tools/tools.test.js` — never ran, and
 * reported success by simply not existing. Fourteen assertions about the security
 * boundary were absent from a green suite.
 *
 * A test that does not run is worse than a missing one: it reads as coverage. So the
 * failure mode gets its own guard, placed **exactly one directory deep** — the depth
 * the broken glob still matched — so the guard keeps running under the very bug it
 * detects. Placed at the top level it would have gone silent alongside everything
 * else, which is what the first draft of this file did.
 */

/**
 * The repository root, found by walking up to the `package.json`.
 *
 * Not a fixed number of `..` segments: the compiled location of this file depends on
 * how deep its source sits, so counting levels breaks the moment the file moves —
 * which is exactly the kind of brittleness this file exists to catch elsewhere.
 */
function findRepoRoot(start: string): string {
  let current = start;

  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;

    const parent = path.dirname(current);
    if (parent === current) throw new Error('no package.json above ' + start);
    current = parent;
  }
}

const repoRoot = findRepoRoot(__dirname);

/** Every `*.test.ts` under src, at any depth. */
function sourceTestFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceTestFiles(full);
    return entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

test('every test file in src is compiled into out', () => {
  // Catches the compile half: a file excluded by tsconfig would never appear, and
  // nothing else in the suite would notice.
  const sources = sourceTestFiles(path.join(repoRoot, 'src'));
  assert.ok(sources.length > 0, 'found no test sources at all — the walk is wrong');

  for (const source of sources) {
    const compiled = source.replace(`${path.sep}src${path.sep}`, `${path.sep}out${path.sep}`).replace(/\.ts$/, '.js');
    assert.ok(fs.existsSync(compiled), `${path.relative(repoRoot, source)} is not compiled into out/`);
  }
});

test('the test script discovers files at any depth', () => {
  // The actual regression. An unquoted glob is expanded by the shell, which does not
  // recurse; a quoted one is expanded by Node, which does. The difference is invisible
  // until a test file lands two directories deep and quietly stops running.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  ) as { scripts: { test: string } };

  const script = manifest.scripts.test;
  const unquotedGlob = /--test\s+out\/\*\*/.test(script);

  assert.ok(
    !unquotedGlob,
    `the test glob must be quoted so Node expands it recursively, not sh: ${script}`
  );
  assert.match(script, /--test\s+["']out\/\*\*\/\*\.test\.js["']/);
});

test('at least one test lives more than one directory deep', () => {
  // Without this, the guard above could pass while nothing actually exercises the
  // deep-discovery path — and the suite would go back to being quietly incomplete.
  const sources = sourceTestFiles(path.join(repoRoot, 'src'));
  const deep = sources.filter(
    (source) => path.relative(path.join(repoRoot, 'src'), source).split(path.sep).length > 2
  );

  assert.ok(deep.length > 0, 'no test file is nested deeply enough to catch a shallow glob');
});
