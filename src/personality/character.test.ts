import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SHAPE, character, characterWith } from './character';

test('the voice comes last, after whatever rules the surface adds', () => {
  // Character-first was tried and lost. In chat the voice sat four hundred words above
  // a tool loop, and the reply opened with "Got it", narrated what it had read, praised
  // the file and closed with a question. Recency is the only lever that reaches past a
  // summarise-the-document prior.
  const prompt = characterWith('Rule one.', 'Rule two.');

  assert.ok(prompt.indexOf('Rule one.') < prompt.indexOf('You are Clarvis'));
});

test('the examples are the last thing read', () => {
  // They are the strongest signal in the brief and the end is the strongest position,
  // so the two belong together — ahead of the identity, which is only scene-setting.
  const prompt = character();

  assert.ok(prompt.indexOf('Lines of yours') > prompt.indexOf('How you speak'));
  assert.ok(prompt.trimEnd().endsWith('when nobody read it.'));
});

test('the examples cover more than one beat', () => {
  // The first set was four lines and all four were a task finishing, so there was
  // nothing for pushback or an opinion to imitate and the model wrote "done" four ways.
  const prompt = character();

  assert.match(prompt, /fourth time this week/); // a failure that keeps happening
  assert.match(prompt, /four nested callbacks/); // an opinion about the code
  assert.match(prompt, /asked me to undo it twice/); // pushback
});

test('he volunteers his opinions rather than withholding them', () => {
  // The original line — "far too well-mannered to volunteer unprompted" — was written
  // as flavour and read by the model as an instruction to shut up.
  assert.match(character(), /which you volunteer/);
  assert.doesNotMatch(character(), /unprompted/);
});

test('the answer shape requires a line of his own, rather than banning things', () => {
  // The previous version was four prohibitions in the last position of the prompt. It
  // fixed the length and removed the character, which is what a wall of bans in the
  // strongest position should be expected to do. A required slot cannot be optimised
  // away the way a tone preference can.
  assert.match(ANSWER_SHAPE, /Part 2 is required/);
  assert.match(ANSWER_SHAPE, /An opinion, a jab at the situation/);
  assert.match(ANSWER_SHAPE, /Two sentences at most/);
});
