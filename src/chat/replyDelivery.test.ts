import test from 'node:test';
import assert from 'node:assert/strict';
import { afterReply } from './replyDelivery';

test('an ordinary finished reply is spoken', () => {
  assert.equal(afterReply('Filed under things that now work.', false).speak, true);
});

// F24 -- a typed stop produced "Stopped." and then nineteen seconds of the cancelled
// reply read aloud, including the model narrating work it was about to start.
test('a stopped reply is never spoken', () => {
  const delivery = afterReply('I hear "shitload of things" and then a parrot...', true);
  assert.equal(delivery.speak, false);
});

test('a stopped reply says so in the log rather than vanishing quietly', () => {
  const delivery = afterReply('half a sentence', true);
  assert.match(delivery.logLine ?? '', /stopped/i);
});

test('an empty reply is neither spoken nor logged, stopped or not', () => {
  for (const aborted of [true, false]) {
    const delivery = afterReply('   ', aborted);
    assert.equal(delivery.speak, false, `aborted=${aborted}`);
    assert.equal(delivery.logLine, undefined, `aborted=${aborted}`);
  }
});

test('a finished reply needs no log line -- the transcript already has it', () => {
  assert.equal(afterReply('Done.', false).logLine, undefined);
});
