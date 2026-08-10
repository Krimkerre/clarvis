import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  foreignCommits,
  reviewOptions,
  reviewWarnings,
  describeRun,
  RunSummary,
} from '../runReview';

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    branch: 'clarvis/fix-the-test',
    base: 'main',
    files: ['src/a.ts'],
    commits: [{ hash: 'aaa', subject: 'Fixed the test' }],
    foreign: [],
    uncommitted: 0,
    ...overrides,
  };
}

test('commits the run did not make are identified', () => {
  // The case that actually bit: an agent branch is checked out in the user's own
  // working tree, so anything committed afterwards lands on it too.
  const all = [
    { hash: 'aaa', subject: 'Fixed the test' },
    { hash: 'bbb', subject: 'Unrelated work by the user' },
  ];

  assert.deepEqual(foreignCommits(all, ['aaa']), [{ hash: 'bbb', subject: 'Unrelated work by the user' }]);
});

test('foreign commits are found by hash, not by author or message', () => {
  // A model writes commit messages in the user's voice, and both commit as the same
  // person, so neither is a signal.
  const all = [{ hash: 'ccc', subject: 'Fixed the test' }];

  assert.equal(foreignCommits(all, ['aaa']).length, 1);
});

test('a branch with foreign commits warns before any option is chosen', () => {
  const warnings = reviewWarnings(
    summary({ foreign: [{ hash: 'bbb', subject: 'My own half-finished refactor' }] })
  );

  assert.match(warnings[0], /weren't made by the run/);
  assert.match(warnings[0], /half-finished refactor/);
});

test('uncommitted changes are flagged, because they follow you between branches', () => {
  const warnings = reviewWarnings(summary({ uncommitted: 3 }));

  assert.match(warnings.join(' '), /follow you between branches/);
});

test('changes with no commit are flagged as travelling with you', () => {
  const warnings = reviewWarnings(summary({ commits: [], files: ['a.ts'] }));

  assert.match(warnings.join(' '), /carries the changes with you/);
});

test('reviewing comes first and the destructive option comes last', () => {
  // A list that opens with "throw it away" invites exactly the reflex click the
  // wizard exists to prevent.
  const options = reviewOptions(summary());

  assert.equal(options[0].action, 'diff');
  assert.equal(options[options.length - 1].action, 'discard');
  assert.equal(options[options.length - 1].destructive, true);
});

test('every option states its consequence', () => {
  for (const option of reviewOptions(summary())) {
    assert.ok(option.detail.length > 15, option.action);
  }
});

test('without a branch, only looking and undoing are offered', () => {
  // Nothing was isolated, so "merge" and "go back" are meaningless — offering them
  // would imply an isolation that does not exist.
  const options = reviewOptions(summary({ branch: undefined, base: undefined }));

  assert.deepEqual(options.map((option) => option.action), ['diff', 'discard']);
});

test('the summary line names the branch, the counts and the base', () => {
  const line = describeRun(summary());

  assert.match(line, /clarvis\/fix-the-test/);
  assert.match(line, /1 commit/);
  assert.match(line, /from main/);
});

import { integrationBranch } from '../runReview';

test('a repository with testing gets offered testing before the trunk', () => {
  // A repo with `testing` has already decided work lands there before the trunk.
  // Listing the trunk first invites skipping a step someone deliberately added.
  // (No origin here: with one recorded it comes first — see the merge-target tests.)
  const options = reviewOptions(summary({ base: 'main', integration: 'testing', origin: undefined }));
  const merges = options.filter((option) => option.action.startsWith('merge'));

  assert.equal(merges[0].action, 'merge-integration');
  assert.match(merges[0].label, /testing/);
  assert.match(merges[1].detail, /skipping/);
});

test('without an integration branch the options are unchanged', () => {
  const options = reviewOptions(summary({ integration: undefined }));

  assert.equal(options.filter((option) => option.action.startsWith('merge')).length, 1);
});

test('an integration branch that is also the base is not offered twice', () => {
  // Branching off testing and then being offered "merge into testing" as a separate
  // step reads as a bug.
  const options = reviewOptions(summary({ base: 'testing', integration: 'testing' }));

  assert.equal(options.filter((option) => option.action.startsWith('merge')).length, 1);
});

test('integration branches are recognised by convention', () => {
  assert.equal(integrationBranch(['main', 'testing', 'feature/x'], 'main'), 'testing');
  assert.equal(integrationBranch(['main', 'develop'], 'main'), 'develop');
  assert.equal(integrationBranch(['main', 'staging'], 'main'), 'staging');
  assert.equal(integrationBranch(['main', 'feature/x'], 'main'), undefined);
});

test('the base branch is never offered as its own integration target', () => {
  assert.equal(integrationBranch(['develop', 'main'], 'develop'), undefined);
});

import { mergeTargets } from '../runReview';

test('where the run started is the first merge target', () => {
  // Work begun from a milestone branch belongs back on that milestone branch. Guessing
  // at the trunk gets this wrong every time, which is the case that prompted it.
  const targets = mergeTargets(
    summary({ origin: 'm8-chat-agent', integration: 'testing', base: 'main' })
  );

  assert.deepEqual(
    targets.map((target) => target.action),
    ['merge-origin', 'merge-integration', 'merge']
  );
  assert.match(targets[0].label, /m8-chat-agent/);
});

test('the trunk option says it skips the others', () => {
  const targets = mergeTargets(summary({ origin: 'feature/x', integration: 'testing', base: 'main' }));

  assert.match(targets[2].detail, /skipping/);
});

test('duplicate targets are offered once, not three times', () => {
  // A repository where origin, integration and trunk are all the same branch should
  // offer one option rather than the same one worded three ways.
  const targets = mergeTargets(summary({ origin: 'main', integration: undefined, base: 'main' }));

  assert.equal(targets.length, 1);
  assert.match(targets[0].label, /main/);
});

test('the run branch is never offered as its own merge target', () => {
  const targets = mergeTargets(
    summary({ branch: 'clarvis/x', origin: 'clarvis/x', base: 'main' })
  );

  assert.ok(!targets.some((target) => target.label.includes('clarvis/x')));
});

test('with no origin recorded, the old ordering still holds', () => {
  const targets = mergeTargets(summary({ origin: undefined, integration: 'testing', base: 'main' }));

  assert.deepEqual(targets.map((target) => target.action), ['merge-integration', 'merge']);
});

import { narrateReview } from '../runReview';

test('the outcome is said in the transcript, with the fact that matters after', () => {
  // A notification vanishes; the transcript is where someone looks tomorrow to work
  // out what happened to their work. So each line names where they now are.
  const state = summary({ branch: 'clarvis/fix', origin: 'm8-chat-agent' });

  assert.match(narrateReview('return', state), /m8-chat-agent/);
  assert.match(narrateReview('return', state), /clarvis\/fix/);
  assert.match(narrateReview('merge', state, { target: 'testing', ok: true }), /testing/);
  assert.match(narrateReview('discard', state, { ok: true }), /m8-chat-agent/);
});

test('a failed merge says so plainly rather than claiming success', () => {
  const line = narrateReview('merge', summary(), { target: 'testing', ok: false });

  assert.match(line, /didn't go cleanly/);
  assert.match(line, /conflicts/);
});

test('staying warns that commits land on the agent branch', () => {
  // The exact mistake that happened during development, said out loud this time.
  assert.match(narrateReview('stay', summary()), /lands on it/);
});

test('a failed delete does not pretend the branch is gone', () => {
  const line = narrateReview('discard', summary(), { ok: false });

  assert.match(line, /still there/);
});
