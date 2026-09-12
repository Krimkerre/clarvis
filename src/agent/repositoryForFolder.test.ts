import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryForFolder } from './repositoryForFolder';

const TASKS = '/Users/mathias/Documents/coding/NERVIS-ecosystem/workspace/clarvis/nervis-tasks';
const POMODORO = { name: 'pomodoro', rootUri: { fsPath: `${TASKS}/pomodoro-timer` } };
const ECOSYSTEM = { name: 'ecosystem', rootUri: { fsPath: '/Users/mathias/Documents/coding/NERVIS-ecosystem' } };
const UNROOTED: { name: string; rootUri?: { fsPath: string } } = { name: 'unrooted' };

test("a repository found below the open folder is not the folder's", () => {
  // Found live, 12 September 2026: with nervis-tasks open, the greeting named
  // pomodoro-timer's branch, because the editor's Git extension scans subfolders.
  assert.equal(repositoryForFolder([POMODORO], TASKS), undefined);
});

test('the repository whose root contains the folder is chosen, at its root or below it', () => {
  assert.equal(repositoryForFolder([POMODORO], `${TASKS}/pomodoro-timer`), POMODORO);
  assert.equal(repositoryForFolder([POMODORO], `${TASKS}/pomodoro-timer/src`), POMODORO);
  assert.equal(repositoryForFolder([POMODORO], `${TASKS}/pomodoro-timer/`), POMODORO, 'a trailing slash');
});

test('with nested repositories the deepest one containing the folder wins, in either order', () => {
  assert.equal(repositoryForFolder([ECOSYSTEM, POMODORO], `${TASKS}/pomodoro-timer`), POMODORO);
  assert.equal(repositoryForFolder([POMODORO, ECOSYSTEM], `${TASKS}/pomodoro-timer`), POMODORO);
  assert.equal(repositoryForFolder([POMODORO, ECOSYSTEM], TASKS), ECOSYSTEM);
});

test('a sibling sharing the prefix, no folder, or no repositories give nothing', () => {
  assert.equal(repositoryForFolder([POMODORO], `${TASKS}/pomodoro-timer-old`), undefined);
  assert.equal(repositoryForFolder([POMODORO], undefined), undefined);
  assert.equal(repositoryForFolder(undefined, TASKS), undefined);
  assert.equal(repositoryForFolder([UNROOTED], TASKS), undefined);
});
