import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUFFER_SIZE, EventStream, frame, type BridgeEvent } from './events';

const held = () => new EventStream(() => 0);

test('an event gets a monotonic id and a timestamp', () => {
  const stream = held();

  stream.emit('clarvis.agent.started', { activity_id: 'r1' });
  stream.emit('clarvis.agent.step', {});

  const [first, second] = stream.since(0);
  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
  assert.match(first.occurred_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
});

test('a listener hears what is published after it attaches', () => {
  const stream = held();
  const heard: string[] = [];
  stream.listen((event) => heard.push(event.name));

  stream.emit('clarvis.chat.started', {});

  assert.deepEqual(heard, ['clarvis.chat.started']);
});

test('a removed listener hears nothing more', () => {
  const stream = held();
  const heard: string[] = [];
  const stop = stream.listen((event) => heard.push(event.name));

  stop();
  stream.emit('clarvis.chat.started', {});

  assert.deepEqual(heard, []);
  assert.equal(stream.listenerCount, 0);
});

test('one broken listener does not stop the others hearing', () => {
  // §6.5: telemetry failure can never delay or fail editor work — and one
  // consumer's bug must not become every consumer's silence.
  const stream = held();
  const heard: string[] = [];
  stream.listen(() => {
    throw new Error('this consumer is broken');
  });
  stream.listen((event) => heard.push(event.name));

  stream.emit('clarvis.agent.failed', {});

  assert.deepEqual(heard, ['clarvis.agent.failed']);
});

test('a listener that threw is dropped rather than called again', () => {
  const stream = held();
  let calls = 0;
  stream.listen(() => {
    calls += 1;
    throw new Error('broken');
  });

  stream.emit('clarvis.agent.step', {});
  stream.emit('clarvis.agent.step', {});

  assert.equal(calls, 1);
  assert.equal(stream.listenerCount, 0);
});

test('emitting never throws, whatever the listeners do', () => {
  const stream = held();
  stream.listen(() => {
    throw new Error('broken');
  });

  assert.doesNotThrow(() => stream.emit('clarvis.lifecycle.ready', {}));
});

// ── The bound buffer ────────────────────────────────────────────────────────

test('the buffer is bounded and the overflow is counted', () => {
  // §6.5 says buffering is bounded in as many words. An unbounded one is an
  // editor that runs out of memory because somebody closed a dashboard.
  const stream = held();

  for (let i = 0; i < BUFFER_SIZE + 10; i += 1) stream.emit('clarvis.agent.step', {});

  assert.equal(stream.since(0).length, BUFFER_SIZE);
  assert.equal(stream.droppedCount, 10);
});

test('the oldest events are the ones dropped', () => {
  const stream = held();

  for (let i = 0; i < BUFFER_SIZE + 5; i += 1) stream.emit('clarvis.agent.step', {});

  assert.equal(stream.since(0)[0].id, 6, 'events 1-5 should have fallen out');
});

test('nothing dropped is reported as nothing dropped', () => {
  const stream = held();
  stream.emit('clarvis.agent.step', {});

  assert.equal(stream.droppedCount, 0);
});

test('since() returns only what follows the cursor', () => {
  const stream = held();
  stream.emit('clarvis.agent.started', {});
  stream.emit('clarvis.agent.step', {});
  stream.emit('clarvis.agent.completed', {});

  assert.deepEqual(stream.since(2).map((e) => e.name), ['clarvis.agent.completed']);
});

test('a cursor of zero means everything still held, not nothing', () => {
  // A fresh consumer sends no Last-Event-ID, and giving it silence would make it
  // wait for the next event before it could show anything at all.
  const stream = held();
  stream.emit('clarvis.agent.started', {});

  assert.equal(stream.since(0).length, 1);
});

test('the cursor is zero before anything is published', () => {
  assert.equal(held().cursor, 0);
});

// ── Framing ─────────────────────────────────────────────────────────────────

const anEvent = (data: BridgeEvent['data']): BridgeEvent => ({
  id: 7,
  name: 'clarvis.gate.requested',
  occurred_at: '2026-08-29T00:00:00Z',
  data,
  trace_id: '',
  event_id: 'e'.repeat(32),
});

test('a frame carries the id, the name and one data line', () => {
  const text = frame(anEvent({ awaiting: 'command' }));

  assert.match(text, /^id: 7\n/);
  assert.match(text, /\nevent: clarvis\.gate\.requested\n/);
  assert.ok(text.endsWith('\n\n'), 'a frame that does not end blank is never delivered');
});

test('a newline in a value cannot split the frame', () => {
  // The reason the body is JSON rather than something more readable: a raw
  // newline inside a `data:` value ends the frame early, and the consumer would
  // read the remainder as a new event.
  const text = frame(anEvent({ detail: 'one\ntwo' }));

  assert.equal(text.split('\n\n').length, 2, 'the frame was split in two');
  assert.match(text, /one\\ntwo/);
});

test('the whole payload is on a single data line', () => {
  const dataLines = frame(anEvent({ a: 1, b: 'two', c: true }))
    .split('\n')
    .filter((line) => line.startsWith('data: '));

  assert.equal(dataLines.length, 1);
  assert.deepEqual(JSON.parse(dataLines[0].slice(6)).data, { a: 1, b: 'two', c: true });
});
