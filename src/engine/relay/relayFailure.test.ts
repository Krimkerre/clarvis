import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleNamed } from '../../test/fakes/relayContract';
import { failureFromNetworkError, failureFromResponse, isTransient, readEnvelope, type RelayFailure } from './relayFailure';

/**
 * The owner's handoff for the Codex engine names the confusions this module exists to prevent: an
 * allowance that ran out is not throttling, throttling is not being signed out, a version needing a
 * re-test is none of those, and none of them is RAVIS not answering. Each leads the owner somewhere
 * different, so each must arrive as a different kind.
 */

function fromExample(route: string, name: string): RelayFailure {
  const example = exampleNamed(route, name);
  return failureFromResponse(example.response.status, example.response.body, null);
}

function notReady(state: string, reason: string): unknown {
  return {
    error: { code: 'CODEX_NOT_READY', message: "Codex isn't ready.", retryable: false, details: { state, reason } },
  };
}

test('quota, throttling, signed out, an untested version and no answer are five different things', () => {
  const quotaExample = exampleNamed('POST /api/v1/agent-sessions/{sid}/turns', 'the allowance is used up');
  const quotaReason = (quotaExample.response.body as { error: { details: { reason: string } } }).error.details.reason;

  const quota = fromExample('POST /api/v1/agent-sessions/{sid}/turns', 'the allowance is used up');
  const throttled = failureFromResponse(429, { error: { code: 'RATE_LIMITED', message: 'Slow down.', retryable: true, details: {} } }, '30');
  const signedOut = failureFromResponse(409, notReady('signed_out', 'Codex is signed out.'), null);
  const untested = fromExample('POST /api/v1/agent-sessions', 'the file rules are unproven');
  const unreachable = failureFromNetworkError(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), false);

  assert.deepEqual(quota, { kind: 'quota_exhausted', reason: quotaReason });
  assert.deepEqual(throttled, { kind: 'throttled', code: 'RATE_LIMITED', retryAfterSeconds: 30 });
  assert.deepEqual(signedOut, { kind: 'signed_out', expired: false, reason: 'Codex is signed out.' });
  assert.deepEqual(untested, { kind: 'untested_version', fileRulesUnproven: true, reason: 'strict_file_rules_unproven' });
  assert.deepEqual(unreachable, { kind: 'unreachable', detail: 'ECONNREFUSED' });
  assert.equal(new Set([quota, throttled, signedOut, untested, unreachable].map((failure) => failure.kind)).size, 5);
});

test('a 429 is throttling whatever its body says, and never the allowance', () => {
  // Design §9: quota is "not inferred from a bare 429" — nor from a 429 that claims it.
  assert.deepEqual(failureFromResponse(429, undefined, null), { kind: 'throttled', code: null, retryAfterSeconds: null });
  assert.equal(failureFromResponse(429, notReady('quota_exhausted', 'used up'), null).kind, 'throttled');
  assert.equal((failureFromResponse(429, undefined, 'Wed, 21 Oct 2026 07:28:00 GMT') as { retryAfterSeconds: unknown }).retryAfterSeconds, null);
});

test('an expired sign-in is signed out, marked as expired', () => {
  assert.deepEqual(failureFromResponse(409, notReady('sign_in_expired', 'OpenAI signed Codex out.'), null), {
    kind: 'signed_out',
    expired: true,
    reason: 'OpenAI signed Codex out.',
  });
});

test('an untested version with any other reason is still untested, without claiming the file rules', () => {
  assert.deepEqual(failureFromResponse(409, notReady('untested_version', 'Codex changed (now 0.155.0).'), null), {
    kind: 'untested_version',
    fileRulesUnproven: false,
    reason: 'Codex changed (now 0.155.0).',
  });
});

test('the other not-ready states keep their state and reason', () => {
  assert.deepEqual(fromExample('POST /api/v1/agent-sessions', 'a different ChatGPT account'), {
    kind: 'codex_not_ready',
    state: 'account_changed',
    reason: 'Codex is signed in to a different account than the one you confirmed.',
  });
  assert.deepEqual(failureFromResponse(409, notReady('runtime_down', 'Codex process restarting'), null), {
    kind: 'codex_not_ready',
    state: 'runtime_down',
    reason: 'Codex process restarting',
  });
  // A state named like an object's own property must not reach anything but the default.
  assert.equal(failureFromResponse(409, notReady('constructor', ''), null).kind, 'codex_not_ready');
});

test("503 CODEX_RUNTIME_UNAVAILABLE is RAVIS answering for a Codex process that didn't", () => {
  assert.deepEqual(fromExample('POST /api/v1/agent-sessions', "the Codex process didn't answer"), {
    kind: 'runtime_unavailable',
    message: "Codex didn't start.",
  });
});

test('every other error keeps its status, code and details for the caller to read', () => {
  const failure = fromExample('POST /api/v1/agent-sessions', "Clarvis's own engine holds the project");

  assert.equal(failure.kind, 'refused');
  assert.equal(failure.kind === 'refused' && failure.status, 409);
  assert.equal(failure.kind === 'refused' && failure.code, 'PROJECT_LOCKED');
  assert.equal(failure.kind === 'refused' && (failure.details.lock as { holder: { kind: string } }).holder.kind, 'clarvis_run');
});

test('a body that is not an envelope is refused with no code, never read as a success', () => {
  assert.deepEqual(failureFromResponse(502, '<html>Bad gateway</html>', null), {
    kind: 'refused',
    status: 502,
    code: null,
    message: 'HTTP 502',
    retryable: true,
    details: {},
  });
  assert.equal(readEnvelope({ error: { code: 'X', message: 'no retryable or details' } }), undefined);
});

test('a call the caller cancelled is not RAVIS being down; a timeout is', () => {
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  const timedOut = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });

  assert.deepEqual(failureFromNetworkError(aborted, true), { kind: 'cancelled' });
  assert.deepEqual(failureFromNetworkError(timedOut, false), { kind: 'unreachable', detail: 'TimeoutError' });
});

test('a stream reconnects after a passing failure, and stops at a refusal no retry can change', () => {
  const passing: RelayFailure[] = [
    { kind: 'unreachable', detail: 'ECONNREFUSED' },
    { kind: 'throttled', code: null, retryAfterSeconds: null },
    { kind: 'runtime_unavailable', message: '' },
    { kind: 'malformed', status: 200, detail: '' },
    { kind: 'refused', status: 503, code: null, message: '', retryable: true, details: {} },
  ];
  const final: RelayFailure[] = [
    { kind: 'refused', status: 404, code: 'AGENT_SESSION_NOT_FOUND', message: '', retryable: false, details: {} },
    { kind: 'refused', status: 403, code: 'AGENT_CLIENT_NOT_ALLOWED', message: '', retryable: false, details: {} },
    { kind: 'cancelled' },
    { kind: 'quota_exhausted', reason: '' },
  ];

  for (const failure of passing) assert.equal(isTransient(failure), true, JSON.stringify(failure));
  for (const failure of final) assert.equal(isTransient(failure), false, JSON.stringify(failure));
});
