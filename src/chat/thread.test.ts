import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTurn, turnsForModel, Turn, MAX_TURNS, MAX_MODEL_TURNS } from './thread';

function turn(text: string, speaker: Turn['speaker'] = 'user'): Turn {
  return { speaker, text, at: 0 };
}

test('appendTurn keeps ordinary turns in order', () => {
  const thread = appendTurn(appendTurn([], turn('one')), turn('two', 'clarvis'));
  assert.deepEqual(
    thread.map((t) => t.text),
    ['one', 'two']
  );
});

test('appendTurn drops the oldest once the cap is passed', () => {
  let thread: Turn[] = [];
  for (let i = 0; i < MAX_TURNS + 5; i++) thread = appendTurn(thread, turn(`t${i}`), MAX_TURNS);
  assert.equal(thread.length, MAX_TURNS);
  assert.equal(thread[0].text, 't5'); // the first 5 were dropped
  assert.equal(thread[thread.length - 1].text, `t${MAX_TURNS + 4}`);
});

test('turnsForModel maps speakers to roles', () => {
  const thread = [turn('hello', 'user'), turn('hi there', 'clarvis')];
  assert.deepEqual(turnsForModel(thread), [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
  ]);
});

test('turnsForModel drops empty turns', () => {
  const thread = [turn('hello'), turn('   '), turn('')];
  assert.deepEqual(turnsForModel(thread), [{ role: 'user', content: 'hello' }]);
});

// F22 -- a polluted turn used to poison every later question because the whole,
// unbounded thread was resent to the model on every request.
test('turnsForModel sends only the most recent turns, not the whole thread', () => {
  const thread = Array.from({ length: MAX_MODEL_TURNS + 10 }, (_, i) => turn(`t${i}`));
  const sent = turnsForModel(thread);
  assert.equal(sent.length, MAX_MODEL_TURNS);
  assert.equal(sent[0].content, `t${10}`); // the oldest 10 were left out
  assert.equal(sent[sent.length - 1].content, `t${MAX_MODEL_TURNS + 9}`);
});

test('turnsForModel respects an explicit cap', () => {
  const thread = [turn('a'), turn('b'), turn('c')];
  assert.deepEqual(
    turnsForModel(thread, 2).map((t) => t.content),
    ['b', 'c']
  );
});
