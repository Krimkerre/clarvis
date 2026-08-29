import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The theme ships with the feature, or it does not ship at all.
 *
 * It exists so the editor blends into NERVIS's Clarvis tab, which embeds
 * code-server in an iframe. Before this it lived in one person's
 * `settings.json` as `workbench.colorCustomizations` — overrides bolted on top
 * of whatever theme was selected, present on exactly one machine, and lost the
 * moment that file was rewritten.
 */

const root = findRepoRoot(__dirname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the manifest contributes exactly one theme, by a path that exists', () => {
  const themes = manifest.contributes.themes;

  assert.equal(themes.length, 1);
  assert.ok(fs.existsSync(path.join(root, themes[0].path)), `missing ${themes[0].path}`);
  assert.equal(themes[0].uiTheme, 'vs-dark');
});

test('the id is plain ascii, because it is what a settings file has to carry', () => {
  // **`workbench.colorTheme` takes the id when one is declared, not the label.**
  // Setting it to the label — "Clarvis — NERVIS" — resolved to nothing and VS
  // Code fell back to the default *light* theme, silently, with no error in any
  // log. So the id is the contract and the label is decoration, and an id with
  // an em-dash or a space in it would put that hazard into every settings file
  // and every piece of documentation that names it.
  const { id, label } = manifest.contributes.themes[0];

  assert.match(id, /^[a-z0-9-]+$/, `${id} is not safe to paste into settings.json`);
  assert.notEqual(id, label, 'the id must be usable where the label is not');
});

test('the theme is not excluded from the package', () => {
  // `.vscodeignore` drops src, docs and tests. A theme silently ignored would
  // install cleanly, be listed in the picker, and fail to load — the failure
  // arrives at whoever selects it, not at whoever packaged it.
  const ignore = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8')
    .split('\n').map((line) => line.trim()).filter(Boolean);

  for (const rule of ignore) {
    assert.doesNotMatch(rule, /^themes/, `.vscodeignore excludes the theme: ${rule}`);
  }
});

test('it is a complete theme, not a set of overrides', () => {
  // `tokenColors` is the half that is easy to leave out: a theme with `colors`
  // alone renders every token in `editor.foreground`, so source loses its
  // highlighting entirely — worse than the default theme it replaces.
  const theme = readTheme();

  assert.equal(theme.type, 'dark');
  assert.ok(Object.keys(theme.colors).length > 40, 'too few workbench colours to blend');
  assert.ok(theme.tokenColors.length > 8, 'source would render unhighlighted');
});

test('the semantic colours are the dashboard\'s own', () => {
  // So a red in the editor is the same red as a red on the page behind it —
  // the frame boundary should not be where a severity changes colour.
  const theme = readTheme();

  assert.equal(theme.colors['editorError.foreground'], '#ff5c6a');
  assert.equal(theme.colors['editorWarning.foreground'], '#ffb648');
  assert.equal(theme.colors['gitDecoration.addedResourceForeground'], '#43dc8a');
});

test('every colour is a hex value, not a name or a variable', () => {
  // A theme file is plain JSON read by the host: a CSS variable would silently
  // resolve to nothing, and the affected surface would fall back to the default
  // theme's colour rather than fail.
  const theme = readTheme();

  for (const [key, value] of Object.entries<string>(theme.colors)) {
    assert.match(value, /^#[0-9a-fA-F]{6,8}$/, `${key} is not a hex colour: ${value}`);
  }
});

function readTheme(): any {
  return JSON.parse(
    fs.readFileSync(path.join(root, manifest.contributes.themes[0].path), 'utf8')
  );
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
