import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLARVIS_CREDENTIAL, FAKE_CREDENTIALS, FakeRavisRelay, FIXTURE_SESSION } from './FakeRavisRelay';
import {
  contractRoutes,
  EVENTS_ROUTE,
  exampleNamed,
  fixture,
  frameProblems,
  requestProblems,
  responseProblems,
  routeByKey,
  type FixtureExample,
} from './relayContract';

/**
 * The fake is only worth building on while it agrees with RAVIS's fixtures. So every fixture example
 * is sent through it and must come back exactly as the fixture shows; its check must pass every
 * fixture answer and request; and the check must catch each way an answer or a request can break the
 * contract. If these fail, the fake — not the client — is what needs fixing.
 */

const CREDENTIAL_FOR: Record<string, string> = Object.fromEntries(
  Object.entries(FAKE_CREDENTIALS).map(([credential, caller]) => [caller, credential])
);

async function sendExample(url: string, example: FixtureExample): Promise<{ status: number; body: unknown }> {
  const target = new URL(example.request.path, url);
  for (const [name, value] of Object.entries(example.request.query ?? {})) target.searchParams.set(name, value);
  const headers: Record<string, string> = { ...(example.request.headers ?? {}) };
  const credential = CREDENTIAL_FOR[example.request.caller];
  if (credential) headers.Authorization = `Bearer ${credential}`;
  const body = example.request.body === undefined ? undefined : JSON.stringify(example.request.body);
  const response = await fetch(target, { method: example.request.method, headers, body });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

function envelope(code: string, retryable = false, details: Record<string, unknown> = {}): unknown {
  return { error: { code, message: 'A message.', retryable, details, request_id: 'r', trace_id: 't' } };
}

test('every fixture example is answered exactly as the fixture shows, and passes the check', async () => {
  const fake = await FakeRavisRelay.start();
  try {
    for (const route of contractRoutes().filter((candidate) => candidate.key !== EVENTS_ROUTE)) {
      for (const example of route.examples) {
        fake.reset();
        fake.reply(route.key, example.name);
        const label = `${route.key}: ${example.name}`;

        const answer = await sendExample(fake.url, example);

        assert.equal(answer.status, example.response.status, label);
        assert.deepEqual(answer.body, example.response.body ?? null, label);
        assert.deepEqual(fake.violations.filter((violation) => violation.startsWith('response:')), [], label);
        // Only the examples that are wrong on purpose may break the request check. An anonymous read of
        // Codex's state is not one of them: that route is open to any caller.
        const anonymousRefused = example.request.caller === 'anonymous' && !route.needs.includes('any caller');
        const wrongOnPurpose = anonymousRefused || example.name === 'no Idempotency-Key';
        assert.equal(fake.violations.some((violation) => violation.startsWith('request:')), wrongOnPurpose, `${label}: ${fake.violations.join('; ')}`);
      }
    }
  } finally {
    await fake.close();
  }
});

test('the check catches an answer outside the fixtures, in each way that matters', () => {
  const session = `/api/v1/agent-sessions/${FIXTURE_SESSION.id}`;
  const steer = `${session}/steer`;
  const view = exampleNamed('GET /api/v1/agent-sessions/{sid}', 'a task waiting on a command approval').response.body as Record<string, unknown>;
  const withoutCursor = { ...view };
  delete withoutCursor.last_event_id;

  assert.deepEqual(responseProblems('GET', session, 200, view), []);
  assert.match(responseProblems('POST', steer, 202, { delivered: 'steered', how: 'fast' }).join('\n'), /how: not in the fixtures/);
  assert.match(responseProblems('GET', session, 200, withoutCursor).join('\n'), /last_event_id: missing/);
  assert.match(responseProblems('POST', steer, 202, { delivered: 1 }).join('\n'), /is number/);
  assert.match(responseProblems('POST', steer, 409, envelope('NOT_A_CODE')).join('\n'), /not in the error catalogue/);
  assert.match(responseProblems('POST', steer, 400, envelope('SESSION_STOPPING')).join('\n'), /with 400/);
  assert.match(responseProblems('POST', '/api/v1/agent-sessions', 503, envelope('CODEX_RUNTIME_UNAVAILABLE', false)).join('\n'), /retryable false/);
  assert.match(responseProblems('POST', steer, 409, envelope('LEASE_REVOKED')).join('\n'), /never answer LEASE_REVOKED here/);
  assert.match(responseProblems('POST', '/api/v1/agent-sessions', 409, envelope('PROJECT_LOCKED')).join('\n'), /details\.lock: missing/);
  assert.match(responseProblems('POST', steer, 200, { delivered: 'steered' }).join('\n'), /never answer 200/);
  assert.match(responseProblems('POST', `${session}/owner-stop`, 202, { state: 'stopping' }).join('\n'), /no such route/);

  // The conventions apply these to whole families of routes, so they pass where no example lists them.
  assert.deepEqual(responseProblems('POST', steer, 403, envelope('AGENT_CLIENT_NOT_ALLOWED')), []);
  assert.deepEqual(responseProblems('POST', steer, 404, envelope('AGENT_SESSION_NOT_FOUND')), []);
  assert.deepEqual(responseProblems('POST', steer, 428, envelope('IDEMPOTENCY_KEY_REQUIRED')), []);
  assert.match(responseProblems('POST', `${session}/interrupt`, 428, envelope('IDEMPOTENCY_KEY_REQUIRED')).join('\n'), /never answer IDEMPOTENCY_KEY_REQUIRED here/);
});

test('the check catches a frame outside event-stream.json, and holds each request kind to its own example', () => {
  const opened = structuredClone(
    (fixture('event-stream.json').events as { event: string; example_data: { request: { payload: Record<string, unknown> } } }[]).find(
      (entry) => entry.event === 'request.opened'
    )?.example_data
  );
  assert.ok(opened);
  const fileChange = { session_id: FIXTURE_SESSION.id, request: fixture('agent-sessions.json').request_view_examples[1] };

  assert.deepEqual(frameProblems('request.opened', opened), []);
  assert.deepEqual(frameProblems('request.opened', fileChange), []);
  opened.request.payload.sudo = true;
  assert.match(frameProblems('request.opened', opened).join('\n'), /sudo: not in the fixtures/);
  assert.match(frameProblems('session.state', { state: 'stopping' }).join('\n'), /session_id: missing/);
  assert.match(frameProblems('session.progress', { session_id: FIXTURE_SESSION.id }).join('\n'), /not in event-stream\.json/);
});

test('the check holds a request to what its route needs', () => {
  const sessions = `/api/v1/agent-sessions/${FIXTURE_SESSION.id}`;
  const base = { authorization: 'Bearer x', 'content-type': 'application/json' };
  const steer = routeByKey('POST /api/v1/agent-sessions/{sid}/steer');

  assert.deepEqual(requestProblems(steer, `${sessions}/steer`, { ...base, 'x-agent-session-token': 't', 'idempotency-key': 'k' }, { text: 'hi' }), []);
  assert.match(requestProblems(steer, `${sessions}/steer`, { ...base, 'idempotency-key': 'k' }, { text: 'hi' }).join('\n'), /no session token/);
  assert.match(requestProblems(steer, `${sessions}/steer`, { 'x-agent-session-token': 't', 'idempotency-key': 'k' }, undefined).join('\n'), /no client credential/);
  assert.match(
    requestProblems(steer, `${sessions}/steer`, { ...base, 'x-agent-session-token': 't', 'idempotency-key': 'k' }, { text: 'hi', sandbox: 'off' }).join('\n'),
    /sandbox: not in the fixtures/
  );
  assert.match(
    requestProblems(
      routeByKey('POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer'),
      `${sessions}/requests/rq_1/answer`,
      { ...base, 'x-agent-session-token': 't', 'idempotency-key': 'rq_2:win' },
      { decision: { kind: 'once' } }
    ).join('\n'),
    /not <rid>:<window_id>/
  );
  assert.match(
    requestProblems(routeByKey('POST /api/v1/agent-sessions/{sid}/reissue-token'), `${sessions}/reissue-token`, { ...base, 'x-agent-session-token': 't', 'idempotency-key': 'k' }, { workspace_root: '/p' }).join('\n'),
    /none belongs/
  );
  assert.match(
    requestProblems(routeByKey('POST /api/v1/project-locks/{lid}/takeover'), '/api/v1/project-locks/pl_1/takeover', { ...base, 'x-lock-lease': 'l', 'idempotency-key': 'k' }, undefined).join('\n'),
    /a lease where none belongs/
  );
  assert.match(
    requestProblems(routeByKey('POST /api/v1/project-locks/{lid}/transfer'), '/api/v1/project-locks/pl_1/transfer', { ...base, 'idempotency-key': 'k' }, { to: 'clarvis_run' }).join('\n'),
    /neither a lease nor a session token/
  );
});

test('the identity rule refuses in order and before the token: a NERVIS or admin credential holding a valid token is still refused', async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const messages = (fixture('conventions.json').identity_rule.refusals_in_order as { message: string }[]).map((refusal) => refusal.message);
    const cases: [string | undefined, string][] = [
      [undefined, messages[0]],
      ['fixture-admin-launcher-not-a-secret', messages[1]],
      ['fixture-client-nervis-not-a-secret', messages[2]],
      ['fixture-client-other-not-a-secret', messages[3]],
    ];
    const read = (credential: string | undefined) =>
      fetch(`${fake.url}/api/v1/agent-sessions/${FIXTURE_SESSION.id}`, {
        headers: { 'X-Agent-Session-Token': FIXTURE_SESSION.token, ...(credential ? { Authorization: `Bearer ${credential}` } : {}) },
      });

    for (const [credential, message] of cases) {
      const response = await read(credential);
      const body = (await response.json()) as { error: { code: string; message: string } };
      assert.deepEqual([response.status, body.error.code, body.error.message], [403, 'AGENT_CLIENT_NOT_ALLOWED', message], credential);
    }
    assert.equal((await read(CLARVIS_CREDENTIAL)).status, 200);
    assert.deepEqual(fake.violations.filter((violation) => violation.startsWith('response:')), []);
  } finally {
    await fake.close();
  }
});

test('keys, as RAVIS keeps them: none is 428, a replay is the first answer, another body is 422', async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const route = 'POST /api/v1/agent-sessions/{sid}/turns';
    const post = async (key: string | undefined, body: unknown) => {
      const response = await fetch(`${fake.url}/api/v1/agent-sessions/${FIXTURE_SESSION.id}/turns`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CLARVIS_CREDENTIAL}`,
          'X-Agent-Session-Token': FIXTURE_SESSION.token,
          'Content-Type': 'application/json',
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as { error?: { code: string } } };
    };
    const turn = { text: 'Carry on with milestone 2.', kind: 'continue' };

    assert.equal((await post(undefined, turn)).status, 428);
    fake.reply(route, 'continued, holding the lock');
    fake.reply(route, 'a turn is active: steer instead');
    const first = await post('key-1', turn);
    const replay = await post('key-1', turn);
    const reused = await post('key-1', { ...turn, text: 'Something else.' });

    assert.equal(first.status, 202);
    assert.deepEqual(replay, first, 'the replay, not the next scripted answer');
    assert.deepEqual([reused.status, reused.body.error?.code], [422, 'IDEMPOTENCY_KEY_REUSED']);
    assert.deepEqual(fake.violations.filter((violation) => violation.startsWith('response:')), []);
  } finally {
    await fake.close();
  }
});

test('an answer the fake is told to give outside the fixtures is recorded, unless the test says why', async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const route = 'POST /api/v1/agent-sessions/{sid}/interrupt';
    fake.reply(route, { status: 202, body: { state: 'stopping', eta_seconds: 3 } });
    fake.reply(route, { status: 202, body: { state: 'stopping', eta_seconds: 3 }, offContract: 'shown on purpose' });
    const interrupt = () =>
      fetch(`${fake.url}/api/v1/agent-sessions/${FIXTURE_SESSION.id}/interrupt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CLARVIS_CREDENTIAL}`, 'X-Agent-Session-Token': FIXTURE_SESSION.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'stop' }),
      });

    await interrupt();
    await interrupt();

    const recorded = fake.violations.filter((violation) => violation.startsWith('response:'));
    assert.equal(recorded.length, 1);
    assert.match(recorded[0], /eta_seconds: not in the fixtures/);
  } finally {
    await fake.close();
  }
});

test('it says it is a test double, and can advertise a capability version a client would not support', async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const identity = (await (await fetch(`${fake.url}/ecosystem/identity`)).json()) as { test_double: boolean };
    fake.capabilityVersion = '2.0.0';
    const listed = (await (await fetch(`${fake.url}/ecosystem/capabilities`)).json()) as { capabilities: { id: string; version: string }[] };

    assert.equal(identity.test_double, true);
    assert.equal(listed.capabilities.find((capability) => capability.id === 'ravis.agent_sessions')?.version, '2.0.0');
  } finally {
    await fake.close();
  }
});
