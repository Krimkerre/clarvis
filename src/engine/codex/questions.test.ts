import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RequestView } from '../relay/relayTypes';
import { QuestionBoard } from './questions';

/**
 * Codex's open requests, as a window holds them: asked one at a time in the order they came, asked once,
 * and all let go the moment Stop is pressed.
 */

function request(id: string): RequestView {
  return { id, kind: 'command', turn_id: 't1', item_id: `i-${id}`, opened_at: '2026-09-13T01:42:00Z', payload: {}, allowed_decisions: ['once', 'skip', 'stop'] };
}

test('requests are asked one at a time, first in first out', () => {
  const board = new QuestionBoard();
  board.open(request('rq_1'));
  board.open(request('rq_2'));

  const first = board.next();
  assert.equal(first?.request.id, 'rq_1');
  assert.equal(board.next(), undefined, 'nothing else while rq_1 is on screen');

  board.answered('rq_1');
  assert.equal(board.next()?.request.id, 'rq_2');
});

test('a request replayed while held, or after it was answered, is not asked again', () => {
  const board = new QuestionBoard();
  assert.equal(board.open(request('rq_1')), true);
  assert.equal(board.open(request('rq_1')), false, 'held');

  board.next();
  board.answered('rq_1');
  assert.equal(board.open(request('rq_1')), false, 'answered');
});

test('resolved elsewhere: the one on screen is aborted, a queued one is dropped', () => {
  const board = new QuestionBoard();
  board.open(request('rq_1'));
  board.open(request('rq_2'));
  const showing = board.next();

  assert.equal(board.resolve('rq_2'), 'queued');
  assert.equal(board.resolve('rq_1'), 'showing');
  assert.equal(showing?.signal.aborted, true);
  assert.equal(board.stillAsking('rq_1'), false);
  assert.equal(board.resolve('rq_9'), 'unknown');
  assert.equal(board.size, 0);
});

test('Stop lets go of the question on screen and every queued one at once, and none comes back', () => {
  const board = new QuestionBoard();
  board.open(request('rq_1'));
  board.open(request('rq_2'));
  const showing = board.next();

  assert.equal(board.releaseAll(), 2);
  assert.equal(showing?.signal.aborted, true, 'the asker hears it in the same tick');
  assert.equal(board.size, 0);
  assert.equal(board.next(), undefined);
  assert.equal(board.open(request('rq_2')), false, 'a replay of a released request is an answer to nothing');
});

test('stillAsking is true only for the request on screen, until something ends it', () => {
  const board = new QuestionBoard();
  board.open(request('rq_1'));
  assert.equal(board.stillAsking('rq_1'), false, 'queued is not on screen');
  board.next();
  assert.equal(board.stillAsking('rq_1'), true);
  board.answered('rq_1');
  assert.equal(board.stillAsking('rq_1'), false);
});
