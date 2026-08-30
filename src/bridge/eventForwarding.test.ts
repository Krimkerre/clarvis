import assert from 'node:assert/strict';
import test from 'node:test';

import { eventBody, forwardEvent } from './eventForwarding';

/** Captures one forwarded request without opening a socket. */
function recorder(status = 202) {
  const sent: { url: string; init: RequestInit }[] = [];
  const send = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response('', { status });
  }) as unknown as typeof fetch;
  return { sent, send };
}

test('the trace is a top-level field, not buried in the data', () => {
  // NERVIS joins a waterfall on `trace_id`. Inside `data` it is an opaque
  // field the hub never reads, so the event would arrive, be stored, and still
  // leave the trace without a caller — which is the exact failure this whole
  // path exists to fix.
  const body = eventBody({
    name: 'clarvis.chat.started',
    data: { workspace_id: 'abc' },
    traceId: '0'.repeat(31) + '1',
  });

  assert.equal(body.trace_id, '0'.repeat(31) + '1');
  assert.equal(body.event_type, 'clarvis.chat.started');
  assert.deepEqual(body.data, { workspace_id: 'abc' });
});

test('an event belonging to no operation carries no trace at all', () => {
  // A heartbeat is not part of a request. Sending an empty string would put a
  // bar in somebody's timeline under a trace id of "", joining every
  // uncorrelated event in the ecosystem into one imaginary operation.
  const body = eventBody({ name: 'clarvis.status.read', data: {}, traceId: '' });

  assert.equal('trace_id' in body, false);
});

test('a forwarded event is posted with the instance token', async () => {
  const { sent, send } = recorder();

  const landed = await forwardEvent(
    'http://nervis.invalid',
    'the-instance-token',
    { name: 'clarvis.agent.completed', data: {}, traceId: 'abc' },
    send
  );

  assert.equal(landed, true);
  assert.equal(sent[0].url, 'http://nervis.invalid/api/v1/events');
  const headers = new Headers(sent[0].init.headers as Record<string, string>);
  assert.equal(headers.get('Authorization'), 'Bearer the-instance-token');
});

test('nothing is sent before NERVIS has issued a token', async () => {
  // Not merely pointless — it is the difference between a suite that finishes
  // and one that opens a socket per event to an address nothing answers. A
  // Bridge that never registered has nowhere to send and no authority to send
  // with, and both are the same condition.
  const { sent, send } = recorder();

  const landed = await forwardEvent(
    'http://nervis.invalid',
    '',
    { name: 'clarvis.chat.started', data: {}, traceId: 'abc' },
    send
  );

  assert.equal(landed, false);
  assert.deepEqual(sent, []);
});

test('a hub that refuses is reported, never thrown', async () => {
  // §11.1 makes the hub operational telemetry rather than the system of
  // record. A chat turn must not fail because a diagram lost a bar.
  const { send } = recorder(503);
  assert.equal(
    await forwardEvent('http://nervis.invalid', 'token', { name: 'x', data: {}, traceId: '' }, send),
    false
  );
});

test('a hub that is not there is reported, never thrown', async () => {
  const exploding = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  assert.equal(
    await forwardEvent('http://nervis.invalid', 'token', { name: 'x', data: {}, traceId: '' }, exploding),
    false
  );
});
