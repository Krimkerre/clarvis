import assert from 'node:assert/strict';
import test from 'node:test';

import { eventBody, forwardEvent, forwarded } from './eventForwarding';

/** The identity fields NERVIS attributes a span from. */
const SOURCE = { service_id: 'clarvis-abc', instance_id: 'inst-1', machine_id: 'machine-1' };

/** An event with §4.4's required fields filled, so a test can vary one thing. */
const anEvent = (over: Partial<Parameters<typeof eventBody>[0]> = {}) => ({
  name: 'clarvis.chat.started',
  data: {},
  traceId: '',
  occurredAt: '2026-08-30T20:00:00Z',
  eventId: 'a'.repeat(32),
  ...over,
});

/** Captures one forwarded request without opening a socket. */
function recorder(status = 202) {
  const sent: { url: string; init: RequestInit }[] = [];
  const send = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return new Response('', { status });
  }) as unknown as typeof fetch;
  return { sent, send };
}

test('the session is a top-level field when there is one, and absent when not', () => {
  // Runbook §4.3: Clarvis's runs carry the session their requests do, so NERVIS
  // files the event and RAVIS's route decision under one conversation. An empty
  // one would file every untraced event under the same blank session.
  const named = eventBody(anEvent({ traceId: 'abc', sessionId: 'session-7' }), SOURCE);
  const unnamed = eventBody(anEvent({ traceId: 'abc', sessionId: '' }), SOURCE);
  const absent = eventBody(anEvent({ traceId: 'abc' }), SOURCE);

  assert.equal(named.session_id, 'session-7');
  assert.equal('session_id' in unnamed, false);
  assert.equal('session_id' in absent, false);
  assert.equal('session_id' in (named.data as Record<string, unknown>), false, 'not buried in the data');
});

test('the trace is a top-level field, not buried in the data', () => {
  // NERVIS joins a waterfall on `trace_id`. Inside `data` it is an opaque
  // field the hub never reads, so the event would arrive, be stored, and still
  // leave the trace without a caller — which is the exact failure this whole
  // path exists to fix.
  const body = eventBody(
    anEvent({ data: { workspace_id: 'abc' }, traceId: '0'.repeat(31) + '1' }),
    SOURCE
  );

  assert.equal(body.trace_id, '0'.repeat(31) + '1');
  assert.equal(body.event_type, 'clarvis.chat.started');
  assert.deepEqual(body.data, { workspace_id: 'abc' });
});

test('an event belonging to no operation carries no trace at all', () => {
  // A heartbeat is not part of a request. Sending an empty string would put a
  // bar in somebody's timeline under a trace id of "", joining every
  // uncorrelated event in the ecosystem into one imaginary operation.
  const body = eventBody(anEvent({ name: 'clarvis.status.read' }), SOURCE);

  assert.equal('trace_id' in body, false);
});

test('a forwarded event is posted with the instance token', async () => {
  const { sent, send } = recorder();

  const landed = await forwardEvent(
    'http://nervis.invalid',
    'the-instance-token',
    anEvent({ name: 'clarvis.agent.completed', traceId: 'abc' }),
    SOURCE,
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
    anEvent({ traceId: 'abc' }),
    SOURCE,
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
    await forwardEvent('http://nervis.invalid', 'token', anEvent({ name: 'x' }), SOURCE, send),
    false
  );
});

test('a hub that is not there is reported, never thrown', async () => {
  const exploding = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  assert.equal(
    await forwardEvent('http://nervis.invalid', 'token', anEvent({ name: 'x' }), SOURCE, exploding),
    false
  );
});

test('the beginnings of model requests and tool calls stay on the Bridge; everything else goes on', () => {
  // NERVIS's hub allows a service 120 events at once and 12 a minute after that, and a
  // run of 25 tool calls with both ends of everything forwarded sends about 130.
  assert.equal(forwarded('clarvis.model.requested'), false);
  assert.equal(forwarded('clarvis.tool.started'), false);
  for (const name of ['clarvis.model.completed', 'clarvis.model.failed', 'clarvis.tool.completed',
    'clarvis.tool.failed', 'clarvis.tool.refused', 'clarvis.diagnostic.changed', 'clarvis.chat.started',
    'clarvis.agent.step', 'clarvis.gate.requested', 'clarvis.lifecycle.ready']) {
    assert.equal(forwarded(name), true, name);
  }
});
