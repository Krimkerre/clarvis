import test from 'node:test';
import assert from 'node:assert/strict';
import { isSmallVerdict, smallTaskPrompt } from './smallTask';

/** The short way is offered only on a plain SMALL; anything else keeps the full interview. */

test('only a clear SMALL is small', () => {
  assert.equal(isSmallVerdict('SMALL'), true);
  assert.equal(isSmallVerdict(' small.\n'), true);
  assert.equal(isSmallVerdict('FULL'), false);
  assert.equal(isSmallVerdict('SMALL or FULL, hard to say'), false, 'both words is doubt');
  assert.equal(isSmallVerdict(''), false, 'no reply is no shortcut');
  assert.equal(isSmallVerdict('It seems smallish'), false);
});

test('the prompt sends anything touching data, credentials or the network to the full interview', () => {
  const prompt = smallTaskPrompt("a Python script that prints today's date");
  for (const guard of ['passwords or keys', 'personal data', 'storing data', 'the network', 'whenever you are unsure']) {
    assert.ok(prompt.includes(guard), `the prompt should name: ${guard}`);
  }
  assert.ok(prompt.endsWith("The task: a Python script that prints today's date"));
});
