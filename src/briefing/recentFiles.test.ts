import test from 'node:test';
import assert from 'node:assert/strict';
import { isWorthRemembering, RecentFiles } from './recentFiles';

const PROJECT = '/Users/mathias/Documents/coding/NERVIS-ecosystem/workspace/clarvis/nervis-tasks/pomodoro-timer';
const CODE_SERVER_SETTINGS = '/Users/mathias/.local/share/code-server/User/settings.json';

test("code-server's own settings file is never what you were working on", () => {
  // Found live, 12 September 2026: every Clarvis setting write saved this file, and the
  // next window opened with "You were last in settings.json" about a project with
  // nothing open.
  assert.equal(isWorthRemembering(CODE_SERVER_SETTINGS, [PROJECT]), false);
  assert.equal(isWorthRemembering(CODE_SERVER_SETTINGS), false, 'named even with no folder open');
});

test('a file in the project is remembered, and one outside it is not', () => {
  assert.equal(isWorthRemembering(`${PROJECT}/src/main.py`, [PROJECT]), true);
  assert.equal(isWorthRemembering(`${PROJECT}/plan.md`, [`${PROJECT}/`]), true, 'a trailing slash on the root');
  assert.equal(isWorthRemembering('/Users/mathias/Documents/coding/clarvis/src/extension.ts', [PROJECT]), false);
  assert.equal(isWorthRemembering(`${PROJECT}-old/plan.md`, [PROJECT]), false, 'a sibling that shares the prefix');
});

test('with no folder open, only the named rules apply, as before', () => {
  assert.equal(isWorthRemembering('/tmp/notes.md'), true);
  assert.equal(isWorthRemembering('/tmp/repo/.git/COMMIT_EDITMSG'), false);
});

test('the list records project files and ignores the editor settings saved between them', () => {
  const recent = new RecentFiles(5, [], [PROJECT]);

  recent.record(`${PROJECT}/src/main.py`);
  recent.record(CODE_SERVER_SETTINGS);

  assert.deepEqual(recent.list(), [`${PROJECT}/src/main.py`]);
});
