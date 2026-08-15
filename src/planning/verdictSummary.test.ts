import test from 'node:test';
import assert from 'node:assert/strict';
import { formatVerdict } from './verdictSummary';
import { Finding } from './analysisPrompt';

const finding: Finding = {
  class: 'safety',
  what: 'Passwords are stored in plaintext.',
  whyItMatters: 'A leak exposes every password.',
  fixes: ['Hash and salt before storing.'],
};

test('an accepted finding renders as the original finding', () => {
  const lines = formatVerdict({ finding, status: 'accepted' });
  assert.match(lines[0], /Passwords are stored in plaintext/);
  assert.match(lines.join('\n'), /Hash and salt before storing/);
});

test('a rejected finding is struck through and carries the reason', () => {
  const lines = formatVerdict({ finding, status: 'rejected', reasoning: 'this is a prototype, never touches real users' });
  assert.match(lines[0], /~~.*Passwords are stored in plaintext.*~~/);
  assert.match(lines[0], /rejected/);
  assert.match(lines[1], /this is a prototype, never touches real users/);
});

test('a rejected finding with no reason still says so honestly', () => {
  const lines = formatVerdict({ finding, status: 'rejected' });
  assert.match(lines[1], /no reason given/);
});

test('a modified finding shows the user\'s version, not the original', () => {
  const lines = formatVerdict({ finding, status: 'modified', reasoning: 'Passwords are hashed but with no salt.' });
  assert.match(lines[0], /Passwords are hashed but with no salt/);
  assert.doesNotMatch(lines[0], /Passwords are stored in plaintext/);
});

test('a modified finding drops the original why-it-matters and suggested fix', () => {
  // Found live: a finding modified to "ESLint" still showed the original "name a
  // linter" fix underneath it — stale advice about a description the user replaced.
  const lines = formatVerdict({ finding, status: 'modified', reasoning: 'ESLint' });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines.join('\n'), /A leak exposes every password/);
  assert.doesNotMatch(lines.join('\n'), /Hash and salt before storing/);
});
