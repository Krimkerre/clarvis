import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWorkspaceSignals, looksLikeNewProject, planOfferPrompt } from './workspaceSignals';

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

test('an empty folder with no git reads as a new project', () => {
  assert.equal(looksLikeNewProject({ hasGit: false, topLevelEntries: [], planMdExists: false }), true);
  assert.equal(looksLikeNewProject({ hasGit: false, topLevelEntries: ['README.md'], planMdExists: false }), true);
});

test('a folder someone has already worked in does not', () => {
  // Git is the strongest single signal: nobody initialises a repo by accident.
  assert.equal(looksLikeNewProject({ hasGit: true, topLevelEntries: [], planMdExists: false }), false);
  assert.equal(
    looksLikeNewProject({ hasGit: false, topLevelEntries: ['src', 'package.json', 'test'], planMdExists: false }),
    false
  );
});

test('failed research is not evidence of a new project', () => {
  assert.equal(looksLikeNewProject(undefined), false);
});

test('the offer says something about this folder, not about the missing file', () => {
  // A line that merely restates "there is no plan.md" is a failed line, so the brief
  // has to carry what was actually found.
  const onOld = planOfferPrompt({ hasGit: true, topLevelEntries: ['src'], manifestFile: 'package.json', planMdExists: false });
  assert.match(onOld.context, /already has files in it/);
  assert.match(onOld.context, /package\.json/);

  const onNew = planOfferPrompt({ hasGit: false, topLevelEntries: [], planMdExists: false });
  assert.match(onNew.context, /brand new project/);
});

test('both openings are usable sentences when no model answers', () => {
  // The fallback is what the user actually reads if the model is unavailable, so it
  // has to be a real offer rather than a prompt fragment.
  for (const signals of [undefined, { hasGit: false, topLevelEntries: [], planMdExists: false }]) {
    const { fallback } = planOfferPrompt(signals);
    assert.match(fallback, /\?$/);
    assert.ok(fallback.length > 40);
  }
});
