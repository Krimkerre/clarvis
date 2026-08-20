import test from 'node:test';
import assert from 'node:assert/strict';
import { afterReply, SPOKEN_CEILING_SECONDS, spokenPart, spokenSeconds } from './replyDelivery';

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

/**
 * The spoken ceiling (F20).
 *
 * The rule is deliberately all-or-nothing: under the ceiling he says everything, past it
 * he says his own line. Nothing is ever cut mid-thought, and a reply that was fine is
 * never touched — which is what the earlier attempts got wrong, trimming replies that
 * had no problem.
 */
test('a reply under the ceiling is spoken whole', () => {
  const reply = 'The build has been failing for forty minutes. I would look at the test output before the config.';

  assert.equal(spokenPart(reply), reply);
  assert.ok(spokenSeconds(reply) <= SPOKEN_CEILING_SECONDS);
});

test('a reply past the ceiling is spoken as his closing line alone', () => {
  // 175 words, ~70 seconds — the shape that survived four versions of the prompt.
  const body = Array.from({ length: 8 }, (_, i) =>
    `Unattended mode is what you build when you cannot see what went wrong, and that is the ${i + 1}st reason to distrust it.`
  ).join(' ');
  const reply = `${body} And I would be the one tidying up afterwards.`;

  assert.equal(spokenPart(reply), 'And I would be the one tidying up afterwards.');
  assert.ok(spokenSeconds(spokenPart(reply)) <= SPOKEN_CEILING_SECONDS);
});

test('one long sentence is finished rather than cut in half', () => {
  // No closing line to fall back to, and half a sentence read aloud is worse than a long
  // one. He gets to finish it.
  const reply = Array.from({ length: 60 }, () => 'words').join(' ') + '.';

  assert.equal(spokenPart(reply), reply);
});

test('nothing to say stays nothing', () => {
  assert.equal(spokenPart('   '), '');
});
