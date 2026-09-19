import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { Activity } from './activity';
import { Bridge } from './Bridge';
import { IDENTITY_KEY, type Storage } from './identity';

/**
 * The parts of the Bridge that are about *time*: what happens when NERVIS is not
 * running yet, what happens when a lease is refused, whether a timer outlives
 * the thing it was renewing. None of those can be checked by reading, and all of
 * them are reachable here because nothing in `src/bridge/` imports `vscode`.
 */

/** A `globalState` that remembers. */
const memory = (): Storage => {
  let value: unknown;
  return {
    get: <T>(key: string) => (key === IDENTITY_KEY ? (value as T | undefined) : undefined),
    update: (key: string, next: unknown) => {
      if (key === IDENTITY_KEY) value = next;
    },
  };
};

/**
 * A NERVIS that answers however the test says, and remembers being asked.
 *
 * `answers` is given the call it is answering rather than a count of earlier
 * ones: `seen.push` happens first, so any length-based predicate is one ahead of
 * itself — which is a test that passes for the wrong reason as easily as it
 * fails for one.
 */
async function nervis(
  answers: (call: { method: string; path: string; auth: string }) => {
    status: number;
    body?: unknown;
  }
) {
  const seen: { method: string; path: string; auth: string }[] = [];
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const call = {
        method: request.method ?? '',
        path: request.url ?? '',
        auth: request.headers.authorization ?? '',
      };
      seen.push(call);
      const answer = answers(call);
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

/** A clock and a timer queue the test drives by hand. */
function heldTime() {
  const pending: { fn: () => Promise<void>; ms: number; id: number }[] = [];
  let nextId = 1;
  return {
    setTimer: (fn: () => Promise<void>, ms: number) => {
      const id = nextId++;
      pending.push({ fn, ms, id });
      return { id, unref: () => {} };
    },
    clearTimer: (handle: any) => {
      const at = pending.findIndex((entry) => entry.id === handle?.id);
      if (at >= 0) pending.splice(at, 1);
    },
    pending,
    /**
     * Runs whatever is scheduled, exactly once, and waits for what it started.
     *
     * The awaiting is the whole point: a wake-up begins a network round trip, so
     * a `fire()` that only called the callback would assert against whatever had
     * happened by then — which is a different answer on a different machine.
     */
    async fire() {
      const next = pending.shift();
      await next?.fn();
    },
  };
}

function bridgeAgainst(
  url: string,
  time = heldTime(),
  logs: string[] = [],
  send: typeof fetch = (async () => new Response('', { status: 202 })) as unknown as typeof fetch
) {
  const activity = new Activity(() => 0);
  const bridge = new Bridge({
    nervisUrl: url,
    enrollmentSecret: 'the-enrolment-secret',
    storage: memory(),
    facts: {
      appName: 'Visual Studio Code',
      workspacePath: '/w',
      buildVersion: '0.0.1',
      apiVersion: '1',
      protocolVersion: '1.0.0',
    },
    activity,
    // **No event forwarding in the unit suite.** A registered Bridge posts its
    // events to NERVIS's hub, and against the fake server here that leaves a
    // socket in flight which `fake.stop()` then waits on — one test hung the
    // whole run for eighteen minutes before this existed. What is forwarded is
    // asserted in `eventForwarding.test.ts`, where it can be observed without a
    // server at all.
    send,
    log: (message) => logs.push(message),
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    now: () => 0,
  });
  return { bridge, activity, time, logs };
}

const accepts = () => ({ status: 201, body: { token: 'issued', lease_seconds: 45 } });

// ── Starting ────────────────────────────────────────────────────────────────

test('starting binds a port and registers', async () => {
  const fake = await nervis(accepts);
  const { bridge } = bridgeAgainst(fake.url);
  try {
    await bridge.start();

    assert.ok(bridge.port > 0);
    assert.equal(bridge.registered, true);
    assert.equal(fake.seen[0].auth, 'Bearer the-enrolment-secret');
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('the surface is up even when NERVIS is not', async () => {
  // Deliberate: the socket is this window's to control and registration depends
  // on another process being alive, so waiting for the second would make
  // activation depend on whether a dashboard happens to be running.
  const { bridge } = bridgeAgainst('http://127.0.0.1:1');
  try {
    await bridge.start();

    assert.ok(bridge.port > 0);
    assert.equal(bridge.registered, false);
  } finally {
    await bridge.stop();
  }
});

test('an unregistered Bridge says so once, not on every retry', async () => {
  const { bridge, time, logs } = bridgeAgainst('http://127.0.0.1:1');
  try {
    await bridge.start();
    await time.fire();
    await time.fire();

    assert.equal(logs.filter((line) => line.includes('not registered')).length, 1);
  } finally {
    await bridge.stop();
  }
});

test('a Bridge that could not register keeps trying', async () => {
  let up = false;
  const fake = await nervis(() => (up ? accepts() : { status: 503 }));
  const { bridge, time } = bridgeAgainst(fake.url);
  try {
    await bridge.start();
    assert.equal(bridge.registered, false);

    up = true;
    await time.fire();

    assert.equal(bridge.registered, true, 'NERVIS came up and nothing noticed');
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('starting twice does not register twice', async () => {
  const fake = await nervis(accepts);
  const { bridge } = bridgeAgainst(fake.url);
  try {
    await bridge.start();
    await bridge.start();

    assert.equal(fake.seen.length, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

// ── Identity ────────────────────────────────────────────────────────────────

test('the claim carries a port and NERVIS-allowlisted fields only', async () => {
  const fake = await nervis(accepts);
  const { bridge } = bridgeAgainst(fake.url);
  try {
    await bridge.start();

    assert.equal(bridge.published?.service_type, 'clarvis');
    assert.match(bridge.published?.workspace_id ?? '', /^[0-9a-f]{32}$/);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('the claim carries the extension version NERVIS judges compatibility on', async () => {
  // §12 asks for minimum/maximum peer versions, and NERVIS could not hold Clarvis
  // to a window because a Bridge published no product version anywhere: every
  // other peer states one on /ecosystem/identity, and an extension host
  // registers instead. The Bridge already knew it — `identity.build_version`
  // serves it on the Bridge's own surface — and simply never sent it, so NERVIS
  // listed the one peer it could not judge.
  const seen: any[] = [];
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      if (request.method !== 'POST') {
        response.writeHead(204).end();
        return;
      }
      seen.push(JSON.parse(text || '{}'));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ token: 't', lease_seconds: 45 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;
  const { bridge } = bridgeAgainst(`http://127.0.0.1:${port}`);
  try {
    await bridge.start();

    assert.equal(seen.length, 1);
    // The version the Bridge already publishes about itself, not a second copy
    // of it: two places stating a version is one place stating it and one
    // going stale.
    assert.equal(seen[0].build_version, bridge.published?.build_version);
    assert.match(String(seen[0].build_version), /^\d+\.\d+\.\d+/);
  } finally {
    await bridge.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('only capabilities that are actually available are claimed', async () => {
  // §4.1: do not advertise an operation unless that exact operation passes
  // conformance. Claiming the unavailable ones would put them in the dashboard's
  // list with no way for it to know they do nothing.
  const seenBodies: any[] = [];
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      // The stop at the end of the test sends a body-less DELETE, and parsing
      // that as JSON is what made the first draft of this test fail inside its
      // own fixture rather than on its assertion.
      if (request.method !== 'POST') {
        response.writeHead(204).end();
        return;
      }
      seenBodies.push(JSON.parse(text));
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ token: 'issued', lease_seconds: 45 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const { bridge } = bridgeAgainst(`http://127.0.0.1:${port}`);
  try {
    await bridge.start();

    const claimed = Object.keys(seenBodies[0].capabilities);
    assert.ok(claimed.includes('clarvis.status.read'));
    assert.equal(claimed.includes('clarvis.ravis_provider'), false);
    for (const id of claimed) assert.doesNotMatch(id, /@/);
  } finally {
    await bridge.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ── The lease ───────────────────────────────────────────────────────────────

test('the lease is renewed with the instance token', async () => {
  const fake = await nervis((call) =>
    call.path.endsWith('/heartbeat') ? { status: 200, body: {} } : accepts());
  const { bridge, time } = bridgeAgainst(fake.url);
  try {
    await bridge.start();
    await time.fire();

    assert.equal(fake.seen[1].auth, 'Bearer issued');
    assert.match(fake.seen[1].path, /\/heartbeat$/);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('renewal is scheduled well inside the lease', async () => {
  // At the lease boundary any single missed beat is an expiry, and a suspended
  // laptop misses more than one.
  const fake = await nervis(accepts);
  const { bridge, time } = bridgeAgainst(fake.url);
  try {
    await bridge.start();

    assert.equal(time.pending[0].ms, 15_000, 'a 45s lease wants a 15s beat');
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('a refused lease drops the token even when re-registering also fails', async () => {
  // The gap is the point, and asserting only the recovered end state misses it:
  // re-registration overwrites the token, so a Bridge that never dropped the old
  // one looks identical once NERVIS answers. Making the second registration fail
  // is what separates "dropped, then replaced" from "replaced".
  let phase = 0;
  const fake = await nervis(() => {
    phase += 1;
    if (phase === 1) return accepts();
    return { status: 401, body: { error: { message: 'unknown instance' } } };
  });
  const { bridge, time } = bridgeAgainst(fake.url);
  try {
    await bridge.start();
    assert.equal(bridge.registered, true);

    await time.fire();

    assert.equal(bridge.registered, false, 'reads would answer with a token NERVIS forgot');
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('a refused lease drops the token before registering again', async () => {
  // The gap matters: answering reads with a credential NERVIS has forgotten
  // would be a Bridge claiming an authentication that no longer exists.
  let phase = 0;
  const fake = await nervis(() => {
    phase += 1;
    if (phase === 1) return accepts();
    if (phase === 2) return { status: 401, body: { error: { message: 'unknown instance' } } };
    return accepts();
  });
  const { bridge, time, logs } = bridgeAgainst(fake.url);
  try {
    await bridge.start();
    await time.fire();

    assert.equal(bridge.registered, true, 're-registration should have restored it');
    assert.equal(fake.seen[2].path, '/api/v1/registry/instances', 'it registered afresh');
    assert.ok(logs.some((line) => line.includes('not renewed')));
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('there is only ever one timer outstanding', async () => {
  const fake = await nervis(accepts);
  const { bridge, time } = bridgeAgainst(fake.url);
  try {
    await bridge.start();
    await time.fire();
    await time.fire();

    assert.equal(time.pending.length, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

// ── Stopping ────────────────────────────────────────────────────────────────

test('stopping deregisters, releases the port and cancels the timer', async () => {
  const fake = await nervis((call) => (call.method === 'DELETE' ? { status: 204 } : accepts()));
  const { bridge, time } = bridgeAgainst(fake.url);
  await bridge.start();
  const port = bridge.port;

  await bridge.stop();

  assert.equal(fake.seen[1].method, 'DELETE');
  assert.equal(time.pending.length, 0, 'a timer left running outlives what it renews');
  assert.equal(bridge.registered, false);
  await assert.rejects(
    () => fetch(`http://127.0.0.1:${port}/v1/status`),
    'the port is still held'
  );
  await fake.stop();
});

test('a second stop waits for the first, deregistration included', async () => {
  // Found live on 17 Sep 2026 (0.17.17): VS Code calls `deactivate` and then disposes the extension's
  // subscriptions at once. The subscription's stop started the deregistration; `deactivate`'s own stop
  // found the Bridge already stopping, returned at once, and the host ended before the DELETE left.
  const fake = await nervis((call) => (call.method === 'DELETE' ? { status: 204 } : accepts()));
  const { bridge } = bridgeAgainst(fake.url);
  await bridge.start();

  const first = bridge.stop();
  try {
    await bridge.stop();
    assert.equal(fake.seen.at(-1)?.method, 'DELETE', 'the second stop returned before NERVIS heard');
  } finally {
    await first;
    await fake.stop();
  }
});

test('a stopping event is published before the streams end', async () => {
  const fake = await nervis((call) => (call.method === 'DELETE' ? { status: 204 } : accepts()));
  const { bridge } = bridgeAgainst(fake.url);
  const heard: string[] = [];
  await bridge.start();
  bridge.events.listen((event) => heard.push(event.name));

  await bridge.stop();

  assert.deepEqual(heard, ['clarvis.lifecycle.stopping']);
  // Nothing else, because nothing else happened: the activity is idle throughout.
  await fake.stop();
});

test('a ready event is published only once there is somebody who could read it', async () => {
  // Before the token exists nothing can read the stream, so an earlier `ready`
  // would be an event with no possible audience that then aged out of the
  // buffer before anyone could connect.
  const fake = await nervis(accepts);
  const { bridge } = bridgeAgainst(fake.url);
  try {
    await bridge.start();

    assert.deepEqual(bridge.events.since(0).map((e) => e.name), ['clarvis.lifecycle.ready']);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('an unregistered Bridge publishes no ready event', async () => {
  const { bridge } = bridgeAgainst('http://127.0.0.1:1');
  try {
    await bridge.start();

    assert.deepEqual(bridge.events.since(0), []);
  } finally {
    await bridge.stop();
  }
});

test('stopping a Bridge that never started is harmless', async () => {
  const { bridge } = bridgeAgainst('http://127.0.0.1:1');

  await bridge.stop();
  await bridge.stop();
});

test('stopping an unregistered Bridge does not try to deregister', async () => {
  const fake = await nervis(() => ({ status: 503 }));
  const { bridge } = bridgeAgainst(fake.url);
  await bridge.start();

  await bridge.stop();

  assert.equal(fake.seen.filter((call) => call.method === 'DELETE').length, 0);
  await fake.stop();
});

test('nothing reschedules after a stop', async () => {
  const fake = await nervis(accepts);
  const { bridge, time } = bridgeAgainst(fake.url);
  await bridge.start();

  await bridge.stop();
  await time.fire();

  assert.equal(time.pending.length, 0);
  await fake.stop();
});

test('activity reaches the stream while the Bridge is up, and stops when it is not', async () => {
  // The observer is attached before the socket, so an event fired during startup
  // is buffered rather than lost — and detached after the `stopping` event, so
  // that one still had somewhere to go.
  const fake = await nervis((call) => (call.method === 'DELETE' ? { status: 204 } : accepts()));
  const { bridge, activity } = bridgeAgainst(fake.url);
  await bridge.start();

  activity.startRun();
  const during = bridge.events.since(0).map((event) => event.name);

  await bridge.stop();
  activity.startRun();

  assert.ok(during.includes('clarvis.agent.started'));
  assert.equal(
    bridge.events.since(0).filter((event) => event.name === 'clarvis.agent.started').length,
    1,
    'a stopped Bridge is still collecting'
  );
  await fake.stop();
});

test('constructing a Bridge does nothing at all until it is started', async () => {
  // Stage 8's exit says that with the setting off there is no socket, no
  // registration, no timer and no listener. `wire.ts` returns before it gets
  // here, which is one line of `vscode`-importing code and is read rather than
  // tested; this is the other half — that even reaching the constructor commits
  // to nothing, so the off path cannot leak a port through a Bridge that was
  // built and never started.
  const fake = await nervis(accepts);
  const { bridge, activity, time } = bridgeAgainst(fake.url);
  try {
    activity.startRun();

    assert.equal(bridge.port, 0);
    assert.equal(bridge.registered, false);
    assert.equal(time.pending.length, 0);
    assert.equal(fake.seen.length, 0);
    assert.deepEqual(bridge.events.since(0), [], 'nothing is being collected either');
  } finally {
    await fake.stop();
  }
});

// ── Two windows ─────────────────────────────────────────────────────────────

/**
 * A fake NERVIS that keeps a registry, so "neither overwrites the other" is a
 * property of the registry rather than of what the test asked for.
 *
 * Mirrors the two rules the real one enforces and this depends on: an
 * `instance_id` held by a *live* instance is refused, and deregistration removes
 * exactly one entry.
 */
async function registry() {
  const held = new Map<string, string>();
  const seen: { method: string; path: string; body: any }[] = [];
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => (text += chunk));
    request.on('end', () => {
      const path = request.url ?? '';
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ method: request.method ?? '', path, body });

      if (request.method === 'POST' && path.endsWith('/instances')) {
        if (held.has(body.instance_id)) {
          response.writeHead(409, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'instance_id is held by a live instance' } }));
          return;
        }
        const token = `token-for-${body.instance_id}`;
        held.set(body.instance_id, token);
        response.writeHead(201, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ token, lease_seconds: 45 }));
        return;
      }
      if (request.method === 'DELETE') {
        held.delete(decodeURIComponent(path.split('/').pop() ?? ''));
        response.writeHead(204).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    held,
    seen,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('two windows register separately and neither overwrites the other', async () => {
  // Stage 8's headline exit. The instance IDs differ because §6.6 says the same
  // workspace opened twice is honestly two instance lifetimes — so this is also
  // the check that `instance_id` is never persisted.
  const nerve = await registry();
  const one = bridgeAgainst(nerve.url);
  const two = bridgeAgainst(nerve.url);
  try {
    await one.bridge.start();
    await two.bridge.start();

    assert.equal(one.bridge.registered, true);
    assert.equal(two.bridge.registered, true);
    assert.notEqual(one.bridge.published?.instance_id, two.bridge.published?.instance_id);
    assert.notEqual(one.bridge.port, two.bridge.port, 'two windows cannot share a socket');
    assert.equal(nerve.held.size, 2);
  } finally {
    await one.bridge.stop();
    await two.bridge.stop();
    await nerve.stop();
  }
});

test('closing one window expires only its own registration', async () => {
  const nerve = await registry();
  const one = bridgeAgainst(nerve.url);
  const two = bridgeAgainst(nerve.url);
  try {
    await one.bridge.start();
    await two.bridge.start();
    const survivor = two.bridge.published?.instance_id ?? '';

    await one.bridge.stop();

    assert.deepEqual([...nerve.held.keys()], [survivor]);
    assert.equal(two.bridge.registered, true);
  } finally {
    await two.bridge.stop();
    await nerve.stop();
  }
});

test('each window holds its own token', async () => {
  const nerve = await registry();
  const one = bridgeAgainst(nerve.url);
  const two = bridgeAgainst(nerve.url);
  try {
    await one.bridge.start();
    await two.bridge.start();

    assert.equal(new Set(nerve.held.values()).size, 2, 'one token would read both windows');
  } finally {
    await one.bridge.stop();
    await two.bridge.stop();
    await nerve.stop();
  }
});

test("one window's activity never appears under the other", async () => {
  // §6.6's isolation gate. They share nothing but the fake NERVIS: separate
  // `Activity`, separate `EventStream`, separate socket.
  const nerve = await registry();
  const one = bridgeAgainst(nerve.url);
  const two = bridgeAgainst(nerve.url);
  try {
    await one.bridge.start();
    await two.bridge.start();

    one.activity.startRun();
    one.activity.noteStep();

    assert.ok(one.bridge.events.since(0).some((e) => e.name === 'clarvis.agent.step'));
    assert.equal(two.bridge.events.since(0).some((e) => e.name === 'clarvis.agent.step'), false);
    assert.equal(two.activity.snapshot().state, 'idle');
  } finally {
    await one.bridge.stop();
    await two.bridge.stop();
    await nerve.stop();
  }
});

test('model requests and tool calls reach the stream, and only their endings go on to NERVIS', async () => {
  const fake = await nervis((call) => (call.method === 'DELETE' ? { status: 204 } : accepts()));
  const posted: string[] = [];
  const send = (async (_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body).event_type);
    return new Response('', { status: 202 });
  }) as unknown as typeof fetch;
  const { bridge, activity } = bridgeAgainst(fake.url, heldTime(), [], send);
  try {
    await bridge.start();
    activity.startRun('t', 's');
    const model = { kind: 'model', role: 'agent', provider: 'custom', model: 'm', requestId: 'r', traceId: 't', sessionId: 's' } as const;
    activity.note({ ...model, phase: 'requested' });
    activity.note({ ...model, phase: 'completed', elapsedMs: 5, result: 'answered' });
    activity.note({ kind: 'tool', phase: 'started', tool: 'readFile' });
    activity.note({ kind: 'tool', phase: 'completed', tool: 'readFile', elapsedMs: 1 });
    activity.note({ kind: 'problems', errors: 0, warnings: 0, information: 0, hints: 0, files: 0 });

    const onStream = bridge.events.since(0).map((e) => e.name);
    for (const name of ['clarvis.model.requested', 'clarvis.model.completed', 'clarvis.tool.started',
      'clarvis.tool.completed', 'clarvis.diagnostic.changed']) {
      assert.ok(onStream.includes(name as never), `${name} is on the Bridge's own stream`);
    }
    assert.deepEqual(posted.filter((name) => !name.startsWith('clarvis.lifecycle.') && name !== 'clarvis.agent.started'), [
      'clarvis.model.completed', 'clarvis.tool.completed', 'clarvis.diagnostic.changed',
    ]);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test('a stopped Bridge publishes no more notes', async () => {
  const { bridge, activity } = bridgeAgainst('http://127.0.0.1:1');
  await bridge.start();
  await bridge.stop();
  const before = bridge.events.cursor;
  activity.note({ kind: 'tool', phase: 'started', tool: 'readFile' });
  assert.equal(bridge.events.cursor, before);
});

test("the status carries what is known beside the state, and the event cursor", async () => {
  const fake = await nervis((call) => (call.method === 'DELETE' ? { status: 204 } : accepts()));
  const { bridge, activity } = bridgeAgainst(fake.url);
  try {
    await bridge.start();
    activity.note({ kind: 'problems', errors: 2, warnings: 1, information: 0, hints: 0, files: 1 });
    activity.recordCheck('test', 'failed', '2026-09-16T12:00:00Z');
    activity.note({ kind: 'task', phase: 'started', taskId: 'nt_0123456789abcdef', stage: 'building' });

    const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/status`, {
      headers: { Authorization: 'Bearer issued' },
    });
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.state, 'idle');
    assert.equal(body.diagnostics_errors, 2);
    assert.equal(body.test_result, 'failed');
    assert.equal('build_result' in body, false, 'no build seen is no build reported');
    assert.equal(body.task_stage, 'building');
    assert.equal(body.event_cursor, bridge.events.cursor);
    assert.ok((body.event_cursor as number) > 0);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

// ── §6.2's `clarvis.diagnostics.summary@1`, 19 September 2026 ───────────────

test('the diagnostics capability is available exactly where the host reads problems', () => {
  const without = bridgeAgainst('http://127.0.0.1:9').bridge;
  assert.equal(without.capabilities()['clarvis.diagnostics.summary@1'].state, 'unavailable');

  const withReader = new Bridge({
    ...(without as unknown as { options: ConstructorParameters<typeof Bridge>[0] }).options,
    problems: () => ({
      errors: 0, warnings: 0, information: 0, hints: 0, files: 0, by_source: {},
    }),
  });
  assert.equal(withReader.capabilities()['clarvis.diagnostics.summary@1'].state, 'available');
});
