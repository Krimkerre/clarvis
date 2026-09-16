import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchedStream, type ModelCall, type WatchedCall } from './callWatch';
import { ModelError, type StreamEvent } from './ModelProvider';

/**
 * §6.4's `clarvis.model.*`, as `ModelService` produces them: every stream it hands
 * out passes through `watchedStream`, so these are the events for every caller.
 */

const CALL: ModelCall = {
  role: 'agent', provider: 'custom', model: 'ravis/clarvis-agent',
  requestId: 'r1', traceId: 't1', sessionId: 's1',
};

/** A clock that moves only when told, and the told calls in order. */
function watch() {
  let clock = 1_000;
  const told: WatchedCall[] = [];
  return {
    told,
    tick: (ms: number) => { clock += ms; },
    now: () => clock,
    tell: (watched: WatchedCall) => told.push(watched),
  };
}

async function* items<T>(list: T[], between: () => void = () => {}): AsyncGenerator<T> {
  for (const item of list) {
    between();
    yield item;
  }
}

async function drain<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const seen: T[] = [];
  for await (const item of stream) seen.push(item);
  return seen;
}

test('a request that answers is told when it is made and when it ends, with its counts', async () => {
  const w = watch();
  const events: StreamEvent[] = [
    { type: 'text', text: 'Looking' },
    { type: 'toolCall', call: { id: 'c1', name: 'readFile', args: { path: 'a' } } },
    { type: 'text', text: '.' },
    { type: 'stop', reason: 'tools' },
  ];
  let opened = false;
  const stream = watchedStream(CALL, () => { opened = true; return items(events, () => w.tick(10)); }, w.tell, w.now);

  assert.equal(opened, false, 'nothing is requested until the stream is read');
  assert.equal(w.told.length, 0);
  const seen = await drain(stream);

  assert.deepEqual(seen, events, 'every item passes unchanged');
  assert.deepEqual(w.told.map((c) => c.phase), ['requested', 'completed']);
  assert.deepEqual(w.told[0], { ...CALL, phase: 'requested' });
  assert.deepEqual(w.told[1], {
    ...CALL, phase: 'completed', result: 'answered',
    elapsedMs: 40, firstOutputMs: 10, textChunks: 2, toolCalls: 1,
  });
});

test('a plain text stream counts its fragments', async () => {
  const w = watch();
  await drain(watchedStream(CALL, () => items(['a', 'b', 'c']), w.tell, w.now));
  assert.equal(w.told[1].textChunks, 3);
  assert.equal(w.told[1].toolCalls, 0);
});

test('a failure is told as failed, with whether a retry could work, and rethrown as it was', async () => {
  const w = watch();
  const failure = new ModelError('RAVIS is busy.', 'HTTP 429: secret body text', true);
  async function* failing(): AsyncGenerator<string> {
    yield 'partial';
    throw failure;
  }

  await assert.rejects(drain(watchedStream(CALL, failing, w.tell, w.now)), (error) => error === failure);

  const ended = w.told[1];
  assert.equal(ended.phase, 'failed');
  assert.equal(ended.result, 'error');
  assert.equal(ended.retryable, true);
  assert.equal(ended.textChunks, 1);
  assert.ok(!JSON.stringify(ended).includes('secret'), 'the reason never travels');
});

test('an error that is not a ModelError says nothing about retrying', async () => {
  const w = watch();
  async function* failing(): AsyncGenerator<string> {
    throw new TypeError('fetch failed');
  }
  await assert.rejects(drain(watchedStream(CALL, failing, w.tell, w.now)));
  assert.equal(w.told[1].phase, 'failed');
  assert.equal('retryable' in w.told[1], false);
  assert.equal('firstOutputMs' in w.told[1], false, 'nothing arrived, so no first-output time');
});

test('a stop is not a failure', async () => {
  const w = watch();
  async function* stopped(): AsyncGenerator<string> {
    yield 'a';
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    throw abort;
  }
  await assert.rejects(drain(watchedStream(CALL, stopped, w.tell, w.now)));
  assert.equal(w.told[1].phase, 'completed');
  assert.equal(w.told[1].result, 'cancelled');
});

test('a reader that stops reading early still ends the request, once, and closes the one underneath', async () => {
  const w = watch();
  let closed = false;
  async function* long(): AsyncGenerator<string> {
    try {
      yield 'a';
      yield 'b';
      yield 'c';
    } finally {
      closed = true;
    }
  }

  for await (const item of watchedStream(CALL, long, w.tell, w.now)) {
    if (item === 'a') break;
  }

  assert.equal(closed, true, 'the adapter underneath is closed too');
  assert.deepEqual(w.told.map((c) => [c.phase, c.result]), [['requested', undefined], ['completed', 'closed']]);
});
