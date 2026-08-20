import test from 'node:test';
import assert from 'node:assert/strict';
import { numberClaims, ungroundedClaims } from './grounded';

/** The two briefs from the 20 Aug A/B, verbatim. */
const BUILD_FACTS = 'Current branch: m8-chat-agent, working tree clean\nStill failing: "probe-build-fail" (exit 1), 40 minutes ago';
const DIAGNOSTIC_FACTS =
  'Current branch: m8-chat-agent, working tree clean\nProblems open right now: 2 error(s), 1 warning(s), most of them in src/app.ts — you have no information about how long any of them have been there';

test('a duration re-filed as a count is caught', () => {
  // Llama 3.1 8B, given only "40 minutes ago": "The probe-build-fail command failed for
  // the 40th time with exit status 1, exactly 40 minutes ago."
  const said = 'The probe-build-fail command failed for the 40th time with exit status 1, exactly 40 minutes ago.';
  assert.deepEqual(ungroundedClaims(said, BUILD_FACTS), ['40:time']);
});

test('errors re-filed as commits are caught', () => {
  // Same model, given "2 error(s)": "the same one we've been trying to fix for the past
  // two commits".
  const said = "It's the same one we've been trying to fix for the past two commits.";
  assert.deepEqual(ungroundedClaims(said, DIAGNOSTIC_FACTS), ['2:commit']);
});

test('the number itself was never the invention', () => {
  // Both hallucinations used a value they had been handed. A check on values alone passes
  // them both, which is why the pair is the unit.
  for (const said of ['failed for the 40th time', 'the past two commits']) {
    const values = [...numberClaims(said)].map((claim) => claim.split(':')[0]);
    const given = [...numberClaims(`${BUILD_FACTS}\n${DIAGNOSTIC_FACTS}`)].map((c) => c.split(':')[0]);
    for (const value of values) assert.ok(given.includes(value), `${value} was given, and still misused`);
  }
});

test('a faithful answer passes', () => {
  // Haiku 4.5 on the same brief, spelled out rather than in digits.
  const said = 'I need to see the build output or logs to tell you what is actually breaking. Forty minutes is a long time to watch something fail in silence, though.';
  assert.deepEqual(ungroundedClaims(said, BUILD_FACTS), []);
});

test('a grounded count passes', () => {
  // Haiku, given "2 error(s)": "Two errors in src/app.ts, then."
  assert.deepEqual(ungroundedClaims('Two errors in src/app.ts, then.', DIAGNOSTIC_FACTS), []);
});

test('numbers inside names are not counts', () => {
  // A branch called m8-chat-agent, a file called app.ts, a model called claude-haiku-4-5.
  // Reading the 8 in a branch name as a quantity is how a check like this starts
  // rejecting true sentences.
  assert.deepEqual(numberClaims('You are on m8-chat-agent, and src/app.ts is clean.'), new Set());
  assert.deepEqual(ungroundedClaims('Still on m8-chat-agent.', BUILD_FACTS), []);
});

test('a number read backwards from its noun still counts', () => {
  // "exit 1" names what the 1 is. Taking only the word after a number would file it under
  // nothing and flag it as invented the moment anyone repeated it.
  assert.ok(numberClaims('probe-build-fail (exit 1)').has('1:exit'));
  assert.deepEqual(ungroundedClaims('It stopped with exit 1.', BUILD_FACTS), []);
});

test('"ago" does not change what a number is about', () => {
  // "40 minutes ago" and "40 minutes" must produce the same claim, or a faithful
  // rephrasing is rejected over punctuation.
  assert.deepEqual(ungroundedClaims('It has been failing for 40 minutes.', BUILD_FACTS), []);
});

test('a line with no numbers is always grounded', () => {
  assert.deepEqual(ungroundedClaims('That build has been failing quietly for a while.', BUILD_FACTS), []);
});

test('an invented figure with no precedent at all is caught', () => {
  assert.deepEqual(ungroundedClaims('That is the third time this week.', BUILD_FACTS), ['3:time']);
});
