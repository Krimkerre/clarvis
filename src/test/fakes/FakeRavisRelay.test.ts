import assert from 'node:assert/strict';
import { test } from 'node:test';
import { freshKey } from '../../engine/relay/idempotency';
import { RelayClient } from '../../engine/relay/relayClient';
import type { CreateSessionBody, RequestView } from '../../engine/relay/relayTypes';
import { CLARVIS_CREDENTIAL, FAKE_CREDENTIALS, fakeHttp, FakeRavisRelay, FIXTURE_SESSION } from './FakeRavisRelay';
import {
  contractRoutes,
  EVENTS_ROUTE,
  exampleNamed,
  fixture,
  frameProblems,
  requestProblems,
  responseProblems,
  routeByKey,
  SKILL_READ_ROUTE,
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

// ── R5, held to RAVIS bc1a103 ─────────────────────────────────────────────────

test("the sites fake checks every host as RAVIS's site_refusal does before it adds any, and reads back what it added", async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const client = new RelayClient(fakeHttp(fake));
    const sites = fake.sites();
    const refused = await client.allowSites(['ok.example.com', '*.hf.co', '[::1]', '192.168.1.20', 'printer.local', 'localhost', 'https://example.com/x', 'bad_host']);
    assert.deepEqual(!refused.ok && refused.failure.kind === 'refused' && refused.failure.details.refused, [
      { host: '*.hf.co', reason: 'wildcard' },
      { host: '[::1]', reason: 'ip_address' },
      { host: '192.168.1.20', reason: 'ip_address' },
      { host: 'printer.local', reason: 'local_name' },
      { host: 'localhost', reason: 'local_name' },
      { host: 'https://example.com/x', reason: 'not_a_host_name' },
      { host: 'bad_host', reason: 'not_a_host_name' },
    ]);
    assert.deepEqual([...sites.added], [], 'nothing written');

    const tooMany = await client.allowSites(Array.from({ length: 21 }, (_, index) => `h${index}.example.com`));
    assert.equal(!tooMany.ok && tooMany.failure.kind === 'refused' && tooMany.failure.code, 'INVALID_REQUEST_BODY');

    sites.notAdded = 'overridden';
    const notAdded = await client.allowSites(['HuggingFace.co']);
    assert.deepEqual(!notAdded.ok && notAdded.failure.kind === 'refused' && notAdded.failure.details, { hosts: ['huggingface.co'], reason: 'overridden' });

    const added = await client.allowSites(['HuggingFace.co.', 'pypi.org']);
    assert.deepEqual(added.ok && added.value.added, ['huggingface.co']);
    const read = await client.codexSites();
    assert.deepEqual(read.ok && read.value.added, ['huggingface.co']);

    sites.unreadable = true;
    const unreadable = await client.codexSites();
    assert.equal(!unreadable.ok && unreadable.failure.kind, 'runtime_unavailable', 'never an empty list');
    assert.deepEqual(fake.violations, []);
  } finally {
    await fake.close();
  }
});

test("the session fake holds a create's model and effort to Codex's models as RAVIS's _offered does, and shows the effort in the view", async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const client = new RelayClient(fakeHttp(fake));
    const machine = fake.sessions();
    const base = exampleNamed('POST /api/v1/agent-sessions', 'created').request.body as CreateSessionBody;
    let attempt = 0;
    const create = (patch: Partial<CreateSessionBody>) => {
      attempt++;
      return client.createSession({ ...base, clarvis_task_id: `task-${attempt}`, ...patch }, `create-${attempt}`);
    };

    const chosen = await create({ model: 'gpt-6-astra', effort: 'medium' });
    assert.equal(chosen.ok && chosen.value.session.codex.effort, 'medium');
    const plain = await create({ model: '', effort: undefined });
    assert.deepEqual(plain.ok && [plain.value.session.codex.model, plain.value.session.codex.effort], ['gpt-6-astra', null]);

    const model = await create({ model: 'gpt-4.1', effort: undefined });
    assert.deepEqual(!model.ok && model.failure.kind === 'refused' && [model.failure.code, model.failure.details], [
      'MODEL_NOT_OFFERED',
      { model: 'gpt-4.1', models: ['gpt-6-astra'] },
    ]);
    const effort = await create({ model: '', effort: 'xhigh' });
    assert.deepEqual(!effort.ok && effort.failure.kind === 'refused' && [effort.failure.code, effort.failure.details], [
      'EFFORT_NOT_OFFERED',
      { model: 'gpt-6-astra', effort: 'xhigh', efforts: ['low', 'medium', 'high'] },
    ]);

    machine.models = [];
    const early = await create({ model: 'gpt-6-astra', effort: undefined });
    assert.equal(!early.ok && early.failure.kind, 'runtime_unavailable');
    const unchecked = await create({ model: '', effort: undefined });
    assert.equal(unchecked.ok, true, 'nothing named, nothing to check');
    assert.deepEqual(fake.violations, []);
  } finally {
    await fake.close();
  }
});

test("the session fake does R5's sites as RAVIS does: a group per turn, a reopen when a turn ends with asks open, a turn that waits for it, a later group that waits its turn, and a Stop that drops the waiting turn", async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const client = new RelayClient(fakeHttp(fake));
    const machine = fake.sessions();
    machine.stepMs = 1;
    const settle = async (session: { id: string; token: string }) => {
      const claim = await client.claimSettle(session.id, session.token, 'win-1');
      if (!claim.ok) throw new Error('no claim');
      return client.settle(session.id, session.token, { claim_id: claim.value.claim_id, commit: 'c'.repeat(40), next: 'idle' }, freshKey());
    };

    const session = machine.seed();
    const events = () => session.stream.emitted().map((entry) => entry.event);
    const asks = machine.blockSites(session, ['download.pytorch.org', 'huggingface.co', 'download.pytorch.org']);
    assert.equal(asks.length, 2, 'each host once');
    assert.equal(new Set(asks.map((ask) => ask.group_id)).size, 1, "one turn's asks share a group");
    assert.match(String(asks[0].group_id), /^sg_/);
    assert.deepEqual(events().slice(-4), ['site.blocked', 'site.blocked', 'request.opened', 'request.opened'], 'open together');
    assert.equal(session.state, 'running', 'a site ask never makes the task wait');

    machine.completeTurn(session);
    assert.deepEqual(events().slice(-3), ['turn.completed', 'site.reopening', 'session.state']);
    assert.deepEqual((session.stream.view().codex as { reopening: unknown }).reopening, {
      group_id: asks[0].group_id,
      hosts: ['download.pytorch.org', 'huggingface.co'],
      since: '2026-09-14T14:03:00Z',
    });

    assert.equal((await settle(session)).ok, true);
    assert.equal(session.reopening?.resume, false, 'a settle skips the resume, never the wait');
    const turn = await client.startTurn(session.id, session.token, { text: 'Carry on where you stopped.', kind: 'carry_on' }, freshKey());
    assert.deepEqual(turn.ok && turn.value, { turn: { state: 'starting' } });
    assert.deepEqual([session.state, session.activeTurn], ['starting', null], 'it waits for the reopen');
    const again = await client.startTurn(session.id, session.token, { text: 'again', kind: 'continue' }, freshKey());
    assert.equal(!again.ok && again.failure.kind === 'refused' && again.failure.code, 'TURN_ACTIVE');

    machine.finishReopen(session);
    assert.deepEqual(events().slice(-3), ['site.reopened', 'session.state', 'turn.started'], 'resumed on demand, then begun');
    assert.equal(session.threadLoaded, true);

    assert.deepEqual(machine.blockSites(session, ['files.example.com']), [], "a later turn's asks wait for the open group");
    await client.answer(session.id, session.token, asks[0].id, 'win-1', { kind: 'allow_site' });
    await client.answer(session.id, session.token, asks[1].id, 'win-1', { kind: 'keep_blocked' });
    const opened = session.stream.emitted().filter((entry) => entry.event === 'request.opened').map((entry) => (entry.data.request as RequestView).payload.host);
    assert.deepEqual(opened, ['download.pytorch.org', 'huggingface.co', 'files.example.com']);
    assert.equal(session.open.size, 1);
    machine.completeTurn(session);
    assert.deepEqual(session.reopening?.hosts, ['files.example.com', 'download.pytorch.org'], "the group still asking, and the site allowed since the thread loaded");

    // A Stop skips the resume by itself — before any settle, and with no turn to stop (`stop` → `_skip_resume`).
    const unsettled = machine.seed();
    machine.blockSites(unsettled, ['cdn.example.net']);
    machine.completeTurn(unsettled);
    const noTurn = await client.interrupt(unsettled.id, unsettled.token, 'stop');
    assert.deepEqual(noTurn.ok && noTurn.value, { state: 'completed_needs_review' });
    assert.equal(unsettled.reopening?.resume, false, 'the resume skipped by the Stop alone');
    machine.finishReopen(unsettled);
    assert.equal(unsettled.threadLoaded, false, 'the next turn resumes the thread');

    const stopped = machine.seed();
    machine.blockSites(stopped, ['mirror.example.org']);
    machine.completeTurn(stopped);
    assert.equal((await settle(stopped)).ok, true);
    await client.startTurn(stopped.id, stopped.token, { text: 'Carry on where you stopped.', kind: 'carry_on' }, freshKey());
    const interrupted = await client.interrupt(stopped.id, stopped.token, 'stop');
    assert.deepEqual(interrupted.ok && interrupted.value, { state: 'stopping' });
    assert.deepEqual([stopped.reopening?.queued, stopped.reopening?.resume], [null, false]);
    assert.equal(stopped.open.size, 1, 'a Stop never resolves a site ask');
    machine.finishReopen(stopped);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual([stopped.activeTurn, stopped.threadLoaded], [null, false], 'the dropped turn never begins, and the next turn resumes the thread');

    const idle = machine.seed({ state: 'idle', turnActive: false });
    const quiet = await client.interrupt(idle.id, idle.token, 'stop');
    assert.deepEqual([quiet.ok && quiet.value, idle.stream.emitted()], [{ state: 'idle' }, []], 'no turn, nothing to stop');
    const [ask] = machine.blockSites(idle, ['mirror.example.org']);
    await client.answer(idle.id, idle.token, ask.id, 'win-1', { kind: 'allow_site' });
    assert.deepEqual(idle.stream.emitted().map((entry) => entry.event).slice(-3), ['site.allowed', 'request.resolved', 'site.reopening'], 'allowed while no turn runs: reopened at once');
    assert.deepEqual(fake.violations, []);
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

// ── Skills for the other models, held to skills.json's route rules (RAVIS 0.27.0) ──

test("the skills fake lists what is on in RAVIS's order, and reads a skill's files as skills.json's rules say, every refusal included", async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const client = new RelayClient(fakeHttp(fake));
    const skills = fake.skills();
    const answer = async (skill: string, file?: string) => {
      const outcome = await client.readSkill(skill, file);
      if (outcome.ok) return 'ok';
      if (outcome.failure.kind !== 'refused') return outcome.failure.kind;
      const reason = outcome.failure.details.reason;
      return typeof reason === 'string' ? `${outcome.failure.code}:${reason}` : String(outcome.failure.code);
    };

    const listed = await client.skillsForModels();
    assert.deepEqual(listed.ok && listed.value.map((skill) => skill.id), ['nervis/nervis-notes', 'personal/graphify']);
    const guide = await client.readSkill('nervis/nervis-notes', 'references/guide.md');
    assert.deepEqual(guide.ok && guide.value, exampleNamed(SKILL_READ_ROUTE, 'another file of the skill').response.body);

    assert.equal(await answer('nervis/nervis-notes'), 'ok');
    assert.equal(await answer('nervis/unknown'), 'SKILL_NOT_FOUND');
    assert.equal(await answer('nervis/nervis-notes', '../../../.ssh/id_ed25519'), 'SKILL_FILE_REFUSED:outside_skill');
    assert.equal(await answer('nervis/nervis-notes', '/etc/passwd'), 'SKILL_FILE_REFUSED:outside_skill');
    assert.equal(await answer('nervis/nervis-notes', 'references\\guide.md'), 'SKILL_FILE_REFUSED:outside_skill');
    assert.equal(await answer('nervis/nervis-notes', 'references//guide.md'), 'SKILL_FILE_REFUSED:outside_skill');
    assert.equal(await answer('nervis/nervis-notes', '.env'), 'SKILL_FILE_REFUSED:hidden');
    assert.equal(await answer('nervis/nervis-notes', 'references/.secret/guide.md'), 'SKILL_FILE_REFUSED:hidden');
    assert.equal(await answer('nervis/nervis-notes', 'references/all-notes.md'), 'SKILL_FILE_REFUSED:too_large');
    assert.equal(await answer('nervis/nervis-notes', 'assets/diagram.png'), 'SKILL_FILE_REFUSED:not_text');
    assert.equal(await answer('nervis/nervis-notes', 'references/missing.md'), 'SKILL_FILE_NOT_FOUND');
    assert.equal(await answer('nervis/nervis-notes', 'references'), 'SKILL_FILE_NOT_FOUND', 'a folder');

    skills.on.delete('personal/graphify');
    assert.equal(await answer('personal/graphify'), 'SKILL_NOT_FOUND', 'switched off reads as unknown');
    assert.equal(await answer('personal/graphify', '../x'), 'SKILL_NOT_FOUND', 'a skill that is off tells nothing about its paths');
    const after = await client.skillsForModels();
    assert.deepEqual(after.ok && after.value.map((skill) => skill.id), ['nervis/nervis-notes'], 'a switch counts from the next list');
    assert.ok(skills.reads.every((read) => !read.includes('Keeping notes')), 'reads are kept by skill and file, never text');
    assert.deepEqual(fake.violations, []);
  } finally {
    await fake.close();
  }
});

test('a NERVIS credential reads the skills as Clarvis does; anyone else is 403 FORBIDDEN, admin credentials included', async () => {
  const fake = await FakeRavisRelay.start();
  try {
    const status = async (path: string, credential?: string) =>
      (await fetch(`${fake.url}${path}`, { headers: credential ? { Authorization: `Bearer ${credential}` } : {} })).status;

    for (const path of ['/api/v1/skills/models', '/api/v1/skills/models/read?skill=nervis%2Fnervis-notes']) {
      assert.equal(await status(path, CLARVIS_CREDENTIAL), 200, path);
      assert.equal(await status(path, 'fixture-client-nervis-not-a-secret'), 200, path);
      for (const other of [undefined, 'fixture-client-other-not-a-secret', 'fixture-admin-launcher-not-a-secret']) {
        assert.equal(await status(path, other), 403, `${path} as ${other ?? 'anonymous'}`);
      }
    }
    assert.deepEqual(fake.violations.filter((violation) => violation.startsWith('response:')), []);
  } finally {
    await fake.close();
  }
});
