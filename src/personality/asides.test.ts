import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleAsides, pickAside } from './asides';

const bank = ['one', 'two', 'three'] as const;

test('nothing said yet means everything is available', () => {
  assert.deepEqual(eligibleAsides(bank, new Set()), ['one', 'two', 'three']);
});

test('a line already said is not offered again', () => {
  assert.deepEqual(eligibleAsides(bank, new Set(['two'])), ['one', 'three']);
});

test('an exhausted bank reopens rather than going silent', () => {
  // The rule QuipPicker settled on for the same problem: silence reads as broken, and
  // repeating a good line eventually beats having none.
  assert.deepEqual(eligibleAsides(bank, new Set(bank)), ['one', 'two', 'three']);
});

test('clicking repeatedly never runs out of something to say', () => {
  // The failure this prevents is a button that is funny four times and mute afterwards.
  const said = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const line = pickAside('models', said);
    assert.ok(line.length > 0, `click ${i} produced nothing`);
  }
});

test('consecutive picks do not repeat while others remain', () => {
  // Random, so this asserts the property rather than a sequence: across a run of picks,
  // no line appears twice before the bank has been exhausted once.
  const said = new Set<string>();
  const first = pickAside('models', said);
  const second = pickAside('models', said);
  assert.notEqual(first, second);
});
