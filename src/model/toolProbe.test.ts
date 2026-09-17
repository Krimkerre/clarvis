import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAiCompatibleProvider, probeAnswered } from './OpenAiCompatibleProvider';
import { ModelError } from './ModelProvider';
import { providerSpec } from './providers';

/**
 * The tool probe answers a three-valued question — yes, no, or could not tell — and
 * the third value is the one that keeps getting lost. `ModelService` remembers the
 * answer for the whole session (§4.6), so a "no" that was really a "could not tell"
 * disables the agent path until the window is reloaded.
 *
 * This happened twice. First with a bad credential, fixed by special-casing 401, 403
 * and 429. Then again through a gateway: RAVIS answers 502 when no candidate could
 * serve the request, and 502 was not on the list, so a model that calls tools
 * perfectly was recorded as unable to. Enumerating the statuses that have burned us is
 * what makes it recur, which is why the rule is now about what a status *means*.
 */

test('a 4xx about the request is an answer, and it is no', () => {
  // The only unusual thing in the probe is its `tools` parameter, so a server that
  // understood the request and rejected it is rejecting that.
  assert.equal(probeAnswered(400), true);
  assert.equal(probeAnswered(404), true);
  assert.equal(probeAnswered(422), true);
});

test('a 4xx about access is not about the model', () => {
  assert.equal(probeAnswered(401), false);
  assert.equal(probeAnswered(403), false);
  assert.equal(probeAnswered(429), false);
});

test('a 5xx is the server failing to answer, not the model declining', () => {
  // The regression this rule exists for: a gateway with nothing healthy behind it
  // says 502, and that says nothing whatsoever about tool support.
  assert.equal(probeAnswered(500), false);
  assert.equal(probeAnswered(502), false);
  assert.equal(probeAnswered(503), false);
  assert.equal(probeAnswered(504), false);
});

function provider(): OpenAiCompatibleProvider {
  const spec = providerSpec('custom');
  assert.ok(spec);
  return new OpenAiCompatibleProvider(
    spec,
    async () => undefined,
    () => 'http://runtime.invalid',
    () => {}
  );
}

async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

test('a gateway error is raised as retryable rather than cached as a no', async () => {
  const failed = await withFetch(
    async () => new Response('{"error":"no candidate could serve this"}', { status: 502 }),
    async () => {
      try {
        await provider().supportsTools('some-model');
        return undefined;
      } catch (error) {
        return error;
      }
    }
  );

  assert.ok(failed instanceof ModelError);
  // Retryable is what stops the answer being remembered: `ModelService` caches a
  // returned value and deliberately caches nothing at all when the probe throws.
  assert.equal(failed.retryable, true);
});

test('a probe that never arrives is not an answer either', async () => {
  // A closed runtime used to cost the agent path for the rest of the session.
  const failed = await withFetch(
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      try {
        await provider().supportsTools('some-model');
        return undefined;
      } catch (error) {
        return error;
      }
    }
  );

  assert.ok(failed instanceof ModelError);
  assert.equal(failed.retryable, true);
});

test('a model that really refuses the tools parameter still answers no', async () => {
  const supported = await withFetch(
    async () => new Response('{"error":"this model does not support tools"}', { status: 400 }),
    async () => provider().supportsTools('some-model')
  );

  assert.equal(supported, false);
});

test('a model that answers the probe supports tools', async () => {
  const supported = await withFetch(
    async () => new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 }),
    async () => provider().supportsTools('some-model')
  );

  assert.equal(supported, true);
});

test('the one-token tool check is a background call: it offers its own probe tool, never readSkill or a skill', async () => {
  // plan.md §4.6, "Skills": skills go to a run of Clarvis's own engine and to nothing else.
  let sent = '';
  await withFetch(
    async (_url: unknown, init?: RequestInit) => {
      sent = String(init?.body ?? '');
      return new Response('{"choices":[{"message":{"content":"ok"}}]}', { status: 200 });
    },
    async () => provider().supportsTools('some-model')
  );

  assert.match(sent, /"tools"/);
  assert.doesNotMatch(sent, /readSkill|skill/i);
});

// ------------------- one slow readiness check is not "no model configured"

import { REACHABLE_GRACE_MS, stillReachable } from './OpenAiCompatibleProvider';

test('an endpoint that just answered still counts as up, for a minute', () => {
  assert.equal(stillReachable(1_000, 1_000 + 5_000), true);
  assert.equal(stillReachable(1_000, 1_000 + REACHABLE_GRACE_MS + 1), false);
  assert.equal(stillReachable(undefined, 1_000), false);
});

test('a readiness check that times out right after an answered one is still ready', async () => {
  // Found live, 13 September 2026: one `/v1/models` check to RAVIS missed its 2 s timeout
  // mid-interview, and planning logged "no model configured" and used the written question.
  // Its own base URL, because the memory of answers outlives any one provider object.
  const spec = providerSpec('custom');
  assert.ok(spec);
  const url = `http://readiness-${Date.now()}.invalid`;
  const checked = new OpenAiCompatibleProvider(spec, async () => undefined, () => url, () => {});
  const unanswered = (async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  }) as typeof fetch;

  assert.equal(await withFetch(unanswered, () => checked.isAvailable()), false, 'never answered: not ready');
  assert.equal(await withFetch(async () => new Response('{"data":[]}', { status: 200 }), () => checked.isAvailable()), true);
  assert.equal(await withFetch(unanswered, () => checked.isAvailable()), true, 'answered a moment ago: one slow check is not an outage');
  assert.equal(
    await withFetch(async () => new Response('down', { status: 500 }), () => checked.isAvailable()),
    false,
    'an error the server answered with is a real answer'
  );
});

// ------------------- a reasoning stream teaches whoever built the provider

test('a stream that shows reasoning reports the model, once', async () => {
  // Found live, 13 September 2026: gemini-3.8-flash through RAVIS sent its thinking as
  // OpenRouter's `reasoning` field, which nothing here read, before any content.
  const spec = providerSpec('custom');
  assert.ok(spec);
  const seen: string[] = [];
  const reasoner = new OpenAiCompatibleProvider(spec, async () => undefined, () => 'http://runtime.invalid', () => {}, (model) => {
    seen.push(model);
  });
  const body = [
    'data: {"choices":[{"delta":{"reasoning":"Let me think."}}]}',
    'data: {"choices":[{"delta":{"reasoning":"Still thinking."}}]}',
    'data: {"choices":[{"delta":{"content":"Here it is."}}]}',
    'data: [DONE]',
    '',
  ].join('\n\n');

  const said = await withFetch(
    async () => new Response(body, { status: 200 }),
    async () => {
      let text = '';
      const request = { system: 's', messages: [{ role: 'user' as const, content: 'hi' }], model: 'google/gemini-3.8-flash' };
      for await (const fragment of reasoner.stream(request)) text += fragment;
      return text;
    }
  );

  assert.equal(said, 'Here it is.');
  assert.deepEqual(seen, ['google/gemini-3.8-flash']);
});

test("the probe names itself like every other model request: the caller's session and request id", async () => {
  // Scenario review, 17 Sep 2026: RAVIS recorded a Clarvis chat request with no session id. It was this
  // probe, which sent no lineage headers at all, so its route decision belonged to no conversation.
  let sent: Headers | undefined;
  const supported = await withFetch(
    async (_url, init) => {
      sent = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    },
    async () => provider().supportsTools('some-model', { sessionId: 'session-1', requestId: 'a'.repeat(32) })
  );
  assert.equal(supported, true);
  assert.equal(sent?.get('x-session-id'), 'session-1');
  assert.equal(sent?.get('x-request-id'), 'a'.repeat(32));
});

test('a probe with no caller to name still sends a request id of its own', async () => {
  let sent: Headers | undefined;
  await withFetch(
    async (_url, init) => {
      sent = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    },
    async () => provider().supportsTools('some-model')
  );
  assert.match(sent?.get('x-request-id') ?? '', /^[0-9a-f]{32}$/);
  assert.equal(sent?.has('x-session-id'), false);
});
