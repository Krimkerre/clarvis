import test from 'node:test';
import assert from 'node:assert/strict';
import { firstChangedLine } from './firstChangedLine';

test('a changed line in the middle is found', () => {
  assert.equal(firstChangedLine('a\nb\nc', 'a\nB\nc'), 1);
});

test('a change on the first line is line zero', () => {
  assert.equal(firstChangedLine('a\nb', 'A\nb'), 0);
});

test('an append points at the first new line, not the end', () => {
  assert.equal(firstChangedLine('a\nb', 'a\nb\nc'), 2);
});

test('a deletion points at where the removed text was', () => {
  assert.equal(firstChangedLine('a\nb\nc', 'a\nb'), 1);
});

test('identical files point at the last line rather than past the end', () => {
  // Never happens through `commit` — an edit that changes nothing is not applied —
  // but returning a line number outside the document would throw at the call site.
  assert.equal(firstChangedLine('a\nb', 'a\nb'), 1);
});

test('an empty file gaining content starts at the top', () => {
  assert.equal(firstChangedLine('', 'hello'), 0);
});
