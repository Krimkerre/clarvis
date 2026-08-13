import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptOpening, openingPrompt } from './originalLine';

test('the prompt carries the situation and demands a question when one is wanted', () => {
  const prompt = openingPrompt('this project has no plan.md', true);
  assert.match(prompt, /no plan\.md/);
  assert.match(prompt, /end by asking them/);
});

test('a statement is asked for plainly when no question is wanted', () => {
  assert.match(openingPrompt('a plan was just approved', false), /Not a question/);
});

test('a good line survives intact', () => {
  const line = acceptOpening('No plan here. Shall we do something about that?', true);
  assert.equal(line, 'No plan here. Shall we do something about that?');
});

test('a preface is stripped, quotes with it', () => {
  assert.equal(
    acceptOpening('Clarvis: "Nothing planned here. Fix that?"', true),
    'Nothing planned here. Fix that?'
  );
});

test('a second sentence on its own line is kept, not discarded', () => {
  // Found live: keeping only the first line threw away the half with the question
  // in it, and the line was then rejected for not asking anything — every time.
  const line = acceptOpening('Nothing here has been planned.\nShall we fix that?', true);
  assert.equal(line, 'Nothing here has been planned. Shall we fix that?');
});

test('a line that forgot to ask is rejected', () => {
  assert.equal(acceptOpening('There is no plan in this project.', true), undefined);
});

test('the same line is fine when no question was wanted', () => {
  assert.equal(acceptOpening('There is no plan in this project.', false), 'There is no plan in this project.');
});

test('enthusiasm and emoji are rejected, not repaired', () => {
  assert.equal(acceptOpening("Let's plan something great!", true), undefined);
  assert.equal(acceptOpening('No plan here 🙂 Shall we?', true), undefined);
});

test('an overlong line is rejected rather than truncated', () => {
  assert.equal(acceptOpening(`${'x'.repeat(260)}?`, true), undefined);
});

test('two real sentences fit inside the limit', () => {
  const real =
    'There is no plan.md in this project, which means the whole thing is currently held together by whatever you remember on any given morning. Shall we write one down?';
  assert.equal(acceptOpening(real, true), real);
});

test('nothing at all is undefined, not an empty string', () => {
  assert.equal(acceptOpening(undefined, true), undefined);
  assert.equal(acceptOpening('   ', true), undefined);
});
