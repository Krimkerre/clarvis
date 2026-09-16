/**
 * FakeRavisRelay — a labelled test double of RAVIS's agent-session relay and project-lock API
 * (plan.md M15, C1; `ECOSYSTEM_RUNBOOK.md` §7).
 *
 * **What it is.** A real HTTP server on a loopback port, answering the routes Clarvis's relay and lock
 * clients call, with RAVIS's contract fixtures as its script. By default a route answers its first
 * success example; a test queues any other fixture example by name (`reply`), or a literal answer for a
 * case the fixtures only describe. Every answer it gives is checked against the fixtures, and so is
 * every request it receives (`relayContract.ts`); problems land in `violations`, which tests assert
 * empty. `/ecosystem/identity` says `test_double: true`.
 *
 * **What it keeps, and no more** (runbook §7: only what the tests need): the identity rule's refusals,
 * in order, with the fixtures' messages; each session's current token, so a wrong or replaced token is
 * `404`; `Idempotency-Key` replay and reuse; revoked leases; and one event stream per session, with a
 * replay log and a floor below which cursors have expired. It is not RAVIS: it runs no Codex and holds
 * no real lock, and the state machine behind turns, answers and settles is for a later increment to add
 * when its tests need one. Since RAVIS 0.27.0 it also serves the skills for the models that aren't Codex, the list and
 * the read a run of Clarvis's own engine makes (`fakeSkills.ts`).
 *
 * **Failure modes** (runbook §7): scripted errors (`reply`); delays (`delayResponses`); a response
 * lost after the work was done (`loseNextResponse`); RAVIS going away and coming back
 * (`stopListening`, `listenAgain`); and on a stream, disconnects, an expired cursor, duplicate events,
 * byte-by-byte delivery, no heartbeats and malformed payloads (`FakeEventStream`). A version mismatch
 * is the capability version it advertises; the clients don't read it, because the contract says
 * capabilities are never readiness checks.
 *
 * Never shipped: `src/**` is excluded from the package, and only tests import this.
 */

import { createHash, randomBytes } from 'crypto';
import * as http from 'http';
import type { AddressInfo, Socket } from 'net';
import { RelayHttp, relayEndpoint } from '../../engine/relay/relayHttp';
import { errorAnswer, firstSuccess, fixtureAnswer, type FakeAnswer } from './fakeAnswers';
import { FakeLocks } from './fakeLocks';
import { FakeSessions } from './fakeSessions';
import { FakeSites } from './fakeSites';
import { FakeSkills } from './fakeSkills';
import {
  CODEX_STATE_ROUTE,
  EVENTS_ROUTE,
  REMOVE_SITE_ROUTE,
  SITES_ROUTE,
  SKILL_READ_ROUTE,
  SKILLS_LIST_ROUTE,
  fixture,
  fixtureMessage,
  frameProblems,
  idempotentRoutes,
  matchRoute,
  requestProblems,
  responseProblems,
  routeByKey,
  type FixtureRoute,
} from './relayContract';

export type { FakeAnswer } from './fakeAnswers';

export type Caller = 'anonymous' | 'client.clarvis' | 'client.nervis' | 'client.other' | 'admin.launcher';

/** Stand-ins for the credentials each caller presents: fixture values, never real ones. */
export const FAKE_CREDENTIALS: Readonly<Record<string, Caller>> = {
  'fixture-client-clarvis-not-a-secret': 'client.clarvis',
  'fixture-client-nervis-not-a-secret': 'client.nervis',
  'fixture-client-other-not-a-secret': 'client.other',
  'fixture-admin-launcher-not-a-secret': 'admin.launcher',
};

export const CLARVIS_CREDENTIAL = 'fixture-client-clarvis-not-a-secret';

/** The session the fixtures describe, which the fake serves. */
export const FIXTURE_SESSION = {
  id: 'as_01J9ZK4T6Q8M2V7R3N5B1C0D',
  token: 'ast_FIXTURE_session_token_not_a_secret_AAAAAAAA',
  root: '/Users/owner/Documents/coding/add-utc-demo',
} as const;

/** The Clarvis-engine lock the fixtures describe. */
export const FIXTURE_LOCK = {
  id: 'pl_01J9ZK8P9Q0R1S2T3U4V5W6X7Y',
  lease: 'lk_FIXTURE_lease_not_a_secret_CCCCCCCCCCCCCCCC',
} as const;

export interface SeenRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/** A `RelayHttp` for a fake, or any loopback address, presenting the Clarvis stand-in credential. */
export function fakeHttp(target: FakeRavisRelay | string, credential: string = CLARVIS_CREDENTIAL): RelayHttp {
  const endpoint = relayEndpoint(typeof target === 'string' ? target : target.url, credential);
  if (!endpoint.ok) throw new Error(`no relay endpoint: ${endpoint.reason}`);
  return new RelayHttp(endpoint.endpoint);
}

export class FakeRavisRelay {
  readonly test_double = true;
  readonly seen: SeenRequest[] = [];
  /** Requests and answers that don't match the fixtures, prefixed `request:`, `response:` or `frame:`. */
  readonly violations: string[] = [];
  capabilityVersion = '1.0.0';

  private readonly server: http.Server;
  private readonly sockets = new Set<Socket>();
  private readonly scripts = new Map<string, FakeAnswer[]>();
  private readonly losses = new Map<string, number>();
  private readonly delays = new Map<string, number>();
  private readonly arrivals = new Map<string, number>();
  private readonly remembered = new Map<string, { digest: string; answer: FakeAnswer }>();
  private readonly tokens = new Map<string, string>();
  private readonly revoked = new Map<string, string>();
  private readonly streams = new Map<string, FakeEventStream>();
  private machine: FakeSessions | undefined;
  private lockMachine: FakeLocks | undefined;
  private siteMachine: FakeSites | undefined;
  private skillMachine: FakeSkills | undefined;
  private readonly instance = randomBytes(8).toString('hex');
  private port = 0;

  static async start(): Promise<FakeRavisRelay> {
    const fake = new FakeRavisRelay();
    await fake.listen(0);
    return fake;
  }

  private constructor() {
    this.tokens.set(FIXTURE_SESSION.id, FIXTURE_SESSION.token);
    this.server = http.createServer((request, response) => void this.handle(request, response));
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Queues the next answer for a route: a fixture example's name, or a literal answer. */
  reply(routeKey: string, answer: string | FakeAnswer): void {
    routeByKey(routeKey);
    const resolved = typeof answer === 'string' ? fixtureAnswer(routeKey, answer) : answer;
    this.scripts.set(routeKey, [...(this.scripts.get(routeKey) ?? []), resolved]);
  }

  /** The next call to the route is carried out and remembered, and its response never arrives. */
  loseNextResponse(routeKey: string): void {
    this.losses.set(routeKey, (this.losses.get(routeKey) ?? 0) + 1);
  }

  delayResponses(routeKey: string, ms: number): void {
    this.delays.set(routeKey, ms);
  }

  /**
   * The next request to exactly `pathname` is held for `ms` before anything is done with it — as if it were slow
   * on the wire — so a request sent after it can be carried out first. Once.
   */
  delayArrival(pathname: string, ms: number): void {
    this.arrivals.set(pathname, ms);
  }

  /** Another window took this lease's lock over: its heartbeats get `409 LEASE_REVOKED`. */
  revokeLease(lease: string, takenOverBy: string): void {
    this.revoked.set(lease, takenOverBy);
  }

  stream(sessionId: string = FIXTURE_SESSION.id): FakeEventStream {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = new FakeEventStream(sessionId, (problems) => this.violations.push(...problems));
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  /**
   * The session state machine (C2a): created sessions, turns, answers, steers, stops and settles. Until
   * a test asks for it, every route answers its fixture examples as C1 built it.
   */
  sessions(): FakeSessions {
    this.machine ??= new FakeSessions({
      stream: (sessionId) => this.stream(sessionId),
      grantToken: (sessionId, token) => this.tokens.set(sessionId, token),
      locks: () => this.lockMachine,
    });
    return this.machine;
  }

  /**
   * The project-lock machine (C3): locks taken, heartbeaten, released, taken over and transferred, including the
   * lock a Codex session holds. Until a test asks for it, every lock route answers its fixture examples.
   */
  locks(): FakeLocks {
    this.lockMachine ??= new FakeLocks({
      revokeLease: (lease, takenOverBy) => this.revokeLease(lease, takenOverBy),
      sessionToken: (sessionId) => this.tokens.get(sessionId),
      sessionLostLock: (sessionId) => this.sessions().lostLock(sessionId),
      unsupersede: (root) => this.sessions().unsupersede(root),
    });
    return this.lockMachine;
  }

  /**
   * The allowed sites (C2b+; R5): read, and added to before a task starts. Until a test asks for it, the sites routes
   * answer their fixture examples.
   */
  sites(): FakeSites {
    this.siteMachine ??= new FakeSites();
    return this.siteMachine;
  }

  /**
   * The skills for the models that aren't Codex (RAVIS 0.27.0; `skills.json`): listed and read as its route rules say. Until
   * a test asks for it, the two skills routes answer their fixture examples.
   */
  skills(): FakeSkills {
    this.skillMachine ??= new FakeSkills();
    return this.skillMachine;
  }

  /** Forgets scripts, keys, leases, tokens, streams and what it saw: a fresh fake on the same port. */
  reset(): void {
    this.machine = undefined;
    this.lockMachine = undefined;
    this.siteMachine = undefined;
    this.skillMachine = undefined;
    for (const stream of this.streams.values()) stream.disconnect();
    for (const map of [this.scripts, this.losses, this.delays, this.arrivals, this.remembered, this.revoked, this.streams, this.tokens]) map.clear();
    this.tokens.set(FIXTURE_SESSION.id, FIXTURE_SESSION.token);
    this.seen.length = 0;
    this.violations.length = 0;
    this.capabilityVersion = '1.0.0';
  }

  /** RAVIS stops answering: open connections drop and the port refuses new ones. */
  async stopListening(): Promise<void> {
    if (!this.server.listening) return;
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
  }

  /** RAVIS is back, on the same port. */
  listenAgain(): Promise<void> {
    return this.listen(this.port);
  }

  close(): Promise<void> {
    return this.stopListening();
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject);
        this.port = (this.server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://fake-ravis.invalid');
    const method = request.method ?? 'GET';
    const body = await readJsonBody(request);
    const late = this.arrivals.get(url.pathname) ?? 0;
    if (late > 0) {
      this.arrivals.delete(url.pathname);
      await new Promise((resolve) => setTimeout(resolve, late));
    }
    this.seen.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, body });
    if (url.pathname.startsWith('/ecosystem/')) return send(response, this.metadata(url.pathname));
    const route = matchRoute(method, url.pathname);
    if (!route) {
      this.violations.push(`request: ${method} ${url.pathname} is not a route in the fixtures`);
      return send(response, { status: 404, body: {} });
    }
    this.violations.push(...requestProblems(route, url.pathname, request.headers, body).map((problem) => `request: ${problem}`));
    const answer = this.answerFor(route, url, request, body, response);
    if (answer) await this.respond(route, url.pathname, request.headers, body, answer, response);
  }

  /** The answer, in the order RAVIS checks: identity, token, key, replay, lease, then the route. */
  private answerFor(
    route: FixtureRoute,
    url: URL,
    request: http.IncomingMessage,
    body: unknown,
    response: http.ServerResponse
  ): FakeAnswer | undefined {
    const headers = request.headers;
    const refusal =
      this.callerRefusal(route, headers) ??
      this.tokenRefusal(route, url.pathname, headers) ??
      this.keyRefusal(route, headers) ??
      this.replayed(route, url.pathname, headers, body) ??
      this.leaseRefusal(route, headers);
    if (refusal) return refusal;
    const scripted = this.scripts.get(route.key)?.shift();
    if (scripted) return scripted;
    const machined = this.machineAnswer(route, url, headers, body);
    if (machined) return machined;
    const sessionId = url.pathname.split('/')[4];
    if (route.key === EVENTS_ROUTE) return this.stream(sessionId).connect(request, response, url);
    if (route.key === 'GET /api/v1/agent-sessions/{sid}') return { status: 200, body: this.stream(sessionId).view() };
    if (route.key === 'POST /api/v1/agent-sessions/{sid}/reissue-token') return this.reissue(sessionId, body);
    return firstSuccess(route);
  }

  /** The lock machine's answer, then the session machine's, then the sites', then the skills' — whichever a test turned on. */
  private machineAnswer(route: FixtureRoute, url: URL, headers: http.IncomingHttpHeaders, body: unknown): FakeAnswer | undefined {
    return (
      this.lockMachine?.answer(route, url, headers, body) ??
      this.machine?.answer(route, url, headers, body) ??
      this.siteMachine?.answer(route, body) ??
      this.skillMachine?.answer(route, url)
    );
  }

  /**
   * Who may call a route. `GET /api/v1/codex`: any caller, anonymous and NERVIS included (`codex-state.json` route). The
   * allowed sites as `codex-admin.json` says (R5): read by Clarvis, NERVIS or an admin; added to by Clarvis alone,
   * through the identity rule (`require_agent_client`); removed by an admin. The skills for the other models as
   * `skills.json`'s access says: Clarvis's or NERVIS's client credential. Every other route: the identity rule.
   */
  private callerRefusal(route: FixtureRoute, headers: http.IncomingHttpHeaders): FakeAnswer | undefined {
    if (route.key === CODEX_STATE_ROUTE) return undefined;
    const caller = callerFrom(headers.authorization);
    if (route.key === SITES_ROUTE) {
      const reads = caller === 'client.clarvis' || caller === 'client.nervis' || caller.startsWith('admin.');
      return reads ? undefined : fixtureAnswer(SITES_ROUTE, 'anonymous');
    }
    if (route.key === REMOVE_SITE_ROUTE) return caller.startsWith('admin.') ? undefined : fixtureAnswer(REMOVE_SITE_ROUTE, 'a client credential');
    if (route.key === SKILLS_LIST_ROUTE || route.key === SKILL_READ_ROUTE) return this.skillsRefusal(route.key, caller);
    return this.identityRefusal(headers);
  }

  /** `403 FORBIDDEN` for anyone but Clarvis's or NERVIS's client credential: anonymous, another client and admin credentials alike. */
  private skillsRefusal(routeKey: string, caller: Caller): FakeAnswer | undefined {
    if (caller === 'client.clarvis' || caller === 'client.nervis') return undefined;
    const refused = fixtureAnswer(SKILLS_LIST_ROUTE, 'an admin credential');
    if (routeKey === SKILLS_LIST_ROUTE) return refused;
    return { ...refused, offContract: "skills.json's access refuses /read with 403 FORBIDDEN too, but only the list's examples show that answer" };
  }

  private identityRefusal(headers: http.IncomingHttpHeaders): FakeAnswer | undefined {
    const caller = callerFrom(headers.authorization);
    const rule = fixture('conventions.json').identity_rule.refusals_in_order as { message: string }[];
    // conventions.json's order: anonymous; any admin credential; nervis or launcher; not clarvis.
    const refusals: [boolean, string][] = [
      [caller === 'anonymous', rule[0].message],
      [caller.startsWith('admin.'), rule[1].message],
      [caller === 'client.nervis', rule[2].message],
      [caller !== 'client.clarvis', rule[3].message],
    ];
    const refusal = refusals.find(([applies]) => applies);
    return refusal && errorAnswer(403, 'AGENT_CLIENT_NOT_ALLOWED', refusal[1]);
  }

  private tokenRefusal(route: FixtureRoute, pathname: string, headers: http.IncomingHttpHeaders): FakeAnswer | undefined {
    if (!route.needs.includes('session token')) return undefined;
    const current = this.tokens.get(pathname.split('/')[4]);
    return current !== undefined && current === headers['x-agent-session-token'] ? undefined : errorAnswer(404, 'AGENT_SESSION_NOT_FOUND');
  }

  private keyRefusal(route: FixtureRoute, headers: http.IncomingHttpHeaders): FakeAnswer | undefined {
    if (!idempotentRoutes().has(route.key) || headers['idempotency-key'] !== undefined) return undefined;
    return errorAnswer(428, 'IDEMPOTENCY_KEY_REQUIRED');
  }

  private replayed(route: FixtureRoute, pathname: string, headers: http.IncomingHttpHeaders, body: unknown): FakeAnswer | undefined {
    const key = rememberKey(route, pathname, headers, body);
    const stored = key === undefined ? undefined : this.remembered.get(key);
    if (!stored) return undefined;
    return stored.digest === digestOf(body) ? stored.answer : errorAnswer(422, 'IDEMPOTENCY_KEY_REUSED');
  }

  private leaseRefusal(route: FixtureRoute, headers: http.IncomingHttpHeaders): FakeAnswer | undefined {
    const lease = headers['x-lock-lease'];
    const takenOverBy = typeof lease === 'string' ? this.revoked.get(lease) : undefined;
    if (takenOverBy === undefined || !route.key.endsWith('/heartbeat')) return undefined;
    return errorAnswer(409, 'LEASE_REVOKED', fixtureMessage('LEASE_REVOKED'), { taken_over_by: takenOverBy });
  }

  /** A new token for the fixture session's own root; the old one stops working. */
  private reissue(sessionId: string, body: unknown): FakeAnswer {
    const root = (body as { workspace_root?: unknown } | undefined)?.workspace_root;
    if (root !== FIXTURE_SESSION.root || !this.tokens.has(sessionId)) return errorAnswer(404, 'AGENT_SESSION_NOT_FOUND');
    const answer = fixtureAnswer('POST /api/v1/agent-sessions/{sid}/reissue-token', 'reissued');
    this.tokens.set(sessionId, (answer.body as { session_token: string }).session_token);
    return answer;
  }

  private async respond(
    route: FixtureRoute,
    pathname: string,
    headers: http.IncomingHttpHeaders,
    body: unknown,
    answer: FakeAnswer,
    response: http.ServerResponse
  ): Promise<void> {
    const delay = this.delays.get(route.key) ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (answer.raw === undefined && answer.offContract === undefined) {
      const problems = responseProblems(route.method, pathname, answer.status, answer.body ?? null);
      this.violations.push(...problems.map((problem) => `response: ${problem}`));
    }
    this.remember(route, pathname, headers, body, answer);
    if (this.takeLoss(route.key)) {
      response.socket?.destroy();
      return;
    }
    send(response, answer);
  }

  /** Successes are kept against their key, so a retry replays them (`conventions.json`). */
  private remember(route: FixtureRoute, pathname: string, headers: http.IncomingHttpHeaders, body: unknown, answer: FakeAnswer): void {
    const key = rememberKey(route, pathname, headers, body);
    if (key === undefined || answer.status < 200 || answer.status >= 300 || this.remembered.has(key)) return;
    this.remembered.set(key, { digest: digestOf(body), answer });
  }

  private takeLoss(routeKey: string): boolean {
    const left = this.losses.get(routeKey) ?? 0;
    if (left === 0) return false;
    this.losses.set(routeKey, left - 1);
    return true;
  }

  private metadata(pathname: string): FakeAnswer {
    if (pathname === '/ecosystem/identity') {
      return { status: 200, body: { service_type: 'ravis', service_id: 'fake-ravis-relay', instance_id: this.instance, test_double: true } };
    }
    if (pathname !== '/ecosystem/capabilities') return { status: 404, body: {} };
    const capabilities = (fixture('codex-state.json').capabilities as { id: string }[]).map((capability) =>
      capability.id === 'ravis.agent_sessions' ? { ...capability, version: this.capabilityVersion } : capability
    );
    return { status: 200, body: { revision: 1, capabilities } };
  }
}

export interface StreamConnect {
  lastEventId: string | undefined;
  after: string | null;
  windowId: string | null;
  host: string | null;
}

interface LoggedEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

/** One session's event stream in the fake: a replay log, live frames, and the stream failure modes. */
export class FakeEventStream {
  readonly connects: StreamConnect[] = [];
  /** A heartbeat comment this often; 0 sends none, for a stream that goes silent. */
  heartbeatMs = 15_000;
  /** Above 0, every write is cut into pieces of this many bytes, `chunkDelayMs` apart. */
  chunkBytes = 0;
  chunkDelayMs = 0;

  private readonly log: LoggedEvent[] = [];
  private readonly open = new Set<http.ServerResponse>();
  private readonly pending = new Map<http.ServerResponse, Promise<void>>();
  private base: Record<string, unknown>;
  private lastId: number;
  private floor = 0;

  constructor(
    readonly sessionId: string,
    private readonly report: (problems: string[]) => void
  ) {
    const view = eventExample('snapshot');
    delete view.session_id;
    this.base = { ...view, id: sessionId };
    this.lastId = view.last_event_id as number;
  }

  /** The session as `GET …/{sid}` and a snapshot show it: current to the latest event. */
  view(): Record<string, unknown> {
    return { ...structuredClone(this.base), last_event_id: this.lastId };
  }

  patchView(patch: Record<string, unknown>): void {
    this.base = { ...this.base, ...patch };
  }

  get latestId(): number {
    return this.lastId;
  }

  /** Every event kept, oldest first, for a test to read the order RAVIS would have sent them in. */
  emitted(): LoggedEvent[] {
    return structuredClone(this.log);
  }

  get connections(): number {
    return this.open.size;
  }

  /** Appends an event, checked against the fixtures, and sends it to every open connection. */
  emit(event: string, data: Record<string, unknown>): number {
    const entry: LoggedEvent = { id: this.lastId + 1, event, data: { session_id: this.sessionId, ...data } };
    this.report(frameProblems(event, entry.data).map((problem) => `frame: ${problem}`));
    this.lastId = entry.id;
    this.log.push(entry);
    for (const response of this.open) this.write(response, frameText(entry));
    return entry.id;
  }

  /** Emits `event-stream.json`'s example data for an event, with `patch` over it. */
  emitExample(event: string, patch: Record<string, unknown> = {}): number {
    const data = eventExample(event);
    delete data.session_id;
    return this.emit(event, { ...data, ...patch });
  }

  /** Sends an event that was already sent, again. */
  sendDuplicate(id: number): void {
    const entry = this.log.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`no event ${id} to send again`);
    for (const response of this.open) this.write(response, frameText(entry));
  }

  /** Writes text as it is: a malformed frame, say. */
  writeRaw(text: string): void {
    for (const response of this.open) this.write(response, text);
  }

  /** Drops every open connection, as a network hiccup or a RAVIS restart would. */
  disconnect(): void {
    for (const response of this.open) response.socket?.destroy();
  }

  /** Forgets events before `id`: a cursor older than that now gets `409 EVENT_CURSOR_EXPIRED`. */
  expireBefore(id: number): void {
    this.floor = id;
    this.log.splice(0, this.log.length, ...this.log.filter((entry) => entry.id >= id));
  }

  /** Serves a connection, or returns the refusal to send instead. */
  connect(request: http.IncomingMessage, response: http.ServerResponse, url: URL): FakeAnswer | undefined {
    const lastEventId = typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : undefined;
    const after = url.searchParams.get('after');
    this.connects.push({ lastEventId, after, windowId: url.searchParams.get('window_id'), host: url.searchParams.get('host') });
    const cursor = cursorFrom(lastEventId ?? after);
    if (cursor !== null && cursor < this.floor - 1) {
      return errorAnswer(409, 'EVENT_CURSOR_EXPIRED', fixtureMessage('EVENT_CURSOR_EXPIRED'), { oldest_event_id: this.floor });
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    this.hold(response);
    this.write(response, 'retry: 3000\n\n');
    for (const text of this.backlog(cursor)) this.write(response, text);
    return undefined;
  }

  /** Without a cursor, a snapshot; with one, every kept event after it. */
  private backlog(cursor: number | null): string[] {
    if (cursor !== null) return this.log.filter((entry) => entry.id > cursor).map(frameText);
    const data = { session_id: this.sessionId, ...this.view() };
    this.report(frameProblems('snapshot', data).map((problem) => `frame: ${problem}`));
    return [frameText({ id: this.lastId, event: 'snapshot', data })];
  }

  private hold(response: http.ServerResponse): void {
    this.open.add(response);
    const beat = this.heartbeatMs > 0 ? setInterval(() => this.write(response, ': heartbeat\n\n'), this.heartbeatMs) : undefined;
    response.on('error', () => undefined);
    response.once('close', () => {
      clearInterval(beat);
      this.open.delete(response);
      this.pending.delete(response);
    });
  }

  private write(response: http.ServerResponse, text: string): void {
    if (response.destroyed) return;
    if (this.chunkBytes <= 0) {
      response.write(text);
      return;
    }
    const previous = this.pending.get(response) ?? Promise.resolve();
    this.pending.set(response, previous.then(() => dribble(response, Buffer.from(text), this.chunkBytes, this.chunkDelayMs)));
  }
}

async function dribble(response: http.ServerResponse, bytes: Buffer, size: number, delayMs: number): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    if (response.destroyed) return;
    response.write(bytes.subarray(offset, offset + size));
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function frameText(entry: LoggedEvent): string {
  return `id: ${entry.id}\nevent: ${entry.event}\ndata: ${JSON.stringify(entry.data)}\n\n`;
}

function eventExample(event: string): Record<string, unknown> {
  const entry = (fixture('event-stream.json').events as { event: string; example_data: Record<string, unknown> }[]).find(
    (candidate) => candidate.event === event
  );
  if (!entry) throw new Error(`no event ${event} in event-stream.json`);
  return entry.example_data;
}

function callerFrom(authorization: string | undefined): Caller {
  const credential = /^Bearer (\S+)$/.exec(authorization ?? '')?.[1];
  return credential !== undefined && Object.hasOwn(FAKE_CREDENTIALS, credential) ? FAKE_CREDENTIALS[credential] : 'anonymous';
}

/** Keys are scoped to the route, the session or lock in its path, the window and root in its body. */
function rememberKey(route: FixtureRoute, pathname: string, headers: http.IncomingHttpHeaders, body: unknown): string | undefined {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || !idempotentRoutes().has(route.key)) return undefined;
  const fields = (body ?? {}) as { window?: { id?: unknown }; window_id?: unknown; workspace_root?: unknown };
  return [route.key, pathname, String(fields.window?.id ?? fields.window_id ?? ''), String(fields.workspace_root ?? ''), key].join('|');
}

function digestOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

function cursorFrom(value: string | null | undefined): number | null {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { $unparsable: text };
  }
}

function send(response: http.ServerResponse, answer: FakeAnswer): void {
  const text = answer.raw ?? (answer.body === undefined || answer.body === null ? '' : JSON.stringify(answer.body));
  const type: Record<string, string> = text === '' ? {} : { 'Content-Type': 'application/json' };
  response.writeHead(answer.status, { ...type, ...answer.headers });
  response.end(text);
}
