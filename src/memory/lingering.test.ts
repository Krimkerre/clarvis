import test from 'node:test';
import assert from 'node:assert/strict';
import { LINGER_MS, lingeringLine } from './lingering';

test('the wait is minutes — long enough to not be a linter, short enough to matter', () => {
  // On the keystroke it is a linter. In ten minutes it is a historian. Anything fixed
  // inside the window was work in progress, and work in progress is nobody's business.
  assert.ok(LINGER_MS >= 60_000, 'a minute is still mid-thought');
  assert.ok(LINGER_MS <= 5 * 60_000, 'past five minutes it has stopped being help');
});

test('the line names the file, the gutter line, and what the editor said', () => {
  const line = lingeringLine('nanocode.py', 19, 'unterminated string literal');

  assert.match(line, /nanocode\.py/);
  assert.match(line, /line 19/);
  assert.match(line, /unterminated string literal/);
});

test('the duration is vague, because only the vague version is true', () => {
  // We started the clock, so "a few minutes" is measured. Nothing reports when a
  // diagnostic first appeared, so anything more precise would be the invented
  // "for the past six minutes" that produced §2's rule in the first place.
  const line = lingeringLine('a.py', 1, 'x');

  assert.match(line, /a few minutes/);
  assert.doesNotMatch(line, /\b\d+ (minutes|seconds)\b/);
});

test('it is about the file, not about the person', () => {
  // Rule 4. The file has a problem; the reader is not being told off for it.
  const line = lingeringLine('nanocode.py', 19, 'unterminated string literal');

  assert.doesNotMatch(line, /\byou\b|\byour\b/i);
});
