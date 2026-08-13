import test from 'node:test';
import assert from 'node:assert/strict';
import { conventionsSection, parseCommentStyle } from './conventions';

test('the universal rules are there whatever the language', () => {
  const section = conventionsSection('Python', 'lean');
  assert.match(section, /Names say what a thing is for/);
  assert.match(section, /One job per function/);
});

test('a known language gets its own idioms, named', () => {
  const python = conventionsSection('Python', 'lean');
  assert.match(python, /\*\*Python:\*\*/);
  assert.match(python, /PEP 8/);
  assert.match(python, /snake_case/);
});

test('the idioms are the language\'s own, not translated from another', () => {
  // Copying TypeScript-flavoured advice into a Python project is worse than saying
  // nothing: it reads as authoritative and is wrong.
  const python = conventionsSection('Python', 'lean');
  assert.doesNotMatch(python, /camelCase/);
  assert.doesNotMatch(python, /No `any`/);

  const go = conventionsSection('Go', 'lean');
  assert.match(go, /gofmt/);
  assert.doesNotMatch(go, /PEP 8/);
});

test('a language is matched however it was said', () => {
  // The interview records whatever the user typed — "Python 3", "TypeScript (Node)".
  assert.match(conventionsSection('Python 3.12', 'lean'), /\*\*Python:\*\*/);
  assert.match(conventionsSection('TypeScript (Node)', 'lean'), /No `any`/);
  assert.match(conventionsSection('rust', 'lean'), /cargo fmt/);
});

test('an unknown language says so rather than inventing idioms', () => {
  // The person most in need of these rules is exactly the person who cannot tell
  // which ones were made up.
  const section = conventionsSection('Elixir', 'lean');

  assert.match(section, /nobody has written the specific idioms/);
  assert.match(section, /Elixir/);
  // The universal rules still apply, and are still there.
  assert.match(section, /One job per function/);
});

test('no language chosen is stated plainly', () => {
  assert.match(conventionsSection(undefined, 'lean'), /No language chosen yet/);
});

test('the comment decision is written in, both ways', () => {
  assert.match(conventionsSection('Python', 'explanatory'), /Comments throughout/);
  assert.match(conventionsSection('Python', 'lean'), /only where something is genuinely surprising/);
});

test('an undecided comment style asks for a decision rather than picking one', () => {
  // Neither is correct — this project chose explanatory and said why, the source
  // ruleset chose lean and said why. The user owns the call for their own code.
  assert.match(conventionsSection('Python', undefined), /Not decided/);
});

test('comments staying true is stated whatever the style', () => {
  // Not a preference: a comment describing what the code used to do is confidently
  // wrong documentation that survives review.
  for (const style of ['explanatory', 'lean', undefined] as const) {
    assert.match(conventionsSection('Python', style), /correctness, not taste/);
  }
});

test('the answer is read back as a setting', () => {
  assert.equal(parseCommentStyle('lean, the code should explain itself'), 'lean');
  assert.equal(parseCommentStyle('comments throughout please'), 'explanatory');
  assert.equal(parseCommentStyle("I'm still learning, explain things"), 'explanatory');
});

test('an unclear answer stays undecided rather than being guessed', () => {
  assert.equal(parseCommentStyle('yes'), undefined);
  assert.equal(parseCommentStyle(''), undefined);
  assert.equal(parseCommentStyle(undefined), undefined);
});
