import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWorkspaceSignals } from './workspaceSignals';

test('an empty workspace is described honestly', () => {
  const description = describeWorkspaceSignals({ hasGit: false, topLevelEntries: [], planMdExists: false });
  assert.match(description, /empty workspace/i);
});

test('real facts are named, not invented ones', () => {
  const description = describeWorkspaceSignals({
    hasGit: true,
    manifestFile: 'package.json',
    topLevelEntries: ['package.json', 'src'],
    readmeFirstLine: '# My Project',
    planMdExists: true,
  });
  assert.match(description, /package\.json/);
  assert.match(description, /git repository/);
  assert.match(description, /plan\.md/);
  assert.match(description, /My Project/);
});

test('only the facts actually present are mentioned', () => {
  const description = describeWorkspaceSignals({ hasGit: true, topLevelEntries: ['.git'], planMdExists: false });
  assert.match(description, /git repository/);
  assert.doesNotMatch(description, /package\.json/);
  assert.doesNotMatch(description, /plan\.md/);
});
