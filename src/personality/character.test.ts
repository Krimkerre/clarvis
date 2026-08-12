import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_SHAPE, EXAMPLES, character, characterWith } from './character';

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
  // Only the do-not-quote-these line sits below them, and it has to: it is about them.
  assert.ok(prompt.indexOf('Never reuse a line') > prompt.indexOf('Lines of yours'));
});

test('the examples cover more than one beat', () => {
  // The first set was four lines and all four were a task finishing, so there was
  // nothing for pushback or an opinion to imitate and the model wrote "done" four ways.
  const bank = EXAMPLES.join('\n');

  assert.match(bank, /stopped treating it as an accident/); // a failure that keeps happening
  assert.match(bank, /four nested callbacks/); // an opinion about the code
  assert.match(bank, /asked me to undo it twice/); // pushback
});

test('consecutive prompts do not show the same examples', () => {
  // Banning the quote only bought a paraphrase — "At some point the pattern stops being
  // coincidence" for "At some point it stops being bad luck". The pull is toward
  // whichever example matches the situation, so the window has to move.
  assert.notEqual(character(), character());
});

test('every example still gets shown as the window comes round', () => {
  // Rotating must not quietly retire the beats that fixed the flatness.
  const seen = Array.from({ length: EXAMPLES.length }, () => character()).join('\n');

  for (const example of EXAMPLES) assert.ok(seen.includes(example), example);
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

test('the examples are marked as a register rather than a script', () => {
  // The voice check's first run caught the model quoting them: a briefing ended "At
  // some point it stops being bad luck", word for word. A model reaches for the example
  // whose situation matches, which is exactly when the user would notice the repeat.
  assert.match(character(), /Never reuse a line from that list/);
});

test('no example invents a number the model would not have been given', () => {
  // The examples are imitated, so an invented specific in one of them teaches the habit
  // rather than the discipline. "The fourth time this week" produced a linter that had
  // been complaining "for the past six minutes" — a duration nothing here can measure.
  for (const example of EXAMPLES) {
    assert.doesNotMatch(
      example,
      /\b(fourth|fifth|sixth|last tuesday|this week|minutes|hours)\b/i,
      example
    );
  }
});

test('the brief says where a number has to come from', () => {
  assert.match(character(), /must come from what you were actually given/);
  assert.match(character(), /for the past six minutes" is not/);
});
