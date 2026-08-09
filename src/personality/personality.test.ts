import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QuipPicker, EARNED_SASS_THRESHOLD } from './QuipPicker';
import { mayInterrupt, INTERRUPTION_WINDOW_MS } from './rateLimit';
import { QUIPS, Quip } from './quipBank';

const bank: Quip[] = [
  { id: 'p1', trigger: 'buildSlow', tone: 'polite', text: 'polite one' },
  { id: 'p2', trigger: 'buildSlow', tone: 'polite', text: 'polite two' },
  { id: 'e1', trigger: 'buildSlow', tone: 'earned', text: 'earned one' },
  { id: 'other', trigger: 'bigDiff', tone: 'polite', text: 'other trigger' },
];

/** Deterministic picker: always takes the first eligible line. */
function picker(lines = bank) {
  return new QuipPicker(lines, () => 0);
}

// ---------------------------------------------------------------- tone gating

test('a fresh session only uses polite lines', () => {
  // §2 rule 2: opening with contempt you haven't earned is how a character gets muted.
  const p = picker();
  const chosen = [p.pick('buildSlow'), p.pick('buildSlow'), p.pick('buildSlow')];

  assert.ok(chosen.every((q) => q?.tone === 'polite'));
});

test('sass unlocks once enough has gone wrong', () => {
  const p = picker();
  for (let i = 0; i < EARNED_SASS_THRESHOLD; i++) p.noteEvidence();

  assert.equal(p.sassUnlocked, true);

  // With sass unlocked the earned line becomes reachable at all.
  const seen = new Set<string>();
  for (let i = 0; i < 6; i++) seen.add(p.pick('buildSlow')!.tone);
  assert.ok(seen.has('earned'));
});

test('evidence just below the threshold does not unlock sass', () => {
  const p = picker();
  for (let i = 0; i < EARNED_SASS_THRESHOLD - 1; i++) p.noteEvidence();

  assert.equal(p.sassUnlocked, false);
});

// ---------------------------------------------------------------- no repeats

test('does not repeat a line until the trigger is exhausted', () => {
  const p = picker();
  const first = p.pick('buildSlow')!;
  const second = p.pick('buildSlow')!;

  assert.notEqual(first.id, second.id);
});

test('exhausting a trigger reuses its lines rather than going silent', () => {
  // Decided rather than left undefined: silence reads as broken, and the interruption
  // budget is what actually limits how often he speaks.
  const p = picker();
  p.pick('buildSlow');
  p.pick('buildSlow');

  const third = p.pick('buildSlow');

  assert.ok(third, 'still says something once the pool is used up');
});

test('exhausting one trigger does not consume another', () => {
  const p = picker();
  p.pick('buildSlow');
  p.pick('buildSlow');

  assert.equal(p.pick('bigDiff')?.id, 'other');
});

test('an unknown trigger yields nothing rather than throwing', () => {
  assert.equal(picker([]).pick('buildSlow'), undefined);
});

// ---------------------------------------------------------------- rate limit

test('the first remark is always allowed', () => {
  assert.equal(mayInterrupt(undefined, 1000), true);
});

test('a second remark inside the window is refused', () => {
  assert.equal(mayInterrupt(1000, 1000 + INTERRUPTION_WINDOW_MS - 1), false);
});

test('a remark after the window is allowed', () => {
  assert.equal(mayInterrupt(1000, 1000 + INTERRUPTION_WINDOW_MS), true);
});

// ---------------------------------------------------------------- the bank

test('every trigger has at least one polite line', () => {
  // Without one, a fresh session would be silent for that trigger entirely.
  const triggers = new Set(QUIPS.map((q) => q.trigger));

  for (const trigger of triggers) {
    const polite = QUIPS.filter((q) => q.trigger === trigger && q.tone === 'polite');
    assert.ok(polite.length > 0, `${trigger} has no polite line`);
  }
});

test('quip ids are unique', () => {
  // Ids drive the no-repeat set; a duplicate would silently suppress a line.
  const ids = QUIPS.map((q) => q.id);

  assert.equal(new Set(ids).size, ids.length);
});

test('quips stay short', () => {
  // The failure mode for this character is volume (§2).
  for (const quip of QUIPS) {
    assert.ok(quip.text.length <= 100, `too long: ${quip.text}`);
  }
});
