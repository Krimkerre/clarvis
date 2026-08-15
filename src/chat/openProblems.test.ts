import test from 'node:test';
import assert from 'node:assert/strict';
import { LISTED, nothingWrong, problemLines, summariseProblems } from './openProblems';

const problem = (line: number, message: string, severity: 'error' | 'warning' = 'error') => ({
  line,
  message,
  severity,
});

test('errors come before warnings, whatever order the editor reported them', () => {
  // The first thing named should be the first thing to fix; a warning on line 2 is not
  // more urgent than an error on line 40 just because it is higher up the file.
  const summary = summariseProblems('nanocode.py', [
    problem(2, 'unused import', 'warning'),
    problem(40, 'undefined name "reponse"'),
  ]);

  assert.equal(summary?.items[0].message, 'undefined name "reponse"');
});

test('within a severity, the file order is kept', () => {
  const summary = summariseProblems('nanocode.py', [problem(19, 'b'), problem(4, 'a')]);

  assert.deepEqual(summary?.items.map((item) => item.line), [4, 19]);
});

test('a long list is capped and says how many were left', () => {
  // A file mid-refactor carries forty; forty lines of squiggle in a conversation is a
  // log rather than an answer.
  const many = Array.from({ length: 12 }, (_, i) => problem(i + 1, `problem ${i}`));
  const summary = summariseProblems('big.py', many)!;

  assert.equal(summary.items.length, LISTED);
  assert.equal(summary.more, 12 - LISTED);
  assert.match(problemLines(summary).at(-1)!, /and 7 more/);
});

test('a clean file summarises to nothing at all', () => {
  assert.equal(summariseProblems('nanocode.py', []), undefined);
});

test('the lines name the file, the line number and the message', () => {
  const lines = problemLines(summariseProblems('nanocode.py', [problem(19, 'unterminated string literal')])!);

  assert.match(lines[0], /nanocode\.py/);
  assert.match(lines[1], /line 19/);
  assert.match(lines[1], /unterminated string literal/);
});

test('a clean file is said out loud, not left as silence', () => {
  // The whole reason this exists: a quiet Clarvis was indistinguishable from a broken
  // one, and "nothing wrong" is only useful if it names what it looked at.
  assert.match(nothingWrong('nanocode.py'), /nanocode\.py/);
  assert.match(nothingWrong(undefined), /Nothing open to look at/);
});
