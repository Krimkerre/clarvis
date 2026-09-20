import test from 'node:test';
import assert from 'node:assert/strict';
import { Session } from './history';
import {
  emptyFile,
  fileLeftovers,
  fromMementos,
  parseFile,
  withoutSession,
  withSession,
} from './transcriptFile';

/**
 * The rules for the file conversations are kept in (20 September 2026).
 *
 * Written after E-C7's recovery test found that `workspaceState` is the *browser's* in
 * code-server: the extension host was killed mid-answer, the question survived, and nothing had
 * been written on the machine at all. These pin what the file does when two windows share a
 * workspace, when a window crashed, and when the old key-value store is all there is.
 */

const said = (text: string, at = 1): Session => ({ startedAt: at, turns: [{ speaker: 'user', text, at }] });

test('a window writes its own session and leaves every other window alone', () => {
  const both = withSession(withSession(emptyFile('/p'), 'a', said('from A'), 10), 'b', said('from B'), 11);

  const afterA = withSession(both, 'a', said('A again'), 12);

  assert.deepEqual(afterA.live.map((one) => one.id).sort(), ['a', 'b']);
  assert.equal(afterA.live.find((one) => one.id === 'b')?.session.turns[0].text, 'from B',
    "a whole-file write would have dropped the other window's turn");
  assert.equal(afterA.live.find((one) => one.id === 'a')?.session.turns[0].text, 'A again');
});

test('what a window that is gone left behind is filed, newest conversation first', () => {
  const file = withSession(withSession(emptyFile('/p'), 'old', said('yesterday', 1), 10),
                           'older', said('before that', 0), 5);

  const { file: after, filed } = fileLeftovers(file, 'mine', 100);

  assert.deepEqual(filed.map((one) => one.turns[0].text), ['before that', 'yesterday']);
  assert.deepEqual(after.history.map((one) => one.turns[0].text), ['yesterday', 'before that']);
  assert.deepEqual(after.live, [], 'nothing is left live once it is filed');
});

test('a window still open keeps its conversation', () => {
  const file = withSession(withSession(emptyFile('/p'), 'other', said('still talking'), 500),
                           'mine', said('mine'), 500);

  const { file: after, filed } = fileLeftovers(file, 'mine', 100);

  assert.deepEqual(filed, [], 'it has been written since this window started, so it is not leftover');
  assert.deepEqual(after.live.map((one) => one.id).sort(), ['mine', 'other']);
});

test('an empty conversation is not filed, and nothing else changes', () => {
  const file = withSession(emptyFile('/p'), 'old', { startedAt: 1, turns: [] }, 10);

  const { file: after, filed } = fileLeftovers(file, 'mine', 100);

  assert.deepEqual(filed.map((one) => one.turns.length), [0]);
  assert.deepEqual(after.history, [], 'archiveSession drops an empty session');
});

test('clearing takes this window out of the file, not only out of the panel', () => {
  const file = withSession(withSession(emptyFile('/p'), 'mine', said('secret'), 10), 'other', said('theirs'), 10);

  const after = withoutSession(file, 'mine');

  assert.deepEqual(after.live.map((one) => one.id), ['other']);
  assert.equal(JSON.stringify(after).includes('secret'), false, 'a delete is a delete');
});

test('a workspace that has never been written is built from the old key-value store', () => {
  const file = fromMementos('/p', said('unfinished'), [said('earlier')], 99);

  assert.equal(file.live[0].session.turns[0].text, 'unfinished');
  assert.equal(file.live[0].updatedAt, 99);
  assert.deepEqual(file.history.map((one) => one.turns[0].text), ['earlier']);
  assert.equal(file.folder, '/p');
});

test('a file half-written, hand-edited or from an older build degrades to fewer conversations', () => {
  assert.deepEqual(parseFile('not a file', '/p'), emptyFile('/p'));
  assert.deepEqual(parseFile({ folder: '/p', live: 'nonsense', history: [{ nope: 1 }] }, '/p'), emptyFile('/p'));

  const partly = parseFile({
    folder: '/p',
    live: [{ id: 'a', session: said('kept') }, { session: said('no id') }, 'rubbish'],
    history: [said('also kept'), { startedAt: 'soon' }],
  }, '/p');

  assert.deepEqual(partly.live.map((one) => one.id), ['a']);
  assert.equal(partly.live[0].updatedAt, partly.live[0].session.startedAt, 'a missing time falls back');
  assert.deepEqual(partly.history.map((one) => one.turns[0].text), ['also kept']);
});

test("the workspace's own path travels in the file, so a moved folder is recognisable", () => {
  assert.equal(parseFile({ folder: '/somewhere/else', live: [], history: [] }, '/p').folder, '/somewhere/else');
  assert.equal(parseFile({ live: [], history: [] }, '/p').folder, '/p', 'and an older file gets this one');
});
