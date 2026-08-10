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
  assert.deepEqual(flow.work, ['clarvis/<task>']);
});

test('a project with no integration branch generates and parses cleanly', () => {
  const flow = parseBranchFlow(branchFlowSection('main'));

  assert.equal(flow.trunk, 'main');
  assert.equal(flow.integration, undefined);
});

import { writeBranchFlow, flowBranches } from '../branchFlow';

test('rewriting the section leaves the rest of the document alone', () => {
  // The failure this prevents: regenerating the whole file from a parsed flow, which
  // silently deletes every sentence someone wrote elsewhere.
  const plan = '# Project\n\nIntro prose.\n\n## Branch flow\n\n- trunk: main\n\n## Milestones\n\n- M1\n';
  const next = writeBranchFlow(plan, { trunk: 'main', integration: 'testing' });

  assert.match(next, /Intro prose/);
  assert.match(next, /## Milestones/);
  assert.match(next, /- M1/);
  assert.match(next, /- integration: testing/);
});

test('a plan with no section gets one appended', () => {
  const next = writeBranchFlow('# Project\n\nSome prose.\n', { trunk: 'main' });

  assert.match(next, /## Branch flow/);
  assert.equal(parseBranchFlow(next).trunk, 'main');
});

test('an added branch round-trips through the document', () => {
  // Written, then read back by the wizard. If these disagree the feature is broken in
  // a way nobody notices until a merge goes to the wrong branch.
  const written = writeBranchFlow('# P\n', { trunk: 'main', integration: 'testing', extra: ['qa'] });
  const flow = parseBranchFlow(written);

  assert.equal(flow.trunk, 'main');
  assert.equal(flow.integration, 'testing');
  assert.deepEqual(flow.extra, ['qa']);
  assert.deepEqual(flowBranches(flow), ['main', 'testing', 'qa']);
});

test('a project can route work through more than one branch', () => {
  // A flow is not always three branches. Forcing a second integration step into
  // "trunk" would misrepresent the workflow the user just described.
  const flow = parseBranchFlow('## Branch flow\n- trunk: main\n- integration: staging\n- integration: qa\n');

  assert.equal(flow.integration, 'staging');
  assert.deepEqual(flow.extra, ['qa']);
});

test('rewriting twice is stable', () => {
  // An edit that grows the section every time it runs would eventually be noticed as
  // a bug, but only after it had made a mess of the document.
  const once = writeBranchFlow('# P\n', { trunk: 'main', integration: 'testing' });
  const twice = writeBranchFlow(once, parseBranchFlow(once));

  assert.equal(once, twice);
});

import { matchesWork } from '../branchFlow';

test('work patterns cover feature branches, so they are never asked about', () => {
  // Without this, a project with twelve milestone branches gets interrogated twelve
  // times about branches that were obviously not steps in the flow.
  const patterns = ['clarvis/<task>', 'm*-*', 'feature/*'];

  assert.equal(matchesWork('clarvis/fix-the-test', patterns), true);
  assert.equal(matchesWork('m8-chat-agent', patterns), true);
  assert.equal(matchesWork('feature/login', patterns), true);
});

test('a work pattern does not swallow the flow branches', () => {
  // A pattern loose enough to match `main` would silence the question entirely.
  const patterns = ['clarvis/<task>', 'm*-*', 'feature/*'];

  assert.equal(matchesWork('main', patterns), false);
  assert.equal(matchesWork('testing', patterns), false);
  assert.equal(matchesWork('staging', patterns), false);
});

test('patterns are literal apart from the wildcards', () => {
  // A pattern language rich enough to be surprising is one people get wrong.
  assert.equal(matchesWork('release.1', ['release.1']), true);
  assert.equal(matchesWork('releaseX1', ['release.1']), false, 'the dot must not act as a wildcard');
});

test('no patterns means nothing matches, rather than everything', () => {
  assert.equal(matchesWork('anything', []), false);
  assert.equal(matchesWork('anything', undefined), false);
});

test('prose inside the section survives a rewrite', () => {
  // The failure this fixes, seen live: the section's own explanation was replaced by
  // the generic boilerplate. Only the list is Clarvis's; the words around it are the
  // user's, and a tool that quietly eats prose is one people stop trusting.
  const plan = [
    '## Branch flow',
    '',
    'We branch this way because the release train is weekly.',
    '',
    '- trunk: master',
    '',
    'Note: never merge straight to master on a Friday.',
    '',
    '## Milestones',
  ].join('\n');

  const next = writeBranchFlow(plan, { trunk: 'master', integration: 'staging' });

  assert.match(next, /release train is weekly/);
  assert.match(next, /never merge straight to master on a Friday/);
  assert.match(next, /- integration: staging/);
  assert.match(next, /## Milestones/);
});

test('the old entries are replaced, not appended to', () => {
  const plan = '## Branch flow\n\n- trunk: old\n- integration: gone\n';
  const next = writeBranchFlow(plan, { trunk: 'main' });

  assert.ok(!next.includes('trunk: old'), next);
  assert.ok(!next.includes('integration: gone'), next);
  assert.match(next, /- trunk: main/);
});

test('the list stays where it was, between the prose around it', () => {
  const plan = '## Branch flow\n\nBefore.\n\n- trunk: main\n\nAfter.\n';
  const next = writeBranchFlow(plan, { trunk: 'main', integration: 'testing' });

  const beforeIndex = next.indexOf('Before.');
  const listIndex = next.indexOf('- trunk: main');
  const afterIndex = next.indexOf('After.');

  assert.ok(beforeIndex < listIndex && listIndex < afterIndex, next);
});

test('a section with prose but no list gains one without losing the prose', () => {
  const plan = '## Branch flow\n\nWe have not written this down yet.\n';
  const next = writeBranchFlow(plan, { trunk: 'main' });

  assert.match(next, /We have not written this down yet/);
  assert.match(next, /- trunk: main/);
});

test('rewriting twice is still stable, with prose present', () => {
  // An edit that shuffles blank lines each run would churn the document forever.
  const plan = '## Branch flow\n\nWhy we do it.\n\n- trunk: main\n\nCaveat.\n\n## Next\n';
  const once = writeBranchFlow(plan, { trunk: 'main', integration: 'testing' });
  const twice = writeBranchFlow(once, parseBranchFlow(once));

  assert.equal(once, twice);
});

import { missingBranches, withoutBranch } from '../branchFlow';

test('a branch deleted locally but alive on the remote is not reported', () => {
  // Deleting a merged branch locally is routine housekeeping. Asking about it every
  // time would punish exactly the habit worth having.
  const flow = { trunk: 'main', integration: 'testing', extra: ['staging'] };

  assert.deepEqual(missingBranches(flow, ['main'], ['origin/testing', 'origin/staging']), []);
});

test('a branch gone from both local and remote is reported', () => {
  const flow = { trunk: 'main', integration: 'testing', extra: ['staging'] };

  assert.deepEqual(missingBranches(flow, ['main', 'testing'], ['origin/main', 'origin/testing']), ['staging']);
});

test('the trunk is never reported as missing', () => {
  // A repository whose trunk has vanished has a much larger problem than a stale line
  // in a document, and offering to delete the entry answers the wrong question.
  const flow = { trunk: 'production', integration: 'testing' };

  assert.deepEqual(missingBranches(flow, [], []), ['testing']);
});

test('a repository with no remote at all still works', () => {
  // Local-only projects are ordinary. With no remote, "gone from the remote too" is
  // satisfied by the branch simply not existing locally.
  const flow = { trunk: 'master', integration: 'staging' };

  assert.deepEqual(missingBranches(flow, ['master'], []), ['staging']);
});

test('removing a branch leaves the rest of the flow intact', () => {
  const flow = { trunk: 'main', integration: 'testing', extra: ['staging', 'qa'], work: ['clarvis/<task>'] };
  const next = withoutBranch(flow, 'staging');

  assert.equal(next.trunk, 'main');
  assert.equal(next.integration, 'testing');
  assert.deepEqual(next.extra, ['qa']);
  assert.deepEqual(next.work, ['clarvis/<task>']);
});

test('removing the primary integration branch clears that slot', () => {
  const next = withoutBranch({ trunk: 'main', integration: 'testing' }, 'testing');

  assert.equal(next.integration, undefined);
});
