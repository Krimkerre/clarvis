import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import {
  deregister,
  heartbeat,
  heartbeatInterval,
  register,
  type Claim,
} from './registration';

/**
 * A fake NERVIS on a real port. The receiving half already shipped, so what
 * matters here is what actually goes over the wire — the allowlist NERVIS
 * applies, the two different credentials, the shape of the response — rather
 * than whether this module is internally consistent.
 */
async function nervis(handler: (request: http.IncomingMessage, body: string) => {
  status: number;
  body?: unknown;
}) {
  const seen: { method: string; path: string; auth: string; body: any }[] = [];
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        path: request.url ?? '',
        auth: request.headers.authorization ?? '',
        body: text ? JSON.parse(text) : undefined,
      });
      const answer = handler(request, text);
      response.writeHead(answer.status, { 'Content-Type': 'application/json' });
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const accepts = () => ({ status: 201, body: { token: 'issued-token', lease_seconds: 45 } });

const claim: Claim = {
  service: 'clarvis',
  instance_id: 'instance-1',
  machine_id: 'machine-1',
  port: 7071,
  build_version: '0.12.6',
  api_version: '1',
  protocol_version: '1.0.0',
  capabilities: { 'clarvis.status.read': '1.0.0' },
};

// ── Registering ─────────────────────────────────────────────────────────────

test('registration presents the enrolment secret and takes the token back', async () => {
  const fake = await nervis(accepts);
  try {
    const outcome = await register(fake.url, 'the-enrolment-secret', claim);

    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.token, 'issued-token');
    assert.equal(outcome.ok && outcome.leaseSeconds, 45);
    assert.equal(fake.seen[0].auth, 'Bearer the-enrolment-secret');
    assert.equal(fake.seen[0].path, '/api/v1/registry/instances');
  } finally {
    await fake.stop();
  }
});

test('the claim carries a port and never a URL or a path', async () => {
  // NERVIS builds the endpoint itself — a registrant supplying one would hand it
  // the SSRF primitive its endpoint guard exists to deny — so anything else here
  // would be silently dropped, which is worse than being refused.
  const fake = await nervis(accepts);
  try {
    await register(fake.url, 'secret', claim);

    assert.equal(fake.seen[0].body.port, 7071);
    assert.equal(JSON.stringify(fake.seen[0].body).includes('http'), false);
  } finally {
    await fake.stop();
  }
});

test('the claim carries nothing NERVIS would drop', async () => {
  // NERVIS's allowlist is `service, instance_id, machine_id, port, build_version,
  // api_version, protocol_version, capabilities`. Sending more is not refused — it
  // is logged and discarded, which means an extra field looks like it worked.
  //
  // `build_version` joined the list on 5 September so NERVIS could hold this
  // Bridge to §12's peer window; this test failed on the field the same hour,
  // which is the point of pinning the set rather than spot-checking it.
  const fake = await nervis(accepts);
  try {
    await register(fake.url, 'secret', claim);

    assert.deepEqual(Object.keys(fake.seen[0].body).sort(), [
      'api_version', 'build_version', 'capabilities', 'instance_id',
      'machine_id', 'port', 'protocol_version', 'service',
    ]);
  } finally {
    await fake.stop();
  }
});

test('no workspace ID or path is offered at registration', async () => {
  const fake = await nervis(accepts);
  try {
    await register(fake.url, 'secret', claim);
    const sent = JSON.stringify(fake.seen[0].body);

    assert.equal(sent.includes('workspace'), false);
    assert.equal(sent.includes('/'), false);
  } finally {
    await fake.stop();
  }
});

test('a refusal is reported with its status, not thrown', async () => {
  const fake = await nervis(() => ({
    status: 401,
    body: { error: { code: 'UNAUTHORIZED', message: 'registration requires the enrollment secret' } },
  }));
  try {
    const outcome = await register(fake.url, 'wrong', claim);

    assert.equal(outcome.ok, false);
    assert.match(!outcome.ok ? outcome.detail : '', /401.*enrollment secret/);
  } finally {
    await fake.stop();
  }
});

test('an accepted registration with no token is treated as a failure', async () => {
  // Worse than a refusal: the Bridge would be listed by NERVIS and unreadable by
  // it, with nothing saying why.
  const fake = await nervis(() => ({ status: 201, body: { lease_seconds: 45 } }));
  try {
    const outcome = await register(fake.url, 'secret', claim);

    assert.equal(outcome.ok, false);
    assert.match(!outcome.ok ? outcome.detail : '', /no token/);
  } finally {
    await fake.stop();
  }
});

test('a NERVIS that is not running is an outcome, not an exception', async () => {
  // The ordinary case. Nobody has to be running a dashboard.
  const outcome = await register('http://127.0.0.1:1', 'secret', claim);

  assert.equal(outcome.ok, false);
  assert.match(!outcome.ok ? outcome.detail : '', /could not reach NERVIS/);
});

test('a refusal message from NERVIS cannot run away with the log line', async () => {
  const fake = await nervis(() => ({
    status: 400,
    body: { error: { message: 'x'.repeat(5_000) } },
  }));
  try {
    const outcome = await register(fake.url, 'secret', claim);

    assert.ok(!outcome.ok && outcome.detail.length < 250);
  } finally {
    await fake.stop();
  }
});

// ── Heartbeat and deregistration ────────────────────────────────────────────

test('the heartbeat presents the instance token, never the enrolment secret', async () => {
  // Separating the two credentials is what stops a leaked heartbeat token being
  // a registration capability.
  const fake = await nervis(() => ({ status: 200, body: {} }));
  try {
    await heartbeat(fake.url, 'issued-token', 'instance-1');

    assert.equal(fake.seen[0].auth, 'Bearer issued-token');
    assert.equal(fake.seen[0].method, 'POST');
    assert.equal(fake.seen[0].path, '/api/v1/registry/instances/clarvis/instance-1/heartbeat');
  } finally {
    await fake.stop();
  }
});

test('a rejected heartbeat is reported so the caller can re-register', async () => {
  const fake = await nervis(() => ({
    status: 401,
    body: { error: { message: 'unknown instance' } },
  }));
  try {
    const outcome = await heartbeat(fake.url, 'stale', 'instance-1');

    assert.equal(outcome.ok, false);
  } finally {
    await fake.stop();
  }
});

test('deregistration is a DELETE with the instance token', async () => {
  const fake = await nervis(() => ({ status: 204 }));
  try {
    const outcome = await deregister(fake.url, 'issued-token', 'instance-1');

    assert.equal(outcome.ok, true);
    assert.equal(fake.seen[0].method, 'DELETE');
    assert.equal(fake.seen[0].path, '/api/v1/registry/instances/clarvis/instance-1');
  } finally {
    await fake.stop();
  }
});

test('an instance ID with a slash in it cannot reach another route', async () => {
  const fake = await nervis(() => ({ status: 204 }));
  try {
    await deregister(fake.url, 'token', 'a/../../evil');

    assert.equal(fake.seen[0].path.includes('/../'), false);
  } finally {
    await fake.stop();
  }
});

test('a deregistration nobody hears is not an error worth raising', async () => {
  // The extension host is usually already going when this runs.
  const outcome = await deregister('http://127.0.0.1:1', 'token', 'instance-1');

  assert.equal(outcome.ok, false);
});

// ── The interval ────────────────────────────────────────────────────────────

test('the renewal interval leaves room for two missed beats', () => {
  // At the lease boundary any single missed beat is an expiry, and a suspended
  // laptop misses more than one.
  assert.equal(heartbeatInterval(45), 15_000);
  assert.equal(heartbeatInterval(90), 30_000);
});

test('a lease of zero falls back rather than beating every tick', () => {
  // A NERVIS that answered without the field would otherwise produce an interval
  // of zero.
  assert.equal(heartbeatInterval(0), 15_000);
  assert.equal(heartbeatInterval(-1), 15_000);
});

test('a very short lease still leaves a floor', () => {
  assert.equal(heartbeatInterval(1), 5_000);
});
