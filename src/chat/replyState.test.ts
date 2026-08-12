import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyStateReader, STATE_TAG_INSTRUCTION, stripTags } from './replyState';

/** Feeds a reply through in pieces, as a stream would. */
function read(fragments: string[]): { text: string; state: string | undefined } {
  const reader = new ReplyStateReader();
  const text = fragments.map((fragment) => reader.push(fragment)).join('') + reader.flush();
  return { text, state: reader.state };
}

test('the tag sets the state and never reaches the text', () => {
  const { text, state } = read(['[[judging]] A global variable. ', 'Bold.']);

  assert.equal(state, 'judging');
  assert.equal(text, 'A global variable. Bold.');
});

test('a tag split across fragments is still caught', () => {
  // The normal case, not an edge case: a stream breaks text wherever it likes, and
  // "[[jud" arriving alone is what a leak would look like.
  const { text, state } = read(['[[', 'impre', 'ssed]] ', 'Neat.']);

  assert.equal(state, 'impressed');
  assert.equal(text, 'Neat.');
});

test('a reply with no tag loses nothing', () => {
  const { text, state } = read(['The tests pass. ', 'All of them, which is new.']);

  assert.equal(state, undefined);
  assert.equal(text, 'The tests pass. All of them, which is new.');
});

test('an invented state is discarded and the reply still reads', () => {
  // Same trust boundary as everywhere else: a model may claim anything, and anything
  // outside the union simply does not apply.
  const { text, state } = read(['[[smug]] It worked.']);

  assert.equal(state, undefined);
  assert.equal(text, 'It worked.');
});

test('a short reply that ends before the buffer fills still comes out', () => {
  // Nothing is emitted until the tag resolves, so a four-word answer would otherwise
  // sit in the buffer and never be shown.
  const { text } = read(['Done.']);

  assert.equal(text, 'Done.');
});

test('a tag written mid-reply is swept rather than displayed', () => {
  assert.equal(stripTags('Fine. [[judging]] Mostly.'), 'Fine.  Mostly.');
});

test('the instruction says most replies are ordinary', () => {
  // A face that changes on every answer is wallpaper. §2 rule 2, applied to the face.
  assert.match(STATE_TAG_INSTRUCTION, /Most replies are \[\[talking\]\]/);
});

test('a fragment that begins with a space keeps it', () => {
  // Seen live as "the probe-build-fail test has beenfailing": stripTags trimmed every
  // fragment, so a stream that split between a word and its following space silently
  // welded the two words together.
  const { text } = read(['[[talking]] The test has', ' been failing', ' since Tuesday.']);

  assert.equal(text, 'The test has been failing since Tuesday.');
});

test('leading space is still removed at the very start', () => {
  // The one place trimming is right: a tag followed by whitespace, or a reply that
  // opens with one.
  const { text } = read(['   Done.']);

  assert.equal(text, 'Done.');
});
