import test from 'node:test';
import assert from 'node:assert/strict';
import { afterReply, spokenPart } from './replyDelivery';

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
 * What gets read aloud (F20).
 *
 * The cases are the four chat scenes from `voiceCheck`, in the shape they actually came
 * back on Haiku 4.5 — the 175-word answer that stayed at ~70 seconds through four
 * different versions of the prompt is the one this exists for.
 */
test('a long reply is spoken as its opening and its closing line', () => {
  const reply = [
    'Not for a moment.',
    'Unattended mode is what you build when you cannot see what went wrong.',
    'The real problem is that it works just often enough that you convince yourself to leave it running.',
    'I have watched projects limp along with that as a requirement.',
    'And I would be the one tidying up afterwards.',
  ].join(' ');

  assert.equal(spokenPart(reply), 'Not for a moment. And I would be the one tidying up afterwards.');
});

test('a reply already short enough is spoken whole', () => {
  // Two sentences is the project-question shape, and it was never the problem.
  const reply = 'The build has been failing for forty minutes. I would look at the test output before the config.';
  assert.equal(spokenPart(reply), reply);
});

test('a single sentence survives intact', () => {
  assert.equal(spokenPart('probe-build-fail is developing quite the routine.'), 'probe-build-fail is developing quite the routine.');
});

test('a file path is not a sentence ending', () => {
  // The split has to survive `src/app.ts` and `1.5`, or the spoken half starts mid-path.
  const reply = 'I see two errors in src/app.ts and a warning. Something in the middle. You have work to do.';
  assert.equal(spokenPart(reply), 'I see two errors in src/app.ts and a warning. You have work to do.');
});

test('nothing to say stays nothing', () => {
  assert.equal(spokenPart('   '), '');
});
