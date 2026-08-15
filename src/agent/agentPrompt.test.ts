import test from 'node:test';
import assert from 'node:assert/strict';
import { agentSystemPrompt } from './agentPrompt';

test('the brief names the folder it is working in', () => {
  // Found live twice: a path repeating the workspace folder's own name, and a run that
  // spent a step on `cd /Users/clarvis; find / -maxdepth 1 -name "*.git"` — inventing a
  // location from the product name. Everything it knew about where it was came from
  // command output; nothing came from us.
  const brief = agentSystemPrompt(false, '/Users/me/weather-cli');

  assert.match(brief, /\/Users\/me\/weather-cli/);
  assert.match(brief, /relative to that folder/);
});

test('answering turns are told where they are too', () => {
  assert.match(agentSystemPrompt(true, '/Users/me/weather-cli'), /\/Users\/me\/weather-cli/);
});

test('no folder means no sentence about one', () => {
  // A window with no folder open is a real state, and inventing a root for it would be
  // the exact failure this fixes.
  assert.doesNotMatch(agentSystemPrompt(false), /You are working in/);
});
