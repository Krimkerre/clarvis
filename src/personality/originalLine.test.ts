import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptOpening, openingPrompt } from './originalLine';

test('the prompt carries the situation and demands a question when one is wanted', () => {
  const prompt = openingPrompt('this project has no plan.md', 'asks');
  assert.match(prompt, /no plan\.md/);
  assert.match(prompt, /end by asking them/);
});

test('a statement is asked for plainly when no question is wanted', () => {
  assert.match(openingPrompt('a plan was just approved', 'states'), /Not a question/);
});

test('a good line survives intact', () => {
  const line = acceptOpening('No plan here. Shall we do something about that?', 'asks');
  assert.equal(line, 'No plan here. Shall we do something about that?');
});

test('a preface is stripped, quotes with it', () => {
  assert.equal(
    acceptOpening('Clarvis: "Nothing planned here. Fix that?"', 'asks'),
    'Nothing planned here. Fix that?'
  );
});

test('a second sentence on its own line is kept, not discarded', () => {
  // Found live: keeping only the first line threw away the half with the question
  // in it, and the line was then rejected for not asking anything — every time.
  const line = acceptOpening('Nothing here has been planned.\nShall we fix that?', 'asks');
  assert.equal(line, 'Nothing here has been planned. Shall we fix that?');
});

test('a question that ended in a full stop is repaired, not rejected', () => {
  // Found live, verbatim from the model: a genuinely good offer thrown away for
  // its final punctuation mark.
  const line = acceptOpening(
    "I could walk you through what's supposed to happen here and write it down. Would the second one help.",
    'asks'
  );
  assert.equal(line, "I could walk you through what's supposed to happen here and write it down. Would the second one help?");
});

test('two leading fillers and a dash do not hide the question', () => {
  // Found live: "Right then — what are you actually building..." was rejected
  // because only one leading filler was allowed for.
  const line = acceptOpening(
    'Right then — what are you actually building, or would you rather we found out together.',
    'asks'
  );
  assert.match(line ?? '', /together\?$/);
});

test('a question trailing a long clause is repaired', () => {
  // Verbatim from the model, rejected live: no sentence break before the question,
  // so the "last sentence" was the whole line and began "We could spend...".
  const real =
    'We could spend the next month watching you decide things twice, or we could sit down for twenty minutes and write them down once—shall we do that.';
  assert.match(acceptOpening(real, 'asks') ?? '', /shall we do that\?$/);
});

test('a line that asks nothing at all is still rejected', () => {
  // Repairing punctuation is fine; inventing the question would be putting words
  // in his mouth.
  assert.equal(acceptOpening('There is no plan in this project.', 'asks'), undefined);
});

test('the same line is fine when no question was wanted', () => {
  assert.equal(acceptOpening('There is no plan in this project.', 'states'), 'There is no plan in this project.');
});

test('enthusiasm and emoji are rejected, not repaired', () => {
  assert.equal(acceptOpening("Let's plan something great!", 'asks'), undefined);
  assert.equal(acceptOpening('No plan here 🙂 Shall we?', 'asks'), undefined);
});

test('an overlong line is rejected rather than truncated', () => {
  assert.equal(acceptOpening(`${'x'.repeat(340)}?`, 'asks'), undefined);
});

test('the real line the model wrote survives, punctuation and all', () => {
  const real =
    "We could continue the current arrangement, where each decision lives in someone's head until it doesn't, or I could write it down so we both know. Would the second one help.";
  assert.match(acceptOpening(real, 'asks') ?? '', /Would the second one help\?$/);
});

test('two real sentences fit inside the limit', () => {
  const real =
    'There is no plan.md in this project, which means the whole thing is currently held together by whatever you remember on any given morning. Shall we write one down?';
  assert.equal(acceptOpening(real, 'asks'), real);
});

test('nothing at all is undefined, not an empty string', () => {
  assert.equal(acceptOpening(undefined, 'asks'), undefined);
  assert.equal(acceptOpening('   ', 'asks'), undefined);
});

test('keep literals appear in the prompt when supplied', () => {
  // A line that lost the file or the line number would be a nicer sentence and a worse
  // answer, so the model is told exactly which words cannot be paraphrased away.
  const prompt = openingPrompt('an error is lingering', 'states', ['nanocode.py', 'line 18']);

  assert.match(prompt, /"nanocode\.py"/);
  assert.match(prompt, /"line 18"/);
  assert.match(prompt, /Weave these exact words/);
});

test('no keep list means no instruction about one', () => {
  assert.doesNotMatch(openingPrompt('a plan was just approved', 'states'), /Weave these exact words/);
});

test('an original line that drops a required literal is rejected', () => {
  // Rejection is cheap here — the written fallback was never wrong, only predictable —
  // so a livelier line that lost the file or the line number is thrown away rather than
  // kept, which would trade a correct notice for an incorrect one.
  const line = acceptOpening('That file has been sulking for a while.', 'states', ['nanocode.py', 'line 18']);

  assert.equal(line, undefined);
});

test('an original line that keeps every literal is accepted', () => {
  const line = acceptOpening('nanocode.py at line 18 is still unhappy about that quote.', 'states', [
    'nanocode.py',
    'line 18',
  ]);

  assert.equal(line, 'nanocode.py at line 18 is still unhappy about that quote.');
});
