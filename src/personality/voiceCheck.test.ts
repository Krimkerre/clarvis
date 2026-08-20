import test from 'node:test';
import assert from 'node:assert/strict';
import { factsGiven } from './voiceCheck';
import { ungroundedClaims } from './grounded';

/**
 * The regression this exists for.
 *
 * `voiceCheck` scored a reply against `scene.system` alone, so a scene whose facts arrive
 * as a *tool result* judged the model against a set that excluded them. Observed 20 Aug on
 * Haiku 4.5: it quoted `Rule 1`, `Rule 2` and `Rule 3` back from the file excerpt it had
 * been shown, and the report called all three numbers nobody gave it.
 */
test('a number quoted back from a tool result is not invented', () => {
  const scene = {
    system: 'You are a butler in a code editor.',
    messages: [
      { role: 'user' as const, content: 'read plan.md and tell me what you think' },
      { role: 'assistant' as const, content: 'readFile plan.md' },
      { role: 'user' as const, content: 'Tool result (readFile plan.md):\nRule 1: never cheerful about a failure.\nRule 2: the sharper register is earned.' },
    ],
  };

  assert.deepEqual(ungroundedClaims('Rule 1 is sound. Rule 2 is the hard one.', factsGiven(scene)), []);
  // And the check still bites when the number really was not given.
  assert.notDeepEqual(ungroundedClaims('Rule 9 is the one you keep breaking.', factsGiven(scene)), []);
});

test('the system prompt is still part of the facts', () => {
  const scene = { system: 'Still failing: "probe-build-fail" (exit 1), 40 minutes ago', messages: [] };

  assert.deepEqual(ungroundedClaims('It has been failing for 40 minutes.', factsGiven(scene)), []);
});
