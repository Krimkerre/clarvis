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

function site(id: string): RequestView {
  return { ...request(id), kind: 'site', payload: { host: 'pypi.org', protocol: 'https' }, allowed_decisions: ['allow_site', 'keep_blocked'] };
}

test("a site ask waits behind Codex's own requests, each kind in the order it came; one already on screen stays there", () => {
  const board = new QuestionBoard();
  board.open(site('rq_site_1'));
  board.open(request('rq_1'));
  board.open(site('rq_site_2'));
  board.open(request('rq_2'));
  const order: string[] = [];
  for (let asking = board.next(); asking; asking = board.next()) {
    order.push(asking.request.id);
    board.answered(asking.request.id);
  }
  assert.deepEqual(order, ['rq_1', 'rq_2', 'rq_site_1', 'rq_site_2']);

  const showingSite = new QuestionBoard();
  showingSite.open(site('rq_site'));
  showingSite.next();
  showingSite.open(request('rq_later'));
  assert.equal(showingSite.next(), undefined, 'the site ask on screen is not taken away for a later request');
  assert.equal(showingSite.stillAsking('rq_site'), true);
});

test('a request put back is asked next, as RAVIS now offers it; one RAVIS resolved, or Stop let go, never comes back', () => {
  const board = new QuestionBoard();
  board.open(request('rq_1'));
  board.open(request('rq_2'));
  board.next();
  board.answered('rq_1');

  assert.equal(board.redraw({ ...request('rq_1'), allowed_decisions: ['skip', 'stop'] }), true);
  const again = board.next();
  assert.equal(again?.request.id, 'rq_1', 'ahead of rq_2');
  assert.deepEqual(again?.request.allowed_decisions, ['skip', 'stop']);
  assert.equal(board.redraw(request('rq_1')), false, 'already held');

  board.resolve('rq_1');
  assert.equal(board.redraw(request('rq_1')), false, 'RAVIS resolved it');
  board.releaseAll();
  assert.equal(board.redraw(request('rq_2')), false, 'Stop let it go');
  assert.equal(board.size, 0);
});

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
