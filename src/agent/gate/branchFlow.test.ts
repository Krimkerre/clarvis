import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBranchFlow, branchFlowSection } from '../branchFlow';

test('a declared flow is read from the plan', () => {
  const flow = parseBranchFlow(`# Project\n\n## Branch flow\n\n- trunk: production\n- integration: qa\n`);

  assert.equal(flow.trunk, 'production');
  assert.equal(flow.integration, 'qa');
});

test('only the section under the heading counts', () => {
  // "trunk" appears in prose in most plans. Reading it as a declaration would let a
  // sentence about branching quietly redirect every merge.
  const flow = parseBranchFlow(
    `## Overview\n\ntrunk: nonsense\n\n## Branch flow\n\n- trunk: main\n\n## Milestones\n\n- trunk: also-nonsense\n`
  );

  assert.equal(flow.trunk, 'main');
});

test('a plan with no branch flow yields nothing, not a guess', () => {
  // Absent means "fall back to conventions", which the caller decides — inventing a
  // default here would make an undeclared flow indistinguishable from a declared one.
  assert.deepEqual(parseBranchFlow('# Project\n\nSome prose about main and testing.\n'), {});
});

test('decoration around a branch name is stripped', () => {
  // "`main` (production)" is a normal thing to write in a document people read.
  const flow = parseBranchFlow('## Branch flow\n- trunk: `main` (production)\n- integration: "testing"\n');

  assert.equal(flow.trunk, 'main');
  assert.equal(flow.integration, 'testing');
});

test('prose that is not a branch name is ignored', () => {
  // A branch name has no spaces; anything with one got here by accident.
  const flow = parseBranchFlow('## Branch flow\n- trunk: whatever we agree on later\n');

  assert.equal(flow.trunk, undefined);
});

test('list markers and separators vary, and all of them work', () => {
  // People write documents by hand. Being fussy here means the feature silently
  // stops working for someone who used an asterisk.
  for (const line of ['- trunk: main', '* trunk: main', '+ trunk: main', 'trunk = main', '  - trunk:  main  ']) {
    assert.equal(parseBranchFlow(`## Branch flow\n${line}\n`).trunk, 'main', line);
  }
});

test('the heading is matched loosely, since people write it by hand', () => {
  for (const heading of ['## Branch flow', '### Branching flow', '# Branch Flow', '## 5. Branch flow']) {
    assert.equal(parseBranchFlow(`${heading}\n- trunk: main\n`).trunk, 'main', heading);
  }
});

test('the first declaration wins, so a later stray line cannot override it', () => {
  const flow = parseBranchFlow('## Branch flow\n- trunk: main\n- trunk: oops\n');

  assert.equal(flow.trunk, 'main');
});

test('the generated section parses back to what it declared', () => {
  // The planner writes it and the wizard reads it; if these ever disagree the feature
  // is broken in a way nobody would notice until a merge went to the wrong branch.
  const flow = parseBranchFlow(branchFlowSection('main', 'testing'));

  assert.equal(flow.trunk, 'main');
  assert.equal(flow.integration, 'testing');
  assert.equal(flow.work, 'clarvis/<task>');
});

test('a project with no integration branch generates and parses cleanly', () => {
  const flow = parseBranchFlow(branchFlowSection('main'));

  assert.equal(flow.trunk, 'main');
  assert.equal(flow.integration, undefined);
});
