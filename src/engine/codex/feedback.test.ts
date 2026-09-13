import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interjectionMessage } from '../../agent/interjections';
import { FeedbackQueue } from './feedback';

/**
 * Typed text that hasn't reached Codex yet. Clarvis 0.13 dropped mid-run redirects on its own engine;
 * this is where a second engine keeps them instead.
 */

const NOW = new Date('2026-09-13T02:00:00Z');

test('text is kept trimmed, with when and where it was typed; nothing is kept for nothing', () => {
  const queue = new FeedbackQueue();

  assert.equal(queue.keep('  use the other library  ', 'desktop', NOW), true);
  assert.equal(queue.keep('   ', 'desktop', NOW), false);
  assert.deepEqual(queue.all, [{ text: 'use the other library', typedAt: NOW.toISOString(), host: 'desktop', delivered: false }]);
});

test('the same words kept here and handed back by RAVIS are one message, not two', () => {
  const queue = new FeedbackQueue();
  queue.keep('Also update the README.', 'desktop', NOW);

  assert.equal(queue.keep('Also update the README.', 'desktop', NOW), false);
  assert.deepEqual(queue.pending, ['Also update the README.']);
});

test('delivered text stops waiting, and drain takes out only what never arrived', () => {
  const queue = new FeedbackQueue();
  queue.keep('first', 'desktop', NOW);
  queue.keep('second', 'code-server', NOW);
  queue.markDelivered('first');

  assert.deepEqual(queue.pending, ['second']);
  assert.deepEqual(queue.drain(), ['second']);
  assert.deepEqual(queue.pending, []);
  assert.deepEqual(
    queue.all.map((entry) => [entry.text, entry.delivered]),
    [['first', true]],
    'what arrived stays on record'
  );
});

test("the next turn's text puts what waited first, framed as Clarvis's own engine frames a redirect", () => {
  const queue = new FeedbackQueue();
  assert.equal(queue.turnText('Carry on.'), 'Carry on.', 'nothing waiting adds nothing');

  queue.keep('use datetime.timezone.utc', 'desktop', NOW);
  assert.equal(queue.turnText('Carry on.'), `${interjectionMessage(['use datetime.timezone.utc'])}\n\nCarry on.`);
});
