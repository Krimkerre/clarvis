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
