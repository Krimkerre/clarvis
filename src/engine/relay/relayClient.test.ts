import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLARVIS_CREDENTIAL, FakeRavisRelay, FIXTURE_SESSION, fakeHttp } from '../../test/fakes/FakeRavisRelay';
import { exampleNamed, type FixtureExample } from '../../test/fakes/relayContract';
import { createSessionKey, freshKey } from './idempotency';
import { RelayClient, type SettleRequest, type SteerRequest, type TurnRequest } from './relayClient';
import type { RelayFailure, RelayOutcome } from './relayFailure';
import { relayEndpoint } from './relayHttp';
import type { CreateSessionBody } from './relayTypes';

/**
 * The relay client against `FakeRavisRelay`. The fake holds every request the client sends to the
 * contract fixtures, and every answer it gives too, so each test ends by asserting its `violations`
 * are empty: a request with a missing header or an invented field fails here, not in the owner's
 * live test.
 */

const SID = FIXTURE_SESSION.id;
const TOKEN = FIXTURE_SESSION.token;
const WINDOW = 'win-desktop-1c9e4d';

async function withClient(run: (fake: FakeRavisRelay, client: RelayClient) => Promise<void>): Promise<void> {
  const fake = await FakeRavisRelay.start();
  try {
    await run(fake, new RelayClient(fakeHttp(fake)));
    assert.deepEqual(fake.violations, [], 'every request and answer matched the fixtures');
  } finally {
    await fake.close();
  }
}

function keyOf(example: FixtureExample): string {
  const key = example.request.headers?.['Idempotency-Key'];
  if (!key) throw new Error(`${example.name} carries no Idempotency-Key`);
  return key;
}

function value<T>(outcome: RelayOutcome<T>): T {
  if (!outcome.ok) throw new Error(`expected a success, got ${JSON.stringify(outcome.failure)}`);
  return outcome.value;
}

function failure<T>(outcome: RelayOutcome<T>): RelayFailure {
  if (outcome.ok) throw new Error(`expected a failure, got ${JSON.stringify(outcome)}`);
  return outcome.failure;
}

function pick(object: object, keys: string[]): Record<string, unknown> {
  const record = object as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
}

function settleOf(example: FixtureExample): SettleRequest {
  const { claim_id, commit, next } = example.request.body as SettleRequest;
  return { claim_id, commit, next };
}

test('the credential is offered only to a RAVIS on this machine', () => {
  assert.deepEqual(relayEndpoint('http://192.168.1.20:8484', CLARVIS_CREDENTIAL), { ok: false, reason: 'not_loopback' });
  assert.deepEqual(relayEndpoint('https://ravis.example.com', CLARVIS_CREDENTIAL), { ok: false, reason: 'not_loopback' });
  assert.deepEqual(relayEndpoint('ftp://127.0.0.1:8484', CLARVIS_CREDENTIAL), { ok: false, reason: 'invalid_url' });
  assert.deepEqual(relayEndpoint('not a url', CLARVIS_CREDENTIAL), { ok: false, reason: 'invalid_url' });
  assert.deepEqual(relayEndpoint('http://127.0.0.1:8484', '  '), { ok: false, reason: 'no_credential' });
  for (const local of ['http://127.0.0.1:8484', 'http://localhost:8484', 'http://[::1]:8484']) {
    assert.equal(relayEndpoint(local, CLARVIS_CREDENTIAL).ok, true, local);
  }
});

test('no path a caller builds can carry the credential to another origin', () => {
  const http = fakeHttp('http://127.0.0.1:8484');

  assert.throws(() => http.url({ path: '//evil.example/api' }), TypeError);
  assert.throws(() => http.url({ path: 'http://evil.example/api' }), TypeError);
  assert.equal(
    http.url({ path: '/api/v1/agent-sessions', query: { workspace_root: '/a b', after: null } }),
    'http://127.0.0.1:8484/api/v1/agent-sessions?workspace_root=%2Fa+b'
  );
});

test("creating a session sends the contract's request, and returns the session and its one-time token", () =>
  withClient(async (fake, client) => {
    const created = exampleNamed('POST /api/v1/agent-sessions', 'created');
    const body = created.request.body as CreateSessionBody;

    const answer = value(await client.createSession(body, createSessionKey(body.clarvis_task_id, body.window.id, 1)));

    assert.deepEqual(answer, created.response.body);
    const [seen] = fake.seen;
    assert.equal(seen.headers.authorization, `Bearer ${CLARVIS_CREDENTIAL}`);
    assert.equal(seen.headers['idempotency-key'], keyOf(created));
    assert.equal(seen.headers['content-type'], 'application/json');
    assert.equal(seen.headers['x-agent-session-token'], undefined, 'no token exists yet');
    assert.deepEqual(seen.body, body);
  }));

type Call = (client: RelayClient, example: FixtureExample) => Promise<RelayOutcome<unknown>>;

/** Every other session route a window calls, with the fixture example whose request it must repeat. */
const ROUTES: [string, string, Call][] = [
  ['GET /api/v1/agent-sessions', "the workspace's sessions", (client, example) => client.listSessions(example.request.query?.workspace_root ?? '')],
  ['GET /api/v1/agent-sessions/{sid}', 'a task waiting on a command approval', (client) => client.getSession(SID, TOKEN)],
  ['GET /api/v1/agent-sessions/{sid}/transcript', "the thread's turns", (client) => client.transcript(SID, TOKEN)],
  ['POST /api/v1/agent-sessions/{sid}/turns', 'continued, holding the lock', (client, example) => client.startTurn(SID, TOKEN, example.request.body as TurnRequest, keyOf(example))],
  [
    'POST /api/v1/agent-sessions/{sid}/turns',
    'a switch back: the lock is taken with the transfer token, atomically',
    (client, example) => client.startTurn(SID, TOKEN, example.request.body as TurnRequest, keyOf(example)),
  ],
  ['POST /api/v1/agent-sessions/{sid}/steer', 'steered into the running turn', (client, example) => client.steer(SID, TOKEN, example.request.body as SteerRequest, keyOf(example))],
  ['POST /api/v1/agent-sessions/{sid}/interrupt', 'stopping', (client) => client.interrupt(SID, TOKEN, 'stop')],
  ['POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer', 'run it once', (client) => client.answer(SID, TOKEN, 'rq_01J9ZK6M3N4P5Q6R7S8T9V0W1X', WINDOW, { kind: 'once' })],
  [
    'POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer',
    'a question answered',
    (client) => client.answer(SID, TOKEN, 'rq_01J9ZK9J1K2L3M4N5P6Q7R8S9T', WINDOW, { kind: 'answer', answers: { q1: 'Yes' } }),
  ],
  ['POST /api/v1/agent-sessions/{sid}/presence', 'the panel is connected', (client) => client.presence(SID, TOKEN, { window_id: WINDOW, host: 'desktop', panel_connected: true })],
  ['POST /api/v1/agent-sessions/{sid}/mode', 'changed from the next turn', (client) => client.setMode(SID, TOKEN, 'auto')],
  ['POST /api/v1/agent-sessions/{sid}/leftover', 'stop them', (client) => client.stopLeftover(SID, TOKEN)],
  ['POST /api/v1/agent-sessions/{sid}/settle-claim', 'claimed', (client) => client.claimSettle(SID, TOKEN, WINDOW)],
  ['POST /api/v1/agent-sessions/{sid}/settle', 'settled', (client, example) => client.settle(SID, TOKEN, settleOf(example), keyOf(example))],
  ['POST /api/v1/agent-sessions/{sid}/cancel', 'stopping, ending after the settle', (client) => client.cancel(SID, TOKEN)],
  ['DELETE /api/v1/agent-sessions/{sid}', 'ended', (client) => client.end(SID, TOKEN)],
  ['POST /api/v1/agent-sessions/{sid}/reissue-token', 'reissued', (client, example) => client.reissueToken(SID, FIXTURE_SESSION.root, keyOf(example))],
];

for (const [routeKey, name, call] of ROUTES) {
  test(`${routeKey}, "${name}": the fixture's request goes out and its answer comes back typed`, () =>
    withClient(async (fake, client) => {
      const example = exampleNamed(routeKey, name);
      fake.reply(routeKey, name);

      const answer = value(await call(client, example));

      const listed = routeKey === 'GET /api/v1/agent-sessions';
      assert.deepEqual(answer, listed ? (example.response.body as { items: unknown }).items : example.response.body);
      const [seen] = fake.seen;
      assert.equal(seen.method, example.request.method);
      assert.equal(seen.path, example.request.path);
      assert.deepEqual(seen.query, example.request.query ?? {});
      assert.deepEqual(seen.body, example.request.body);
      for (const header of ['X-Agent-Session-Token', 'Idempotency-Key', 'X-Lock-Lease']) {
        assert.equal(seen.headers[header.toLowerCase()], example.request.headers?.[header], header);
      }
    }));
}

const createFrom: Call = (client, example) => client.createSession(example.request.body as CreateSessionBody, keyOf(example));
const turnFrom: Call = (client, example) => client.startTurn(SID, TOKEN, example.request.body as TurnRequest, keyOf(example));

/** Refusals the fixtures show, and the typed failure each must become. */
const REFUSALS: [string, string, Call, Record<string, unknown>][] = [
  ['POST /api/v1/agent-sessions', 'the file rules are unproven', createFrom, { kind: 'untested_version', fileRulesUnproven: true }],
  ['POST /api/v1/agent-sessions', 'a different ChatGPT account', createFrom, { kind: 'codex_not_ready', state: 'account_changed' }],
  ['POST /api/v1/agent-sessions', "the Codex process didn't answer", createFrom, { kind: 'runtime_unavailable' }],
  ['POST /api/v1/agent-sessions', 'three live sessions already', createFrom, { kind: 'refused', status: 409, code: 'CODEX_SESSION_LIMIT' }],
  ['POST /api/v1/agent-sessions', 'a folder around this one is locked', createFrom, { kind: 'refused', status: 409, code: 'NESTED_PROJECT_LOCKED' }],
  ['POST /api/v1/agent-sessions/{sid}/turns', 'the allowance is used up', turnFrom, { kind: 'quota_exhausted' }],
  ['POST /api/v1/agent-sessions/{sid}/turns', "left idle by a switch while Clarvis's own engine holds the project", turnFrom, { kind: 'refused', code: 'PROJECT_LOCKED' }],
  ['POST /api/v1/agent-sessions/{sid}/turns', 'a turn is active: steer instead', turnFrom, { kind: 'refused', code: 'TURN_ACTIVE' }],
  ['POST /api/v1/agent-sessions/{sid}/steer', 'stopping', (client, example) => client.steer(SID, TOKEN, example.request.body as SteerRequest, keyOf(example)), { kind: 'refused', code: 'SESSION_STOPPING' }],
  [
    'POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer',
    'the other window answered first',
    (client) => client.answer(SID, TOKEN, 'rq_01J9ZK6M3N4P5Q6R7S8T9V0W1X', 'win-code-server-7f3a2b', { kind: 'once' }),
    { kind: 'refused', code: 'REQUEST_ALREADY_RESOLVED', details: { by: 'window' } },
  ],
  [
    'POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer',
    'stopping: a late answer never starts a step',
    (client) => client.answer(SID, TOKEN, 'rq_01J9ZK6M3N4P5Q6R7S8T9V0W1X', WINDOW, { kind: 'once' }),
    { kind: 'refused', code: 'SESSION_STOPPING' },
  ],
  [
    'POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer',
    'once on a change outside the project',
    (client) => client.answer(SID, TOKEN, 'rq_01J9ZK6Y2Z3A4B5C6D7E8F9G0H', WINDOW, { kind: 'once' }),
    { kind: 'refused', status: 422, code: 'DECISION_NOT_ALLOWED', details: { allowed_decisions: ['skip', 'stop'] } },
  ],
  ['POST /api/v1/agent-sessions/{sid}/settle-claim', 'the other window holds the claim', (client) => client.claimSettle(SID, TOKEN, WINDOW), { code: 'SETTLE_CLAIMED', details: { window: 'win-code-server-7f3a2b' } }],
  ['POST /api/v1/agent-sessions/{sid}/settle-claim', "RAVIS's lock was superseded at a restart", (client) => client.claimSettle(SID, TOKEN, WINDOW), { code: 'LOCK_SUPERSEDED' }],
  ['POST /api/v1/agent-sessions/{sid}/settle', "a claim that isn't the current one", (client, example) => client.settle(SID, TOKEN, settleOf(example), keyOf(example)), { code: 'CLAIM_INVALID' }],
  ['POST /api/v1/agent-sessions/{sid}/leftover', 'nothing left over', (client) => client.stopLeftover(SID, TOKEN), { code: 'NO_LEFTOVER' }],
  ['DELETE /api/v1/agent-sessions/{sid}', 'still needs a settle', (client) => client.end(SID, TOKEN), { code: 'SETTLE_FIRST' }],
  ['POST /api/v1/agent-sessions/{sid}/reissue-token', 'a window attached within 60 s', (client, example) => client.reissueToken(SID, FIXTURE_SESSION.root, keyOf(example)), { code: 'WINDOW_ATTACHED' }],
  ['GET /api/v1/agent-sessions/{sid}/transcript', "the Codex process didn't answer", (client) => client.transcript(SID, TOKEN), { kind: 'runtime_unavailable' }],
];

for (const [routeKey, name, call, expected] of REFUSALS) {
  test(`${routeKey}, "${name}": refused as ${JSON.stringify(expected)}`, () =>
    withClient(async (fake, client) => {
      fake.reply(routeKey, name);

      const refused = failure(await call(client, exampleNamed(routeKey, name)));

      assert.deepEqual(pick(refused, Object.keys(expected)), expected);
    }));
}

test("throttling from RAVIS's admission limit is its own failure, with how long to wait", () =>
  withClient(async (fake, client) => {
    fake.reply('POST /api/v1/agent-sessions/{sid}/turns', {
      status: 429,
      headers: { 'Retry-After': '12' },
      body: {
        error: { code: 'RATE_LIMITED', message: 'Too many requests.', retryable: true, details: {}, request_id: 'fixture-request-id', trace_id: 'fixture-trace-id' },
      },
      offContract: "RAVIS's admission limit can answer any route with 429; the relay fixtures list it only for owner-stop",
    });
    const example = exampleNamed('POST /api/v1/agent-sessions/{sid}/turns', 'continued, holding the lock');

    const refused = failure(await client.startTurn(SID, TOKEN, example.request.body as TurnRequest, keyOf(example)));

    assert.deepEqual(refused, { kind: 'throttled', code: 'RATE_LIMITED', retryAfterSeconds: 12 });
  }));

test('signed out is its own failure, and an expired sign-in is told apart from it', () =>
  withClient(async (fake, client) => {
    const created = exampleNamed('POST /api/v1/agent-sessions', 'created');
    for (const [state, expired] of [['signed_out', false], ['sign_in_expired', true]] as const) {
      fake.reply('POST /api/v1/agent-sessions', {
        status: 409,
        body: {
          error: {
            code: 'CODEX_NOT_READY',
            message: "Codex isn't ready.",
            retryable: false,
            details: { state, reason: 'Sign in on the dashboard.' },
            request_id: 'fixture-request-id',
            trace_id: 'fixture-trace-id',
          },
        },
      });

      const refused = failure(await client.createSession(created.request.body as CreateSessionBody, freshKey()));

      assert.deepEqual(refused, { kind: 'signed_out', expired, reason: 'Sign in on the dashboard.' });
    }
  }));

test('RAVIS not answering is unreachable: not a refusal, not throttling', async () => {
  const fake = await FakeRavisRelay.start();
  const client = new RelayClient(fakeHttp(fake));
  await fake.close();

  assert.equal(failure(await client.listSessions(FIXTURE_SESSION.root, { timeoutMs: 3_000 })).kind, 'unreachable');
});

test('a retry after a lost response resends the same key, and gets the first answer back instead of a second action', () =>
  withClient(async (fake, client) => {
    const steer = 'POST /api/v1/agent-sessions/{sid}/steer';
    const example = exampleNamed(steer, 'steered into the running turn');
    fake.reply(steer, 'steered into the running turn');
    fake.reply(steer, 'the turn ended first: queued for the next one');
    fake.loseNextResponse(steer);
    const key = freshKey();

    const answer = value(await client.steer(SID, TOKEN, example.request.body as SteerRequest, key, { retry: { attempts: 3, delayMs: 10 } }));

    assert.deepEqual(answer, { delivered: 'steered' }, 'the replayed original, not the next answer');
    assert.deepEqual(
      fake.seen.map((request) => request.headers['idempotency-key']),
      [key, key]
    );
  }));

test('the same key with a different body is refused, never replayed: a key belongs to one attempt', () =>
  withClient(async (_fake, client) => {
    const key = freshKey();

    assert.equal((await client.steer(SID, TOKEN, { text: 'Use datetime.timezone.utc.' }, key)).ok, true);
    const reused = failure(await client.steer(SID, TOKEN, { text: 'Something else.' }, key));
    assert.deepEqual(pick(reused, ['kind', 'status', 'code']), { kind: 'refused', status: 422, code: 'IDEMPOTENCY_KEY_REUSED' });
  }));

test('an answer from RAVIS is final: a refusal is not retried', () =>
  withClient(async (fake, client) => {
    fake.reply('POST /api/v1/agent-sessions/{sid}/interrupt', 'a wrong token');

    const refused = failure(await client.interrupt(SID, TOKEN, 'stop', { retry: { attempts: 5, delayMs: 10 } }));

    assert.equal(refused.kind === 'refused' && refused.code, 'AGENT_SESSION_NOT_FOUND');
    assert.equal(fake.seen.length, 1);
  }));

test('a call its caller cancels is cancelled, never reported as RAVIS being down', () =>
  withClient(async (fake, client) => {
    fake.delayResponses('POST /api/v1/agent-sessions/{sid}/interrupt', 1_000);
    const stop = new AbortController();
    const pending = client.interrupt(SID, TOKEN, 'stop', { signal: stop.signal, retry: { attempts: 5, delayMs: 10 } });
    setTimeout(() => stop.abort(), 50);

    assert.deepEqual(failure(await pending), { kind: 'cancelled' });
  }));

test('a success lacking what the contract fixes is malformed, never a half-filled value', () =>
  withClient(async (fake, client) => {
    const created = exampleNamed('POST /api/v1/agent-sessions', 'created');
    fake.reply('POST /api/v1/agent-sessions', {
      status: 201,
      body: { session: { id: SID }, session_token: 'not-a-token', events_url: '/x' },
      offContract: 'a broken answer, on purpose',
    });
    fake.reply('GET /api/v1/agent-sessions', { status: 200, raw: 'not json' });

    assert.equal(failure(await client.createSession(created.request.body as CreateSessionBody, freshKey())).kind, 'malformed');
    assert.equal(failure(await client.listSessions(FIXTURE_SESSION.root)).kind, 'malformed');
  }));

test("after a reissue the old token is refused as if the session didn't exist, and the new one works", () =>
  withClient(async (_fake, client) => {
    const reissued = value(await client.reissueToken(SID, FIXTURE_SESSION.root, freshKey()));

    const old = failure(await client.getSession(SID, TOKEN));
    assert.deepEqual(pick(old, ['kind', 'status', 'code']), { kind: 'refused', status: 404, code: 'AGENT_SESSION_NOT_FOUND' });
    assert.equal(value(await client.getSession(SID, reissued.session_token)).id, SID);
  }));
