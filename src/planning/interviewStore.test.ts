import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProgress, parseSnapshot, STALE_AFTER_MS, worthResuming } from './interviewStore';
import { InterviewState } from './interviewTopics';

const now = 1_700_000_000_000;

const state: InterviewState = {
  answers: [
    { topic: 'what-it-does', text: 'renames photos' },
    { topic: 'who-and-where', text: 'a CLI' },
  ],
  projectName: 'Snapshot',
};

test('an interview a few answers in is worth carrying on', () => {
  assert.equal(worthResuming({ seed: 'renames photos', state, at: now - 60_000 }, now), true);
});

test('one answer in is not worth resuming', () => {
  // The seed is itself the first answer. Offering to resume that costs more attention
  // than retyping the sentence would.
  const barely: InterviewState = { answers: [{ topic: 'what-it-does', text: 'renames photos' }] };
  assert.equal(worthResuming({ seed: 'renames photos', state: barely, at: now }, now), false);
});

test('a week-old interview is not offered back', () => {
  // Long enough to survive a weekend; short enough that "carry on where we left off"
  // never means a project the user has genuinely forgotten starting.
  assert.equal(worthResuming({ seed: 'x', state, at: now - STALE_AFTER_MS - 1 }, now), false);
  assert.equal(worthResuming({ seed: 'x', state, at: now - STALE_AFTER_MS + 1 }, now), true);
});

test('nothing stored is nothing to resume', () => {
  assert.equal(worthResuming(undefined, now), false);
});

test('progress is described by what was answered, under the name they chose', () => {
  const line = describeProgress({ seed: 'renames photos', state, at: now });
  assert.equal(line, 'Snapshot — 2 questions in');
});

test('one answer is singular, because "1 questions in" reads as a bug', () => {
  const one: InterviewState = { answers: [{ topic: 'what-it-does', text: 'renames photos' }] };
  assert.match(describeProgress({ seed: 'renames photos', state: one, at: now }), /1 question in/);
});

test('an unnamed project falls back to what they said it was', () => {
  const unnamed: InterviewState = { answers: state.answers };
  assert.match(describeProgress({ seed: 'renames photos', state: unnamed, at: now }), /^renames photos/);
});

test('stored rubbish is rejected rather than crashing a startup', () => {
  // Stored JSON outlives the code that wrote it: a shape change, a half-written
  // value, or a hand-edited workspace state all arrive here.
  assert.equal(parseSnapshot(undefined), undefined);
  assert.equal(parseSnapshot('a string'), undefined);
  assert.equal(parseSnapshot({ seed: 'x' }), undefined);
  assert.equal(parseSnapshot({ seed: 'x', at: 1, state: {} }), undefined);
  assert.equal(parseSnapshot({ seed: 'x', at: 1, state: { answers: [] } })?.seed, 'x');
});

// ------------------------- a finished interview is the one most worth keeping

/** Everything `readyToDraft` insists on, so the interview counts as complete. */
const complete: InterviewState = {
  answers: [
    { topic: 'what-it-does', text: 'prints a compliment' },
    { topic: 'who-and-where', text: 'a terminal on my own machine' },
    { topic: 'scope', text: 'repeats are fine' },
    { topic: 'linter', text: 'nope' },
    { topic: 'comment-style', text: 'no comments needed' },
  ],
  projectName: 'Ego Refill',
};

test('a finished interview is still worth resuming', () => {
  // Found by using the product on 19 Aug: reloading the window at the approve gate lost
  // the analysis, the findings just ruled on, and the drafted plan — and offered nothing
  // back, so the only way forward was to answer everything again. The questions are the
  // cheap half; what sits between the last one and plan.md is the expensive half.
  assert.equal(worthResuming({ seed: 'prints a compliment', state: complete, at: now }, now), true);
});

test('a finished interview is described as finished, not counted', () => {
  // "8 questions in" is true and useless — it reads as though more are coming, when what
  // is actually waiting is the plan.
  assert.equal(
    describeProgress({ seed: 'prints a compliment', state: complete, at: now }),
    'Ego Refill — all answered, no plan written yet'
  );
});

test('a part-way interview is still counted', () => {
  assert.equal(
    describeProgress({ seed: 'renames photos', state, at: now }),
    'Snapshot — 2 questions in'
  );
});

// ------------------------- M9i: the draft at the approve gate is kept with the interview
//
// When the interview is dropped — only on an outcome, never on a draft walked away from — is
// tested where that now happens, in planReview.test.ts.

test('a drafted plan is kept with the interview it came from', () => {
  const stored = { seed: 'x', at: 1, state: { answers: [] }, draft: '# Ego Refill' };
  assert.equal(parseSnapshot(stored)?.draft, '# Ego Refill');
});

test('a draft that is not text is dropped, not the interview it came with', () => {
  const snapshot = parseSnapshot({ seed: 'x', at: 1, state: { answers: [] }, draft: 42 });
  assert.equal(snapshot?.seed, 'x');
  assert.equal(snapshot?.draft, undefined);
});

test('an interview waiting at the approve gate is described by its draft', () => {
  assert.equal(
    describeProgress({ seed: 'prints a compliment', state: complete, at: now, draft: '# Ego Refill' }),
    'Ego Refill — a drafted plan is waiting for approval'
  );
});
