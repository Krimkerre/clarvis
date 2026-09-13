import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleNamed, fixture } from '../../test/fakes/relayContract';
import { answerKey, createSessionKey, freshKey, isIdempotencyKey } from './idempotency';

/**
 * The keys have to be exactly the contract's, not merely unique: RAVIS replays a create or an answer
 * by key, so a key made differently on a retry would start a second task or be refused.
 */

test("the create key is the contract's: sha256(taskId:windowId:attempt), with attempts counted from 1", () => {
  const created = exampleNamed('POST /api/v1/agent-sessions', 'created');
  const body = created.request.body as { clarvis_task_id: string; window: { id: string } };
  const fixtureKey = created.request.headers?.['Idempotency-Key'];

  assert.equal(createSessionKey(body.clarvis_task_id, body.window.id, 1), fixtureKey);
  assert.notEqual(createSessionKey(body.clarvis_task_id, body.window.id, 0), fixtureKey);
  assert.notEqual(createSessionKey(body.clarvis_task_id, body.window.id, 2), fixtureKey);
});

test("an answer's key is <request id>:<window id>, so two windows never share one", () => {
  assert.equal(answerKey('rq_01J9ZK6M3N4P5Q6R7S8T9V0W1X', 'win-desktop-1c9e4d'), fixture('agent-sessions.json').answer_key_example);
  assert.notEqual(answerKey('rq_1', 'win-a'), answerKey('rq_1', 'win-b'));
});

test('a key is 1-128 printable characters, and every key Clarvis makes is one', () => {
  assert.equal(isIdempotencyKey(freshKey()), true);
  assert.equal(isIdempotencyKey(createSessionKey('task', 'window', 1)), true);
  assert.equal(isIdempotencyKey(answerKey('rq_01J9ZK6M3N4P5Q6R7S8T9V0W1X', 'win-code-server-7f3a2b')), true);
  assert.equal(isIdempotencyKey('k'.repeat(128)), true);

  assert.equal(isIdempotencyKey('k'.repeat(129)), false);
  assert.equal(isIdempotencyKey(''), false);
  assert.equal(isIdempotencyKey(' leading'), false, 'HTTP trims the space, so RAVIS would store another key');
  assert.equal(isIdempotencyKey('tab\tinside'), false);
  assert.notEqual(freshKey(), freshKey());
});
