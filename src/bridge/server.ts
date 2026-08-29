/**
 * The Bridge's HTTP surface: node's own `http`, `127.0.0.1`, an OS-assigned port.
 *
 * **No new dependency, on purpose.** Clarvis has zero runtime dependencies and
 * `http` survives esbuild's bundling, so the whole surface is stdlib. A web
 * framework here would be the first dependency in the extension, for six routes
 * that answer with constants.
 *
 * **Every route is a GET, and that is §6.7's enforcement.** NERVIS may not
 * approve a gate, invoke a tool, expand the workspace root or change a safety
 * setting — and the way that survives somebody adding a feature later without
 * reading the specification is that there is no write path here to extend. The
 * router below refuses any method other than GET before it looks at the path.
 *
 * `vscode`-free, so the fast suite can start a real server on a real port and
 * make real requests. Everything about this file that could be wrong — the
 * refusal before a token exists, the timing-safe compare, the SSE framing, the
 * closing of live streams on dispose — is the kind of thing that only a request
 * finds out.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomUUID, timingSafeEqual } from 'crypto';
import type { ActivitySnapshot } from './activity';
import type { Identity } from './identity';
import { EventStream, frame } from './events';
import {
  capabilitiesBody,
  errorBody,
  healthBody,
  identityBody,
  statusBody,
  timestamp,
  versionBody,
  type HealthCheck,
} from './protocol';

/** How often a held-open stream emits a comment, so a proxy does not close it. */
export const HEARTBEAT_MS = 10_000;

/** What the client is told to wait before reconnecting. The server's decision, not each client's. */
export const RETRY_MS = 3_000;

export interface BridgeConfig {
  /**
   * The token NERVIS returned at registration, or `undefined` until it has.
   *
   * A function rather than a value because of the order these things happen in:
   * the server must be listening before registration, since registration is
   * what tells NERVIS the port. So there is a real window — bound, reachable,
   * no token — and every read in it is refused. See `authorised`.
   */
  readonly token: () => string | undefined;
  readonly identity: () => Identity;
  readonly status: () => ActivitySnapshot;
  readonly events: EventStream;
  readonly buildVersion: string;
  readonly startedAt: number;
  readonly log: (message: string) => void;
  readonly now?: () => number;
}

/**
 * A listening Bridge.
 *
 * `start` resolves once the port is known, because the port is the thing
 * registration has to send and there is nothing useful to do before it exists.
 */
export class BridgeServer {
  private server?: Server;
  private port = 0;
  /** What the OS says we actually bound, so the loopback rule can be checked. */
  private address = '';
  /** Held so `dispose` can end them: an open SSE response keeps the process's socket alive. */
  private readonly streams = new Set<ServerResponse>();
  private readonly now: () => number;

  constructor(private readonly config: BridgeConfig) {
    this.now = config.now ?? Date.now;
  }

  /** The port the OS gave us, or 0 before `start` has resolved. */
  get listeningPort(): number {
    return this.port;
  }

  /**
   * The address actually bound, as reported by the OS rather than as requested.
   *
   * Read back rather than remembered, because "we passed 127.0.0.1" and "we are
   * on loopback" are different claims, and only the second one is the security
   * property. A test asserts this, and it is the only way that rule stays true:
   * a wildcard bind works perfectly in every functional test.
   */
  get listeningAddress(): string {
    return this.address;
  }

  /**
   * Bind and listen.
   *
   * **`127.0.0.1`, never `0.0.0.0`.** The Bridge is a localhost control surface;
   * binding the wildcard would put an editor's activity on the network, and on a
   * laptop that means on whatever café network it is joined to.
   *
   * **Port 0.** §6.6 requires instances to avoid collisions through OS-assigned
   * endpoints, and asking the OS is the only version of that which is correct
   * for two windows opened at the same moment — a "pick one and retry on
   * EADDRINUSE" loop races itself.
   */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => this.route(request, response));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this.port = typeof address === 'object' && address ? address.port : 0;
        this.address = typeof address === 'object' && address ? address.address : '';
        this.server = server;
        this.config.log(`bridge: listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
  }

  /**
   * Stop listening and end every held stream.
   *
   * Ending the streams explicitly rather than relying on `close`: `Server.close`
   * stops accepting and then waits for existing connections, and an SSE stream
   * never ends on its own, so a Bridge that only called `close` would hold the
   * extension host open until the dashboard was shut down.
   */
  async dispose(): Promise<void> {
    for (const stream of [...this.streams]) stream.end();
    this.streams.clear();

    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.config.log('bridge: stopped listening');
  }

  /**
   * Whether this request may be answered at all.
   *
   * **Fails closed before registration.** With no token, nothing is authorised —
   * not even `/ecosystem/version`, which §4.1 requires to answer when unwell.
   * Unwell and unauthenticated are different: §6.1 says every Bridge request is
   * authenticated, and answering one because the Bridge has not finished
   * starting is exactly the hole §6.1's port-impersonation argument is about.
   *
   * Compared with `timingSafeEqual`, and length-checked first because it throws
   * on a length mismatch. The timing channel here is small and local; using the
   * safe compare costs a line and removes the argument about whether it matters.
   */
  private authorised(request: IncomingMessage): boolean {
    const expected = this.config.token();
    if (!expected) return false;

    const header = request.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private route(request: IncomingMessage, response: ServerResponse): void {
    const requestId = randomUUID();
    // §6.5: propagated when offered, minted when not, and never used for anything
    // but correlation — a trace ID authorises nothing here, and there is nothing
    // here it could authorise.
    const traceId = String(request.headers['x-trace-id'] ?? '') || randomUUID();

    // Method before path: a POST to an unknown route and a POST to a known one
    // get the same answer, so probing cannot map the surface by status code.
    if (request.method !== 'GET') {
      this.refuse(response, 405, 'METHOD_NOT_ALLOWED',
        'the Bridge is read-only; it has no write path at all', requestId, traceId);
      return;
    }

    if (!this.authorised(request)) {
      this.refuse(response, 401, 'UNAUTHORIZED',
        'the Bridge requires the token NERVIS issued at registration', requestId, traceId);
      return;
    }

    const path = (request.url ?? '').split('?', 1)[0];
    if (path === '/ecosystem/events') {
      this.stream(request, response);
      return;
    }

    const body = this.bodyFor(path);
    if (body === undefined) {
      this.refuse(response, 404, 'NOT_FOUND', `no route ${path}`, requestId, traceId);
      return;
    }
    this.send(response, 200, body, requestId, traceId);
  }

  /** The five metadata routes plus `/v1/status`, or `undefined` for anything else. */
  private bodyFor(path: string): unknown {
    switch (path) {
      case '/ecosystem/health':
        return healthBody(timestamp(this.now()), this.checks());
      case '/ecosystem/identity':
        return identityBody(this.config.identity(), timestamp(this.config.startedAt));
      case '/ecosystem/capabilities':
        // Revision 1 and static: the set does not change while a host lives, so
        // incrementing it would tell a consumer something changed when nothing
        // had. `clarvis.capability.changed` exists for when that stops being true.
        return capabilitiesBody(1);
      case '/ecosystem/version':
        return versionBody(this.config.buildVersion);
      case '/v1/status':
        return statusBody(this.config.status(), timestamp(this.now()));
      default:
        return undefined;
    }
  }

  /**
   * What the Bridge has actually verified about itself.
   *
   * Two checks, both of things that have genuinely been established by the time
   * a request is being answered. Not a list of everything Clarvis does: §4.1
   * says `ready` is independently truthful, and a health check that reports on a
   * subsystem the Bridge does not depend on would make `ready` mean "Clarvis is
   * well" rather than "this surface can be read", which is the question a
   * consumer is asking.
   */
  private checks(): HealthCheck[] {
    return [
      {
        name: 'listening',
        status: this.port > 0 ? 'pass' : 'fail',
        detail: this.port > 0 ? `bound to 127.0.0.1:${this.port}` : 'not bound',
      },
      {
        name: 'registered',
        status: this.config.token() ? 'pass' : 'fail',
        detail: this.config.token()
          ? 'holding the token NERVIS issued'
          : 'no token yet; every read is refused until registration completes',
      },
    ];
  }

  /**
   * The SSE stream.
   *
   * Sends the reconnect interval, then whatever the consumer missed, then live
   * events and a comment heartbeat. The backlog goes before the listener is
   * attached and the two are ordered by the same monotonic id, so an event
   * arriving mid-replay is delivered once and in order rather than being lost
   * between the two.
   */
  private stream(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      // Tells nginx and friends not to buffer, which would defeat the point of a
      // stream by delivering it in one piece at the end.
      'X-Accel-Buffering': 'no',
    });
    response.write(`retry: ${RETRY_MS}\n\n`);

    // **The replay and the attach must stay in one tick.** An event published
    // between them would be in neither — the backlog was already read, and the
    // listener was not yet attached — and a consumer would see a gap it could not
    // tell from quiet. Nothing here awaits, which is what makes that true; the
    // first `await` added between these two statements reintroduces the race, and
    // the fix then is to buffer during the replay rather than to deduplicate
    // after it, because the failure is a dropped event and not a doubled one.
    const last = Number(request.headers['last-event-id'] ?? 0) || 0;
    for (const event of this.config.events.since(last)) response.write(frame(event));
    const stop = this.config.events.listen((event) => response.write(frame(event)));

    const beat = setInterval(() => response.write(': heartbeat\n\n'), HEARTBEAT_MS);
    // Unreferenced so a live stream cannot hold the extension host's event loop
    // open on its own. The stream is ended by `dispose` or by the client leaving.
    beat.unref?.();

    this.streams.add(response);
    const close = (): void => {
      clearInterval(beat);
      stop();
      this.streams.delete(response);
    };
    response.on('close', close);
    response.on('error', close);
  }

  private send(
    response: ServerResponse,
    status: number,
    body: unknown,
    requestId: string,
    traceId: string
  ): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'X-Request-Id': requestId,
      'X-Trace-Id': traceId,
    });
    response.end(payload);
  }

  private refuse(
    response: ServerResponse,
    status: number,
    code: string,
    message: string,
    requestId: string,
    traceId: string
  ): void {
    this.send(response, status, errorBody(code, message, requestId, traceId), requestId, traceId);
  }
}
