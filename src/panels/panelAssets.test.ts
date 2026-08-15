import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Every `media/` file the panel reads at render time actually exists.
 *
 * `buildHtml` loads `avatar.html`, `chat.js` and `chat.css` off disk with
 * `readFileSync`, so a rename or a missing file is a runtime throw — and one that
 * type checking, linting and the rest of the suite all pass straight over, leaving a
 * panel that looks fine and does nothing. That is precisely how both M8 webview
 * defects presented.
 *
 * Reads the asset names out of the source rather than listing them here, so adding a
 * fourth asset is covered without anyone remembering to update a test.
 */
const ROOT = path.resolve(__dirname, '..', '..');

test('every media asset the panel reads at render time is on disk', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'panels', 'ButlerViewProvider.ts'), 'utf8');

  // Matches the joinPath(..., 'media', '<name>') form every asset read uses.
  const names = [...source.matchAll(/'media',\s*'([^']+)'/g)].map((match) => match[1]);

  assert.ok(names.length >= 3, `expected at least three media assets, found ${names.length}`);
  for (const name of names) {
    assert.ok(fs.existsSync(path.join(ROOT, 'media', name)), `media/${name} is read by the panel but missing`);
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
