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
  assert.equal(acceptOpening(`${'x'.repeat(200)}?`, true), undefined);
});

test('nothing at all is undefined, not an empty string', () => {
  assert.equal(acceptOpening(undefined, true), undefined);
  assert.equal(acceptOpening('   ', true), undefined);
});
