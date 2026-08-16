import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Every `media/` file the extension reads at runtime actually exists.
 *
 * These are read off disk with `readFileSync` or opened by URI, so a rename or a
 * missing file is a runtime failure — and one that type checking, linting and the
 * rest of the suite all pass straight over, leaving a panel that looks fine and does
 * nothing. That is precisely how both M8 webview defects presented.
 *
 * **Scans all of `src/`, not just the panel.** It checked `ButlerViewProvider.ts`
 * alone at first, which left `media/MANUAL.md` — the manual `/help` opens, read by
 * `ChatActions.ts` — uncovered by a test whose name claimed otherwise. Reading the
 * names out of the source means a new asset is covered without anyone remembering to
 * add it here.
 */
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Every production `.ts` under `src/`, so no reader is missed by living in a new
 * directory. Tests are skipped because they read nothing at runtime — and because
 * this file's own comment spells out the `'media', '<name>'` shape it searches for,
 * which the first version of this test duly reported as a missing asset.
 */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    const isTest = entry.name.endsWith('.test.ts') || entry.name.endsWith('.spec.ts');
    return entry.name.endsWith('.ts') && !isTest ? [full] : [];
  });
}

test('every media asset the extension reads at runtime is on disk', () => {
  // Matches the joinPath(..., 'media', '<name>') form every asset read uses.
  const names = new Set(
    sourceFiles(path.join(ROOT, 'src')).flatMap((file) =>
      [...fs.readFileSync(file, 'utf8').matchAll(/'media',\s*'([^']+)'/g)].map((match) => match[1])
    )
  );

  assert.ok(names.size >= 4, `expected at least four media assets, found ${names.size}`);
  assert.ok(names.has('MANUAL.md'), 'the manual /help opens should be among them');

  for (const name of names) {
    assert.ok(fs.existsSync(path.join(ROOT, 'media', name)), `media/${name} is read at runtime but missing`);
  }
});

test('the panel stylesheet still carries the rules the panel depends on', () => {
  const css = fs.readFileSync(path.join(ROOT, 'media', 'chat.css'), 'utf8');

  // A stylesheet that exists but has been emptied or half-moved is the failure this
  // catches; these four are the structural rules the layout cannot render without.
  for (const selector of ['.clarvis-chat', '#clarvis-transcript', '.clarvis-choice', '.clarvis-progress']) {
    assert.ok(css.includes(selector), `${selector} missing from media/chat.css`);
  }
});
