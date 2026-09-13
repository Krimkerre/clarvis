import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeRavisRelay, FIXTURE_SESSION, fakeHttp } from '../../test/fakes/FakeRavisRelay';
import { EVENTS_ROUTE, exampleNamed, fixture } from '../../test/fakes/relayContract';
import { RelayClient } from './relayClient';
import { RelayEventStream, SseFrameParser, type EventStreamOptions, type StreamItem } from './sseReader';

/**
 * The event stream against `FakeRavisRelay`, through each way a stream goes wrong: dropped, silent,
 * slow, sent twice, too far behind to replay, refused, and RAVIS gone and back. Each test checks what
 * the owner would otherwise notice — a question lost, or asked twice — as event ids.
 */

const SID = FIXTURE_SESSION.id;
const WINDOW = 'win-desktop-1c9e4d';

// ── The frame parser ────────────────────────────────────────────────────────

test('frames come out whole wherever the chunks split, CRLF and multi-line data included', () => {
  const text =
    'retry: 3000\r\n\r\nid: 1235\r\nevent: request.opened\r\ndata: {"a":1}\r\n\r\n: heartbeat\r\n\r\nid: 1236\ndata: line one\ndata: line two\n\n';
  const expected = [
    { id: '1235', event: 'request.opened', data: '{"a":1}' },
    { id: '1236', event: 'message', data: 'line one\nline two' },
  ];

  for (let size = 1; size <= text.length; size++) {
    const parser = new SseFrameParser();
    const frames = [];
    for (let at = 0; at < text.length; at += size) frames.push(...parser.push(text.slice(at, at + size)));
    assert.deepEqual(frames, expected, `in chunks of ${size}`);
    assert.equal(parser.retry, 3000);
  }
});

test("a frame without an id of its own doesn't inherit the one before it", () => {
  assert.deepEqual(new SseFrameParser().push('id: 7\ndata: {}\n\ndata: {}\n\n'), [
    { id: '7', event: 'message', data: '{}' },
    { id: undefined, event: 'message', data: '{}' },
  ]);
});

test("the contract's frames text parses into its frame", () => {
  const frames = new SseFrameParser().push(fixture('event-stream.json').frames_text);

  assert.equal(frames.length, 1);
  assert.deepEqual([frames[0].id, frames[0].event], ['1235', 'request.opened']);
});

// ── The reconnecting reader ─────────────────────────────────────────────────

interface Reading {
  stream: RelayEventStream;
  items: StreamItem[];
  /** Reads until an item matches, and returns it. Fails, listing what came, if the stream ends first. */
  next(match: (item: StreamItem) => boolean, timeoutMs?: number): Promise<StreamItem>;
}

function reading(fake: FakeRavisRelay, options: Partial<EventStreamOptions>): Reading {
  const stream = new RelayEventStream({
    client: new RelayClient(fakeHttp(fake)),
    sessionId: SID,
    token: FIXTURE_SESSION.token,
    windowId: WINDOW,
    host: 'desktop',
    backoffMs: [20, 40, 80],
    silenceLimitMs: 5_000,
    ...options,
  });
  const iterator = stream[Symbol.asyncIterator]();
  const items: StreamItem[] = [];
  return {
    stream,
    items,
    async next(match, timeoutMs = 5_000) {
      const timer = setTimeout(() => stream.close(), timeoutMs);
      try {
        for (;;) {
          const result = await iterator.next();
          if (result.done) throw new Error(`the stream ended first; it gave ${JSON.stringify(items)}`);
          items.push(result.value);
          if (match(result.value)) return result.value;
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function withFake(run: (fake: FakeRavisRelay, open: (options?: Partial<EventStreamOptions>) => Reading) => Promise<void>): Promise<void> {
  const fake = await FakeRavisRelay.start();
  fake.stream().heartbeatMs = 100;
  const opened: Reading[] = [];
  try {
    await run(fake, (options = {}) => {
      const next = reading(fake, options);
      opened.push(next);
      return next;
    });
    assert.deepEqual(fake.violations, [], 'every frame and answer matched the fixtures');
  } finally {
    for (const open of opened) open.stream.close();
    await fake.close();
  }
}

const anEvent =
  (event?: string) =>
  (item: StreamItem): boolean =>
    item.type === 'event' && (event === undefined || item.event === event);

const eventIds = (items: StreamItem[]) => items.flatMap((item) => (item.type === 'event' ? [item.id] : []));

test("without a cursor the stream opens with the contract's snapshot, then live events", () =>
  withFake(async (fake, open) => {
    const frames = exampleNamed(EVENTS_ROUTE, 'first connection, no cursor').response.frames ?? [];
    const read = open();

    assert.deepEqual(await read.next(anEvent()), { type: 'event', id: frames[0].id, event: 'snapshot', data: frames[0].data });
    fake.stream().emitExample('request.opened');
    assert.deepEqual(await read.next(anEvent()), { type: 'event', id: frames[1].id, event: 'request.opened', data: frames[1].data });

    assert.equal(read.items[0].type, 'connected');
    assert.equal(read.stream.cursor, 1235);
    assert.deepEqual(fake.stream().connects, [{ lastEventId: undefined, after: null, windowId: WINDOW, host: 'desktop' }]);
  }));

test('a stored cursor resumes with Last-Event-ID and replays only what came after it', () =>
  withFake(async (fake, open) => {
    const example = exampleNamed(EVENTS_ROUTE, 'resumed after 1234');
    fake.stream().emitExample('request.opened');
    const read = open({ cursor: 1234 });

    const first = await read.next(anEvent());

    assert.deepEqual(first, { type: 'event', id: 1235, event: 'request.opened', data: example.response.frames?.[0].data });
    assert.deepEqual(
      fake.stream().connects.map((connect) => [connect.lastEventId, connect.after]),
      [[example.request.headers?.['Last-Event-ID'], null]]
    );
  }));

test('a dropped connection reconnects from its cursor: nothing is lost, and nothing arrives twice', () =>
  withFake(async (fake, open) => {
    const events = fake.stream();
    const read = open();
    await read.next(anEvent('snapshot'));
    events.emitExample('request.opened');
    await read.next(anEvent('request.opened'));

    events.disconnect();
    const dropped = await read.next((item) => item.type === 'disconnected');
    events.emitExample('plan.updated');
    await read.next(anEvent('plan.updated'));

    assert.deepEqual(eventIds(read.items), [1234, 1235, 1236]);
    assert.equal(dropped.type === 'disconnected' && dropped.retryInMs, 20, 'the first wait after a working connection');
    assert.equal(events.connects[1].lastEventId, '1235');
  }));

test('an event sent twice is handed on once', () =>
  withFake(async (fake, open) => {
    const events = fake.stream();
    const read = open();
    await read.next(anEvent('snapshot'));
    events.emitExample('request.opened');
    await read.next(anEvent('request.opened'));

    events.sendDuplicate(1235);
    events.emitExample('feedback');
    await read.next(anEvent('feedback'));

    assert.deepEqual(eventIds(read.items), [1234, 1235, 1236]);
    assert.equal(read.stream.duplicatesDropped, 1);
  }));

test('an expired cursor is recovered from the session as a snapshot, and the stream continues after it', () =>
  withFake(async (fake, open) => {
    const example = exampleNamed(EVENTS_ROUTE, 'a cursor older than the kept events');
    const events = fake.stream();
    for (let emitted = 0; emitted < 6; emitted++) events.emitExample('usage.updated');
    events.expireBefore(1238);
    const read = open({ cursor: Number(example.request.headers?.['Last-Event-ID']) });

    assert.deepEqual(await read.next((item) => item.type === 'cursor_expired'), { type: 'cursor_expired', oldestEventId: 1238 });
    const snapshot = await read.next(anEvent());
    assert.deepEqual(snapshot.type === 'event' && [snapshot.event, snapshot.id, snapshot.data.last_event_id], ['snapshot', 1240, 1240]);
    await read.next((item) => item.type === 'connected');
    events.emitExample('turn.started');
    await read.next(anEvent('turn.started'));

    assert.deepEqual(
      events.connects.map((connect) => [connect.lastEventId, connect.after]),
      [
        ['12', null],
        [undefined, '1240'],
      ],
      'the reconnect after the snapshot uses ?after=, as event-stream.json says'
    );
    assert.ok(fake.seen.some((request) => request.method === 'GET' && request.path === `/api/v1/agent-sessions/${SID}`));
    assert.equal(read.stream.cursor, 1241);
  }));

test('a stream arriving three bytes at a time still gives whole frames, accents and all', () =>
  withFake(async (fake, open) => {
    const events = fake.stream();
    events.chunkBytes = 3;
    events.chunkDelayMs = 1;
    const read = open();
    await read.next(anEvent('snapshot'), 15_000);

    const text = 'Gebruik datetime.timezone.utc — “niet” pytz ✓';
    events.emitExample('feedback', { text });
    const feedback = await read.next(anEvent('feedback'), 15_000);

    assert.equal(feedback.type === 'event' && feedback.data.text, text);
  }));

test('a connection that goes silent is dropped and reopened from the cursor', () =>
  withFake(async (fake, open) => {
    fake.stream().heartbeatMs = 0;
    const read = open({ silenceLimitMs: 300 });
    await read.next(anEvent('snapshot'));

    const silent = await read.next((item) => item.type === 'disconnected');
    await read.next((item) => item.type === 'connected' && read.items.length > 2);

    assert.deepEqual(silent.type === 'disconnected' && silent.reason, { kind: 'silent' });
    assert.equal(fake.stream().connects[1].lastEventId, '1234');
  }));

test('heartbeats keep a quiet stream open', () =>
  withFake(async (fake, open) => {
    const events = fake.stream();
    events.heartbeatMs = 50;
    const read = open({ silenceLimitMs: 400 });
    await read.next(anEvent('snapshot'));

    setTimeout(() => events.emitExample('plan.updated'), 1_200);
    await read.next(anEvent('plan.updated'));

    assert.equal(read.items.some((item) => item.type === 'disconnected'), false);
    assert.equal(events.connects.length, 1);
  }));

test("a wrong token ends the stream at once; it doesn't retry for ever", () =>
  withFake(async (fake, open) => {
    const read = open({ token: 'ast_FIXTURE_wrong_token_not_a_secret_WWWWWWWWWW' });

    const ended = await read.next((item) => item.type === 'ended');
    await assert.rejects(read.next(() => true, 500), /ended first/);

    assert.equal(ended.type === 'ended' && ended.failure.kind === 'refused' && ended.failure.code, 'AGENT_SESSION_NOT_FOUND');
    assert.equal(fake.seen.filter((request) => request.path.endsWith('/events')).length, 1);
  }));

test('while RAVIS is away the reader waits and says so, and when it is back it resumes from its cursor', () =>
  withFake(async (fake, open) => {
    const events = fake.stream();
    const read = open();
    await read.next(anEvent('snapshot'));
    events.emitExample('request.opened');
    await read.next(anEvent('request.opened'));

    await fake.stopListening();
    const refused = await read.next((item) => item.type === 'disconnected' && item.reason.kind === 'unreachable' && item.retryInMs > 20);
    events.emitExample('turn.completed');
    await fake.listenAgain();
    await read.next(anEvent('turn.completed'));

    assert.equal(refused.type === 'disconnected' && refused.retryInMs, 40, 'the wait grows while RAVIS refuses connections');
    assert.equal(events.connects.at(-1)?.lastEventId, '1235');
    assert.deepEqual(eventIds(read.items), [1234, 1235, 1236]);
  }));

test('close() ends the reading, and nothing reconnects afterwards', () =>
  withFake(async (fake, open) => {
    const read = open();
    await read.next(anEvent('snapshot'));

    read.stream.close();
    await assert.rejects(read.next(() => true, 1_000), /ended first/);
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(fake.stream().connects.length, 1);
  }));

test('a malformed frame is reported, and the stream carries on', () =>
  withFake(async (fake, open) => {
    const events = fake.stream();
    const read = open();
    await read.next(anEvent('snapshot'));

    events.writeRaw('event: warning\ndata: {"message": broken\n\n');
    const malformed = await read.next((item) => item.type === 'malformed');
    events.emitExample('warning');
    await read.next(anEvent('warning'));

    assert.deepEqual(malformed, { type: 'malformed', id: null, event: 'warning', raw: '{"message": broken' });
  }));

test("a Stop from the dashboard arrives as the contract's frames show it", () =>
  withFake(async (fake, open) => {
    const frames = exampleNamed(EVENTS_ROUTE, 'stopped from the dashboard').response.frames ?? [];
    const events = fake.stream();
    const read = open({ cursor: 1234 });
    await read.next((item) => item.type === 'connected');

    for (const frame of frames) {
      const data = { ...frame.data };
      delete data.session_id;
      events.emit(frame.event, data);
    }
    for (const frame of frames) {
      const item = await read.next(anEvent(frame.event));
      assert.deepEqual(item.type === 'event' && item.data, frame.data, frame.event);
    }
  }));

test('a stream is read once', () => {
  const stream = new RelayEventStream({
    client: new RelayClient(fakeHttp('http://127.0.0.1:9')),
    sessionId: SID,
    token: FIXTURE_SESSION.token,
    windowId: WINDOW,
    host: 'desktop',
  });
  stream[Symbol.asyncIterator]();

  assert.throws(() => stream[Symbol.asyncIterator](), /read once/);
  stream.close();
});
