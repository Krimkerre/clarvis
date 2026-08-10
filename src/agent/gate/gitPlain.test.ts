import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainState, planSwitch, explainDelete, explainSwitchFailure, GitState } from '../gitPlain';

function state(overrides: Partial<GitState> = {}): GitState {
  return {
    branch: 'main',
    detached: false,
    dirty: 0,
    ahead: 0,
    behind: 0,
    onAgentBranch: false,
    hasRemote: true,
    ...overrides,
  };
}

test("git's own vocabulary never reaches the user", () => {
  // These words describe git's implementation, not the user's situation. §6's audience
  // has not learned them and should not have to in order to use this.
  const everything = [
    ...explainState(state({ detached: true, dirty: 3, ahead: 2, behind: 1 })),
    planSwitch(state({ dirty: 2 }), 'main').explanation,
    explainDelete('x', 3),
    explainSwitchFailure('main'),
  ].join(' ');

  // Whole words only: "refuses" legitimately contains "ref", and "ahead" contains
  // "head" — a substring check flags perfectly plain English as jargon.
  for (const jargon of ['HEAD', 'index', 'working tree', 'unstaged', 'unmerged', 'ref', 'upstream', 'rebase', 'stash']) {
    assert.doesNotMatch(everything, new RegExp(`\\b${jargon}\\b`), `leaked jargon: ${jargon}`);
  }
});

test('a detached head is explained as a risk, before anything else', () => {
  // The state a beginner is most likely to lose work in, and least likely to
  // recognise. A summary that opens with the branch name has buried it.
  const [first] = explainState(state({ branch: undefined, detached: true, dirty: 2 }));

  assert.match(first, /not on a branch/);
  assert.match(first, /easy to lose/);
});

test('an agent branch says what it is for', () => {
  // Being on a branch you did not create is confusing unless someone says why.
  const [first] = explainState(state({ branch: 'clarvis/fix', onAgentBranch: true }));

  assert.match(first, /branch I made for a task/);
  assert.match(first, /keep it, merge it, or throw it away/);
});

test('unsaved work is described by where it exists, not by git status', () => {
  const lines = explainState(state({ dirty: 2 })).join(' ');

  assert.match(lines, /2 files changed/);
  assert.match(lines, /only on this machine/);
});

test('a clean repository says so rather than listing nothing', () => {
  // Silence reads as a failure to check.
  assert.match(explainState(state()).join(' '), /Nothing outstanding/);
});

test('a project with no remote is not told about pushing', () => {
  // Advice about a shared copy that does not exist is noise, and worse, implies the
  // user has missed a step.
  const lines = explainState(state({ hasRemote: false, ahead: 3, behind: 2 })).join(' ');

  assert.ok(!/shared copy/.test(lines), lines);
  assert.ok(!/pulling/.test(lines), lines);
});

test('switching with unsaved work explains what happens to it, and asks', () => {
  // The most confusing moment in git for a beginner: changes follow you across a
  // switch when they can, and the tool explains neither the rule nor the exception.
  const plan = planSwitch(state({ dirty: 3 }), 'testing');

  assert.equal(plan.needsConfirmation, true);
  assert.match(plan.explanation, /come with you/);
  assert.match(plan.explanation, /save them here first/i);
  assert.equal(plan.saferFirst, 'Save them here first');
});

test('switching with nothing unsaved does not ask', () => {
  // A confirmation with no risk behind it teaches people to click through the ones
  // that matter.
  assert.equal(planSwitch(state(), 'testing').needsConfirmation, false);
});

test('deleting says whether work disappears, in those terms', () => {
  assert.match(explainDelete('clarvis/x', 0), /loses nothing/);

  const risky = explainDelete('clarvis/x', 2);
  assert.match(risky, /exist nowhere else/);
  assert.match(risky, /cannot get it back/);
});
