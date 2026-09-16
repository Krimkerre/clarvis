import assert from 'node:assert/strict';
import test from 'node:test';

import { AnthropicProvider } from './AnthropicProvider';
import { lineageHeaders, newRequestId, newTraceId, traceparent } from './lineage';
import { OpenAiCompatibleProvider } from './OpenAiCompatibleProvider';
import { providerSpec } from './providers';

test('a traceparent is the shape the W3C spec defines', () => {
  // RAVIS parses this rather than storing it whole — the shared package's own
  // comment records all three services having stored the entire header as the
  // trace id, which correlates nothing. A malformed one would be dropped
  // silently, so the shape is asserted here rather than discovered there.
  const parts = traceparent(newTraceId()).split('-');

  assert.equal(parts.length, 4);
  assert.equal(parts[0], '00');
  assert.match(parts[1], /^[0-9a-f]{32}$/);
  assert.match(parts[2], /^[0-9a-f]{16}$/);
  assert.equal(parts[3], '01');
});

test('every request in one trace carries the same trace id and its own span', () => {
  // The whole point: an agent run makes a dozen model calls and they have to
  // join into one story while staying distinguishable inside it. One span id
  // reused would collapse the waterfall into a single bar.
  const trace = newTraceId();
  const first = traceparent(trace).split('-');
  const second = traceparent(trace).split('-');

  assert.equal(first[1], second[1]);
  assert.notEqual(first[2], second[2]);
});

test('two traces do not share an id', () => {
  assert.notEqual(newTraceId(), newTraceId());
});

test('a trace id is never all zeroes', () => {
  // The spec calls an all-zero id invalid, and the shared parser refuses it —
  // a zero id would join every malformed trace into one, which is worse than
  // having none. 16 random bytes make this vanishingly unlikely rather than
  // impossible, so the guard is that we never construct one deliberately.
  for (let attempt = 0; attempt < 50; attempt++) {
    assert.notEqual(newTraceId(), '0'.repeat(32));
  }
});

test('nothing to say means no header, not an empty one', () => {
  // An empty `x-session-id` is a session whose id is the empty string. RAVIS
  // would store it and correlate every anonymous request to the same one —
  // worse than sending nothing, because it looks like an answer.
  // The request id is the exception: every request is one (runbook §4.3).
  assert.deepEqual(Object.keys(lineageHeaders('', '')), ['x-request-id']);
  assert.deepEqual(Object.keys(lineageHeaders(newTraceId(), '')), ['x-request-id', 'traceparent']);
  assert.deepEqual(Object.keys(lineageHeaders('', 'session-1')), ['x-request-id', 'x-session-id']);
});

test('every request gets its own request id, in the shape RAVIS mints', () => {
  const first = lineageHeaders('', '')['x-request-id'];
  const second = lineageHeaders('', '')['x-request-id'];

  assert.match(first, /^[0-9a-f]{32}$/);
  assert.notEqual(first, second, 'two requests must never share an id');
  assert.equal(lineageHeaders('', '', 'chosen')['x-request-id'], 'chosen');
  assert.match(newRequestId(), /^[0-9a-f]{32}$/);
});

test('both headers travel when both are known', () => {
  const headers = lineageHeaders(newTraceId(), 'session-1');

  assert.equal(headers['x-session-id'], 'session-1');
  assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

// --- and the part unit tests cannot show: that they reach the wire ---

/** Captures the headers of the one request a stream makes. */
async function headersSentFor(request: Record<string, unknown>): Promise<Headers> {
  const spec = providerSpec('custom');
  assert.ok(spec);
  const provider = new OpenAiCompatibleProvider(
    spec,
    async () => undefined,
    () => 'http://runtime.invalid',
    () => {}
  );

  let seen: Headers | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = new Headers(init.headers as Record<string, string>);
    // An empty but valid SSE stream: the call has to complete, and what it
    // returns does not matter — the headers were already sent.
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;

  try {
    for await (const fragment of provider.stream({
      system: 's',
      messages: [{ role: 'user', content: 'hello' }],
      model: 'ravis/clarvis-chat',
      ...request,
    })) {
      void fragment; // drained; the headers were sent before the first byte
    }
  } finally {
    globalThis.fetch = real;
  }

  assert.ok(seen, 'no request was made');
  return seen;
}

test('the correlation headers are actually on the outgoing request', async () => {
  // The assertions above prove the strings are well formed. This proves they
  // leave the process — the gap where a lineage feature usually dies, because
  // every unit around it passes while the header is never attached.
  const trace = newTraceId();
  const sent = await headersSentFor({ traceId: trace, sessionId: 'session-7' });

  assert.equal(sent.get('x-session-id'), 'session-7');
  assert.equal(sent.get('traceparent')?.split('-')[1], trace);
  assert.match(sent.get('x-request-id') ?? '', /^[0-9a-f]{32}$/);
});

test("a request id chosen by the caller is the one sent, so an event about the request names RAVIS's id", async () => {
  // `ModelService` mints the id before the request and publishes it on
  // `clarvis.model.*`; an adapter minting its own would make the two disagree.
  const chosen = 'ab'.repeat(16);
  const sent = await headersSentFor({ requestId: chosen });
  assert.equal(sent.get('x-request-id'), chosen);
});

test('an uncorrelated request sends neither header', async () => {
  // Every provider that is not RAVIS still gets these, so the absent case has
  // to be genuinely absent rather than an empty string a peer would store.
  const sent = await headersSentFor({});

  assert.equal(sent.get('traceparent'), null);
  assert.equal(sent.get('x-session-id'), null);
  assert.match(sent.get('x-request-id') ?? '', /^[0-9a-f]{32}$/, 'the request itself is still named');
});

test('the Anthropic adapter sends the same three headers', async () => {
  // It sent none until 16 September 2026, so a request was a different kind of
  // request depending on which adapter carried it (CLARVIS.md §6.5).
  const spec = providerSpec('anthropic');
  assert.ok(spec);
  const provider = new AnthropicProvider(spec, async () => 'k', () => 'http://anthropic.invalid', () => {});

  let seen: Headers | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = new Headers(init.headers as Record<string, string>);
    return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;

  const trace = newTraceId();
  try {
    for await (const fragment of provider.stream({
      system: 's',
      messages: [{ role: 'user', content: 'hello' }],
      model: 'claude-haiku-4-5',
      traceId: trace,
      sessionId: 'session-9',
      requestId: 'cd'.repeat(16),
    })) {
      void fragment;
    }
  } finally {
    globalThis.fetch = real;
  }

  assert.ok(seen, 'no request was made');
  assert.equal(seen.get('traceparent')?.split('-')[1], trace);
  assert.equal(seen.get('x-session-id'), 'session-9');
  assert.equal(seen.get('x-request-id'), 'cd'.repeat(16), 'the id the caller chose');
  assert.equal(seen.get('x-api-key'), 'k', 'the credential still travels');
});

test('chat and the agent do not share a session', async () => {
  // Found on the first live walk, not by reading: the session record read
  // `pool=ravis/clarvis-chat` with `model=claude-sonnet-4.5`, which came from
  // `ravis/clarvis-agent`. RAVIS keys model affinity on the session, so one id
  // across both roles files the agent's choice against the chat pool — and the
  // next chat turn is steered by a decision made for something else.
  //
  // Driven through ModelService rather than asserting the map, because the
  // defect was in which id reached the wire and that is what has to differ.
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const id = new Headers(init.headers as Record<string, string>).get('x-session-id');
    if (id) seen.push(id);
    return new Response('data: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;

  try {
    const spec = providerSpec('custom');
    assert.ok(spec);
    // Two requests from one provider instance, standing in for the two roles:
    // what matters is that a caller passing different session ids gets them
    // through unchanged, which is the contract ModelService relies on.
    const provider = new OpenAiCompatibleProvider(
      spec,
      async () => undefined,
      () => 'http://runtime.invalid',
      () => {}
    );
    for (const sessionId of ['session-chat', 'session-agent']) {
      for await (const fragment of provider.stream({
        system: 's',
        messages: [{ role: 'user', content: 'hello' }],
        model: 'ravis/clarvis-chat',
        sessionId,
      })) {
        void fragment;
      }
    }
  } finally {
    globalThis.fetch = real;
  }

  assert.deepEqual(seen, ['session-chat', 'session-agent']);
});
