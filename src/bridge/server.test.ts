import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as http from 'node:http';
import { Activity } from './activity';
import { EventStream } from './events';
import { identityFor, type StoredIdentity } from './identity';
import { BridgeServer } from './server';

/**
 * Real requests to a real socket. That is possible here only because nothing in
 * `src/bridge/` imports `vscode` — and it matters because everything about this
 * surface that could be wrong is something only a request finds out: whether the
 * refusal before registration actually refuses, whether an SSE reconnect
 * duplicates an event, whether `dispose` really lets go of the port.
 */

const stored: StoredIdentity = { service_id: 's', machine_id: 'm', workspace_salt: 'salt' };
const TOKEN = 'a-token-from-nervis';

/** A Bridge on a real port, with everything injected so a test can move it. */
async function bridge(options: { token?: string | undefined } = {}) {
  const activity = new Activity(() => 1_000);
  const events = new EventStream(() => 0);
  const identity = identityFor(stored, {
    appName: 'Visual Studio Code',
    workspacePath: '/w',
    buildVersion: '0.0.1',
    apiVersion: '1',
    protocolVersion: '1.0.0',
  });
  let token = 'token' in options ? options.token : TOKEN;

  const server = new BridgeServer({
    token: () => token,
    identity: () => identity,
    status: () => activity.snapshot(),
    events,
    buildVersion: '0.0.1',
    startedAt: 0,
    log: () => {},
    now: () => 1_000,
  });
  const port = await server.start();

  return {
    server,
    activity,
    events,
    port,
    setToken: (value: string | undefined) => (token = value),
    async get(path: string, headers: Record<string, string> = {}) {
      return request(port, path, { Authorization: `Bearer ${TOKEN}`, ...headers });
    },
    async raw(path: string, headers: Record<string, string> = {}, method = 'GET') {
      return request(port, path, headers, method);
    },
  };
}

function request(
  port: number,
  path: string,
  headers: Record<string, string>,
  method = 'GET'
): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    // `agent: false` so every request opens its own socket. The default global
    // agent pools connections, and a pooled socket to a server that has since
    // been disposed comes back as "socket hang up" rather than ECONNREFUSED —
    // which reads as the port still being held when it has in fact been released.
    const options = { host: '127.0.0.1', port, path, method, headers, agent: false };
    const call = http.request(options, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => (text += chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: text ? JSON.parse(text) : undefined,
          headers: response.headers,
        })
      );
    });
    call.on('error', reject);
    call.end();
  });
}

// ── Authentication ──────────────────────────────────────────────────────────

test('a request without the token is refused', async () => {
  const it = await bridge();
  try {
    const { status, body } = await it.raw('/v1/status');

    assert.equal(status, 401);
    assert.equal(body.error.code, 'UNAUTHORIZED');
  } finally {
    await it.server.dispose();
  }
});

test('a request with the wrong token is refused', async () => {
  const it = await bridge();
  try {
    const { status } = await it.raw('/v1/status', { Authorization: 'Bearer not-it' });

    assert.equal(status, 401);
  } finally {
    await it.server.dispose();
  }
});

test('a Bridge that has not registered yet refuses everything', async () => {
  // The window this exists for: the server has to be listening before
  // registration, because registration is what tells NERVIS the port. So there
  // is a real interval — bound, reachable, no token — and it fails closed.
  const it = await bridge({ token: undefined });
  try {
    for (const path of ['/v1/status', '/ecosystem/health', '/ecosystem/version']) {
      assert.equal((await it.get(path)).status, 401, path);
    }
  } finally {
    await it.server.dispose();
  }
});

test('the token becoming available opens the surface', async () => {
  const it = await bridge({ token: undefined });
  try {
    assert.equal((await it.get('/v1/status')).status, 401);

    it.setToken(TOKEN);

    assert.equal((await it.get('/v1/status')).status, 200);
  } finally {
    await it.server.dispose();
  }
});

test('a token that is a prefix of the real one is refused', () => {
  // The length check in front of `timingSafeEqual` is there because the compare
  // throws on a length mismatch; getting it wrong the other way — comparing only
  // the shared prefix — is the classic version of this bug.
  return bridge().then(async (it) => {
    try {
      const { status } = await it.raw('/v1/status', {
        Authorization: `Bearer ${TOKEN.slice(0, 5)}`,
      });
      assert.equal(status, 401);
    } finally {
      await it.server.dispose();
    }
  });
});

// ── Read-only ───────────────────────────────────────────────────────────────

test('every method other than GET is refused, on every path', async () => {
  // §6.7's enforcement, checked rather than read: NERVIS may not act, and the
  // reason it cannot is that there is no write path to reach.
  const it = await bridge();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { status, body } = await it.raw(
        '/v1/status',
        { Authorization: `Bearer ${TOKEN}` },
        method
      );
      assert.equal(status, 405, method);
      assert.match(body.error.message, /read-only/);
    }
  } finally {
    await it.server.dispose();
  }
});

test('a write to an unknown path answers the same as a write to a known one', async () => {
  // So the surface cannot be mapped by status code from an unauthorised probe.
  const it = await bridge();
  try {
    const known = await it.raw('/v1/status', {}, 'POST');
    const unknown = await it.raw('/v1/gates/approve', {}, 'POST');

    assert.equal(known.status, unknown.status);
    assert.equal(known.body.error.code, unknown.body.error.code);
  } finally {
    await it.server.dispose();
  }
});

test('there is no route that could approve a gate', async () => {
  const it = await bridge();
  try {
    for (const path of ['/v1/gates', '/v1/gates/approve', '/v1/tools', '/v1/commands']) {
      assert.equal((await it.get(path)).status, 404, path);
    }
  } finally {
    await it.server.dispose();
  }
});

// ── The MEP routes ──────────────────────────────────────────────────────────

test('health reports listening and registered', async () => {
  const it = await bridge();
  try {
    const { body } = await it.get('/ecosystem/health');

    assert.equal(body.status, 'healthy');
    assert.equal(body.live, true);
    assert.equal(body.ready, true);
    assert.deepEqual(body.checks.map((c: any) => c.name).sort(), ['listening', 'registered']);
  } finally {
    await it.server.dispose();
  }
});

test('identity carries §6.1 fields and no path', async () => {
  const it = await bridge();
  try {
    const { body } = await it.get('/ecosystem/identity');

    assert.equal(body.service_type, 'clarvis');
    assert.equal(body.host_kind, 'vscode');
    assert.match(body.workspace_id, /^[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(body).includes('/w'), false, 'the raw path reached the wire');
    assert.equal('workspace_salt' in body, false);
  } finally {
    await it.server.dispose();
  }
});

test('capabilities name what is missing and why', async () => {
  // §4.1: an honest "unavailable, because X" tells a peer when to look again,
  // and silence tells it nothing. So every unavailable one must carry a reason.
  const it = await bridge();
  try {
    const { body } = await it.get('/ecosystem/capabilities');
    const ids = body.capabilities.map((c: any) => c.id);

    assert.ok(ids.includes('clarvis.status.read'));
    assert.equal(ids.includes('clarvis.gates.approve'), false, '§6.7 forbids it existing');
    for (const capability of body.capabilities) {
      if (capability.state !== 'available') {
        assert.ok(capability.reason.length > 10, `${capability.id} is silent about why`);
      }
      assert.doesNotMatch(capability.id, /@/, '§4.1: the @major is never a wire value');
    }
  } finally {
    await it.server.dispose();
  }
});

test('two reads of the capabilities are byte-identical', async () => {
  const it = await bridge();
  try {
    const first = await it.get('/ecosystem/capabilities');
    const second = await it.get('/ecosystem/capabilities');

    assert.equal(JSON.stringify(first.body), JSON.stringify(second.body));
  } finally {
    await it.server.dispose();
  }
});

test('version answers with the compatible range', async () => {
  const it = await bridge();
  try {
    const { body } = await it.get('/ecosystem/version');

    assert.equal(body.protocol_version, '1.0.0');
    assert.deepEqual(body.compatible_protocol, { min: '1.0.0', max: '1.999.999' });
  } finally {
    await it.server.dispose();
  }
});

// ── Status ──────────────────────────────────────────────────────────────────

test('status reports the live activity, not a copy taken at startup', async () => {
  const it = await bridge();
  try {
    assert.equal((await it.get('/v1/status')).body.state, 'idle');

    it.activity.startRun('r1');
    it.activity.noteStep();

    const { body } = await it.get('/v1/status');
    assert.equal(body.state, 'agent_running');
    assert.equal(body.steps_taken, 1);
  } finally {
    await it.server.dispose();
  }
});

test('an unknown value is absent from the status rather than null', async () => {
  // §6.3: unknown values stay unknown. `null` is a value; absence is not.
  const it = await bridge();
  try {
    const { body } = await it.get('/v1/status');

    assert.equal('steps_taken' in body, false, 'no run means no step count');
    assert.equal('activity_id' in body, false);
  } finally {
    await it.server.dispose();
  }
});

test('a pending gate is visible as a category with no question attached', async () => {
  const it = await bridge();
  try {
    it.activity.startRun('r1');
    it.activity.awaitApproval('command');

    const { body } = await it.get('/v1/status');

    assert.equal(body.state, 'waiting_for_approval');
    assert.equal(body.awaiting, 'command');
    assert.equal(Object.keys(body).includes('command'), false);
  } finally {
    await it.server.dispose();
  }
});

// ── Events ──────────────────────────────────────────────────────────────────

/** Opens the stream and collects raw text until `until` matches, then disconnects. */
function listen(
  port: number,
  headers: Record<string, string>,
  until: (text: string) => boolean
): Promise<string> {
  return new Promise((resolve, reject) => {
    const call = http.request(
      { host: '127.0.0.1', port, path: '/ecosystem/events', headers, agent: false },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
          if (until(text)) {
            call.destroy();
            resolve(text);
          }
        });
        response.on('end', () => resolve(text));
      }
    );
    call.on('error', (failure: NodeJS.ErrnoException) => {
      if (failure.code !== 'ECONNRESET') reject(failure);
    });
    call.end();
  });
}

test('the stream is authenticated like every other route', async () => {
  // §6.1 says "every request including /ecosystem/events", and a stream is the
  // easy one to forget because it is not built like the others.
  const it = await bridge();
  try {
    const { status } = await it.raw('/ecosystem/events');

    assert.equal(status, 401);
  } finally {
    await it.server.dispose();
  }
});

test('the stream opens with the reconnect interval and replays the buffer', async () => {
  const it = await bridge();
  try {
    it.events.emit('clarvis.agent.started', { activity_id: 'r1' });

    const text = await listen(it.port, { Authorization: `Bearer ${TOKEN}` }, (t) =>
      t.includes('clarvis.agent.started')
    );

    assert.match(text, /^retry: 3000\n\n/);
    assert.match(text, /event: clarvis\.agent\.started/);
    assert.match(text, /id: 1/);
  } finally {
    await it.server.dispose();
  }
});

test('a reconnect with Last-Event-ID gets only what it missed', async () => {
  const it = await bridge();
  try {
    it.events.emit('clarvis.agent.started', {});
    it.events.emit('clarvis.agent.step', {});

    const text = await listen(
      it.port,
      { Authorization: `Bearer ${TOKEN}`, 'Last-Event-ID': '1' },
      (t) => t.includes('clarvis.agent.step')
    );

    assert.doesNotMatch(text, /clarvis\.agent\.started/, 'event 1 was replayed anyway');
    assert.match(text, /clarvis\.agent\.step/);
  } finally {
    await it.server.dispose();
  }
});

test('a live event reaches a stream that is already open', async () => {
  const it = await bridge();
  try {
    const collected = listen(it.port, { Authorization: `Bearer ${TOKEN}` }, (t) =>
      t.includes('clarvis.agent.completed')
    );
    // Published after the connection is up, so this is the live path rather than
    // the replay one.
    await new Promise((r) => setTimeout(r, 50));
    it.events.emit('clarvis.agent.completed', { steps_taken: 3 });

    assert.match(await collected, /"steps_taken":3/);
  } finally {
    await it.server.dispose();
  }
});

test('a client that leaves is forgotten', async () => {
  const it = await bridge();
  try {
    await listen(it.port, { Authorization: `Bearer ${TOKEN}` }, (t) => t.includes('retry'));
    // The close is asynchronous; give the server the tick it needs to notice.
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(it.events.listenerCount, 0, 'a leaked listener holds the run in memory');
  } finally {
    await it.server.dispose();
  }
});

// ── Lifetime ────────────────────────────────────────────────────────────────

test('the Bridge is bound to loopback and nothing else', async () => {
  // Read back from the OS rather than asserted about the argument we passed.
  // A wildcard bind works perfectly in every functional test — on a laptop it
  // would put an editor's activity on whatever network it has joined, and the
  // only thing that catches it is checking what was actually bound.
  const it = await bridge();
  try {
    assert.equal(it.server.listeningAddress, '127.0.0.1');
  } finally {
    await it.server.dispose();
  }
});

test('the port is on loopback and assigned by the OS', async () => {
  // §6.6: instances avoid collisions through OS-assigned endpoints. A fixed port
  // with a retry loop races itself when two windows open at the same moment.
  const one = await bridge();
  const two = await bridge();
  try {
    assert.ok(one.port > 0 && two.port > 0);
    assert.notEqual(one.port, two.port);
  } finally {
    await one.server.dispose();
    await two.server.dispose();
  }
});

test('disposing releases the port and ends open streams', async () => {
  // The reason `dispose` ends streams rather than only calling `close`: an SSE
  // response never finishes on its own, and `close` waits for existing
  // connections — so a Bridge that only closed would hold the extension host
  // open until the dashboard was shut down.
  const it = await bridge();
  const streaming = listen(it.port, { Authorization: `Bearer ${TOKEN}` }, () => false);
  await new Promise((r) => setTimeout(r, 50));

  await it.server.dispose();

  await streaming;
  await assert.rejects(() => request(it.port, '/v1/status', {}), /ECONNREFUSED/);
});

test('disposing twice is harmless', async () => {
  const it = await bridge();

  await it.server.dispose();
  await it.server.dispose();
});
