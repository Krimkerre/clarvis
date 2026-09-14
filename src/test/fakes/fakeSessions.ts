/**
 * FakeRavisRelay's session state machine: turns, answers, steers, stops, presence and settles, so a
 * Codex runner can be driven through a whole task against the contract (plan.md M15, C2a).
 *
 * **Still a labelled test double.** It is not RAVIS. It runs no Codex, holds no real lock and signals no
 * process. It keeps the state the relay's routes describe — `agent-sessions.json`'s session states and
 * the endpoint table in design §3.5.3 — and every answer and frame it produces goes through the same
 * fixture checks as the rest of the fake (`relayContract.ts`), so it cannot drift from the contract
 * without a test saying so. Where a fixture example exists for an answer, it answers with that example.
 *
 * **Where the contract leaves a choice, it says which it made:**
 * - a created session's first turn is reported with `kind: "brief"`, the create body's `start.kind`
 *   (the contract lists turn kinds only for later turns);
 * - the stop sequence emits `stopping`, then each open request's `request.resolved`, then — a moment
 *   later — `turn.completed` and `stopped` or `leftover` (design §5.3 step 3's order);
 * - a settled session is left `idle` without its project lock (`conventions.json` open point: "the idle
 *   view here shows it released");
 * - a turn or a steer from a session without the lock takes it when nothing holds the root
 *   (`conventions.json` turns_need_the_project_lock); the root counts as held only when a test says a
 *   window of Clarvis's own engine holds it (`holdRootForClarvis`);
 * - a lock registered with `adopt_file_lock` for a root replaces the lock RAVIS marked superseded there, so
 *   its sessions can be settled again (`lock-rule-cases.json` adoption_rule "then"); the answer itself is
 *   still the fake's fixture answer.
 *
 * - a site ask doesn't make the task wait, and allowing one emits `site.allowed` before its `request.resolved`,
 *   as RAVIS's `_decide_site` does (C2b).
 *
 * **R5, as RAVIS bc1a103 does it.** Site asks come a group per turn and open a group at a time (`SiteAsks`), and neither
 * a Stop nor the end of a turn resolves one (`_resolve_all`). A turn that ends with its group's asks open, or with a site
 * allowed since the thread loaded, lets go of the thread (`site.reopening`, `codex.reopening`), and so does allowing a
 * site while no turn runs; the wait lasts until a test ends it (`finishReopen`). A turn asked for meanwhile answers 202
 * and begins once the thread is resumed; a Stop skips the resume and drops that turn, and a settle skips the resume. A
 * Stop reaches only a turn that runs or waits (`stop`). A create's model and effort are held to `models` (`_offered`).
 *
 * Test controls — `seed`, `openRequest`, `openCalibrationRequest`, `narrowRequest`, `blockSites`, `finishReopen`,
 * `completeItem`, `completeTurn`, `ownerStop`, `restartRavis`, `supersedeLock`, `leaveProcessesOnStop`,
 * `processesGone`, `holdRootForClarvis`, `releaseRootFromClarvis`, and `models` — stand in for what Codex, the owner
 * and other windows do. Test support only.
 */

import { randomBytes, randomUUID } from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import * as path from 'path';
import type { CodexModel, CreateSessionBody, DecisionKind, RequestKind, RequestView, SessionState } from '../../engine/relay/relayTypes';
import type { CalibrationRequest } from './calibrationRequests';
import { errorAnswer, firstSuccess, fixtureAnswer, withDetails, type FakeAnswer } from './fakeAnswers';
import type { FakeLocks, SessionTake } from './fakeLocks';
import type { FakeEventStream } from './FakeRavisRelay';
import { CODEX_STATE_ROUTE, fixture, routeByKey, type FixtureRoute } from './relayContract';

export interface LeftoverProcess {
  pid: number;
  comm: string;
  started_at: string;
}

export interface MachineSession {
  readonly id: string;
  readonly token: string;
  readonly root: string;
  readonly taskId: string;
  readonly stream: FakeEventStream;
  state: SessionState;
  activeTurn: string | null;
  holdsLock: boolean;
  superseded: boolean;
  settleNeeded: boolean;
  claim: { id: string; window: string } | null;
  leftoverOnStop: LeftoverProcess[];
  readonly open: Map<string, RequestView>;
  /** Requests no longer open, and who resolved them. */
  readonly resolvedBy: Map<string, string>;
  // What windows did, for tests to assert on.
  readonly answers: { requestId: string; decision: string; key: string | undefined }[];
  readonly steers: { text: string; expectedTurnId: string | undefined; delivered: 'steered' | 'queued' }[];
  readonly turns: { text: string; kind: string }[];
  readonly claimsBy: string[];
  readonly settles: { claim_id: string; commit: string; next: string }[];
  readonly presence: { window_id: string; host: string; panel_connected: boolean }[];
  interrupts: number;
  /** The model and effort the task runs at, as its view shows them (R5). */
  model: string;
  effort: string | null;
  /** Site asks (R5): each host once per task, a group per turn, and the asks a later group keeps waiting. */
  readonly sitesSeen: Set<string>;
  readonly siteGroupOfTurn: Map<string, string>;
  readonly siteGroupHosts: Map<string, string[]>;
  sitesWaiting: RequestView[];
  /** Whether Codex's thread is loaded, the reopen under way, and the sites allowed since the thread loaded, by host (R5). */
  threadLoaded: boolean;
  reopening: FakeReopening | null;
  readonly allowedSinceLoad: Map<string, string>;
}

/** A reopen of a task's thread (R5; RAVIS's `Reopening`), waiting until a test ends it with `finishReopen`. */
export interface FakeReopening {
  groupId: string;
  hosts: string[];
  since: string;
  /** False once a Stop, a switch or a settle skipped the resume. */
  resume: boolean;
  /** A turn asked for meanwhile: it begins once the thread is resumed. */
  queued: { kind: string; text: string } | null;
}

/** What the machine needs from the fake that owns it. */
export interface MachineHost {
  stream(sessionId: string): FakeEventStream;
  grantToken(sessionId: string, token: string): void;
  /** The lock machine, once a test turned it on (C3); until then the simpler root rule below applies. */
  locks(): FakeLocks | undefined;
}

/** What a turn is refused with, by the lock machine's answer (`agent-sessions.json` turns examples). */
const TURN_REFUSALS: Record<SessionTake, string | undefined> = {
  ok: undefined,
  invalid_token: 'an expired transfer token',
  locked: "left idle by a switch while Clarvis's own engine holds the project",
  nested: 'a folder around this one is locked',
  superseded: "RAVIS's lock was superseded at a restart",
};

/** What a create is refused with, by the lock machine's answer (`agent-sessions.json` create examples). */
const CREATE_REFUSALS: Record<SessionTake, string | undefined> = {
  ok: undefined,
  invalid_token: 'an expired transfer token',
  locked: "Clarvis's own engine holds the project",
  nested: 'a folder around this one is locked',
  superseded: "resuming while RAVIS's lock is superseded",
};

const SESSIONS = 'POST /api/v1/agent-sessions';
const TURNS = 'POST /api/v1/agent-sessions/{sid}/turns';
const STEER = 'POST /api/v1/agent-sessions/{sid}/steer';
const ANSWER = 'POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer';
const CLAIM = 'POST /api/v1/agent-sessions/{sid}/settle-claim';
const SETTLE = 'POST /api/v1/agent-sessions/{sid}/settle';
const LEFTOVER = 'POST /api/v1/agent-sessions/{sid}/leftover';
const LOCKS = 'POST /api/v1/project-locks';

/** Once stopping, nothing a window sends starts anything (design §5.3 step 3.3). */
const STOPPING = new Set<SessionState>(['stopping', 'stopped', 'leftover']);
const NEEDS_SETTLE = new Set<SessionState>(['stopped', 'completed_needs_review', 'paused_unanswered', 'paused_for_update', 'uncertain']);
/** A turn runs, or is about to (RAVIS's `TURN_STATES`). */
const TURN_STATES = new Set<SessionState>(['starting', 'running', 'waiting_on_you']);
const MACHINE_LOCK_ID = 'pl_01J9ZK5A2B3C4D5E6F7G8H9J0K';

type Route = (session: MachineSession, body: unknown, headers: IncomingHttpHeaders, url: URL) => FakeAnswer;

export class FakeSessions {
  /** Milliseconds between the parts of a stop sequence, and before a steer's feedback frame. */
  stepMs = 5;
  /** The models Codex lists for this account, as `GET /api/v1/codex` shows them by default; empty until Codex lists them (R5). */
  models: CodexModel[] = (firstSuccess(routeByKey(CODEX_STATE_ROUTE)).body as { models?: CodexModel[] }).models ?? [];
  private readonly sessions = new Map<string, MachineSession>();
  /** Roots a window of Clarvis's own engine holds, as a test declares them. */
  private readonly heldByClarvis = new Set<string>();
  private counter = 0;

  private readonly routes = new Map<string, Route>([
    [TURNS, (session, body) => this.turn(session, body)],
    [STEER, (session, body) => this.steer(session, body)],
    ['POST /api/v1/agent-sessions/{sid}/interrupt', (session) => this.interrupt(session)],
    [ANSWER, (session, body, headers, url) => this.answerRequest(session, url.pathname.split('/')[6], body, headers)],
    ['POST /api/v1/agent-sessions/{sid}/presence', (session, body) => this.presence(session, body)],
    [CLAIM, (session, body) => this.claimSettle(session, body)],
    [SETTLE, (session, body) => this.settle(session, body)],
    [LEFTOVER, (session) => this.stopLeftover(session)],
  ]);

  constructor(private readonly host: MachineHost) {}

  /** The answer for a route this machine handles, or undefined for the fake's own default. */
  answer(route: FixtureRoute, url: URL, headers: IncomingHttpHeaders, body: unknown): FakeAnswer | undefined {
    if (route.key === SESSIONS) return this.create(body as CreateSessionBody);
    if (route.key === 'GET /api/v1/agent-sessions') return this.list(url.searchParams.get('workspace_root'));
    if (route.key === LOCKS) return this.adoptFileLock(body);
    const session = this.sessions.get(decodeURIComponent(url.pathname.split('/')[4] ?? ''));
    const handle = this.routes.get(route.key);
    return session && handle ? handle(session, body, headers, url) : undefined;
  }

  get(id: string): MachineSession | undefined {
    return this.sessions.get(id);
  }

  get all(): MachineSession[] {
    return [...this.sessions.values()];
  }

  // ── Test controls ───────────────────────────────────────────────────────────

  /** A live session with a token, as if a window had created it. */
  seed(options: { root?: string; taskId?: string; state?: SessionState; holdsLock?: boolean; turnActive?: boolean } = {}): MachineSession {
    this.counter++;
    const id = `as_FAKE${String(this.counter).padStart(4, '0')}${randomBytes(4).toString('hex').toUpperCase()}`;
    const state = options.state ?? 'running';
    const stream = this.host.stream(id);
    const codex = stream.view().codex as { model: string; effort?: string | null };
    const session: MachineSession = {
      id,
      token: `ast_${randomBytes(32).toString('base64url')}`,
      root: options.root ?? '/Users/owner/Documents/coding/add-utc-demo',
      taskId: options.taskId ?? randomUUID(),
      stream,
      state,
      activeTurn: options.turnActive === false ? null : randomUUID(),
      holdsLock: options.holdsLock ?? true,
      superseded: false,
      settleNeeded: NEEDS_SETTLE.has(state),
      claim: null,
      leftoverOnStop: [],
      open: new Map(),
      resolvedBy: new Map(),
      answers: [],
      steers: [],
      turns: [],
      claimsBy: [],
      settles: [],
      presence: [],
      interrupts: 0,
      model: codex.model,
      effort: codex.effort ?? null,
      sitesSeen: new Set(),
      siteGroupOfTurn: new Map(),
      siteGroupHosts: new Map(),
      sitesWaiting: [],
      threadLoaded: true,
      reopening: null,
      allowedSinceLoad: new Map(),
    };
    this.sessions.set(id, session);
    this.host.grantToken(id, session.token);
    this.sync(session);
    return session;
  }

  /** Codex asks for something: a request of `kind`, from the fixtures' example of that kind. */
  openRequest(session: MachineSession, kind: RequestKind = 'command', patch: Partial<RequestView> = {}): RequestView {
    const examples = fixture('agent-sessions.json').request_view_examples as RequestView[];
    const example = examples.find((candidate) => candidate.kind === kind);
    if (!example) throw new Error(`no ${kind} request in the fixtures`);
    this.counter++;
    const request: RequestView = { ...example, id: `rq_FAKE${this.counter}`, turn_id: session.activeTurn ?? randomUUID(), ...patch };
    return this.opened(session, request);
  }

  /** Codex asks what it asked in calibration (`calibrationRequests.ts`), as RAVIS relays it. */
  openCalibrationRequest(session: MachineSession, asked: CalibrationRequest): RequestView {
    this.counter++;
    const request: RequestView = {
      id: `rq_FAKE${this.counter}`,
      kind: asked.kind,
      turn_id: session.activeTurn ?? randomUUID(),
      item_id: asked.itemId,
      opened_at: '2026-09-14T14:02:00Z',
      payload: structuredClone(asked.payload),
      allowed_decisions: [...asked.allowed_decisions],
    };
    return this.opened(session, request);
  }

  /** RAVIS now offers less for an open request than the window was shown: its next answer outside the list is 422. */
  narrowRequest(session: MachineSession, requestId: string, allowed: DecisionKind[]): void {
    const request = session.open.get(requestId);
    if (request) request.allowed_decisions = allowed;
    this.sync(session);
  }

  /**
   * Codex's proxy blocked the running turn's commands from reaching `hosts` (R5; RAVIS's `SiteAsks`): each host once per
   * task, asked in the turn's group, which opens at once unless another group is still being decided. Returns the asks
   * that opened.
   */
  blockSites(session: MachineSession, hosts: string[]): RequestView[] {
    const turnId = session.activeTurn ?? randomUUID();
    for (const host of hosts) {
      if (session.sitesSeen.has(host)) continue;
      session.sitesSeen.add(host);
      const groupId = this.groupFor(session, turnId);
      session.siteGroupHosts.get(groupId)?.push(host);
      this.counter++;
      const itemId = `call_fake_site_${this.counter}`;
      session.stream.emit('site.blocked', { turn_id: turnId, item_id: itemId, host, protocol: 'https' });
      session.sitesWaiting.push({
        id: `rq_FAKE${this.counter}`,
        kind: 'site',
        turn_id: turnId,
        group_id: groupId,
        item_id: itemId,
        opened_at: '2026-09-14T14:02:00Z',
        payload: { host, protocol: 'https' },
        allowed_decisions: ['allow_site', 'keep_blocked'],
      });
    }
    return this.openWaitingSites(session);
  }

  /**
   * The reopen's wait ends (R5): Codex let go of the thread (`site.reopened`), or still held it at the cap
   * (`site.reopen_incomplete`). RAVIS then resumes the thread unless a Stop, a switch or a settle skipped that, and a
   * turn that waited begins (`_reopened`).
   */
  finishReopen(session: MachineSession, how: 'reopened' | 'incomplete' = 'reopened'): void {
    const reopening = session.reopening;
    if (!reopening) throw new Error('no reopen under way');
    session.reopening = null;
    this.sync(session);
    session.stream.emit(how === 'reopened' ? 'site.reopened' : 'site.reopen_incomplete', { group_id: reopening.groupId, hosts: reopening.hosts });
    if (reopening.resume || reopening.queued) this.loadThread(session);
    if (reopening.queued) this.beginTurn(session, reopening.queued.kind);
  }

  /** A site ask never makes the task wait: the command it is about has already failed. */
  private opened(session: MachineSession, request: RequestView): RequestView {
    session.open.set(request.id, request);
    if (request.kind !== 'site') session.state = 'waiting_on_you';
    this.sync(session);
    session.stream.emit('request.opened', { request });
    return request;
  }

  /** Sends an opened request again, as a replay after a restart could. */
  resendRequest(session: MachineSession, request: RequestView): number {
    return session.stream.emit('request.opened', { request });
  }

  /** A finished item of Codex's turn. */
  completeItem(session: MachineSession, item: Record<string, unknown>): number {
    return session.stream.emit('item.completed', { turn_id: session.activeTurn ?? randomUUID(), item });
  }

  /** The turn ends; the session's work then waits to be saved. */
  completeTurn(session: MachineSession, outcome: { status: 'completed' | 'failed' | 'interrupted'; error?: { kind: string; message: string } } = { status: 'completed' }): void {
    const error = outcome.error ? { error: outcome.error } : {};
    const turnId = session.activeTurn ?? randomUUID();
    session.stream.emit('turn.completed', { turn_id: turnId, status: outcome.status, ...error, processes_confirmed_gone: true });
    session.activeTurn = null;
    // Before the state that follows, as RAVIS's `_conclude_turn` does (R5).
    this.reopenAfterTurn(session, turnId);
    session.state = 'completed_needs_review';
    session.settleNeeded = true;
    this.sync(session);
    session.stream.emit('session.state', { state: 'completed_needs_review', processes: { confirmed_gone: true, leftover: [] } });
  }

  /** The owner's Stop from the menu bar or the dashboard (design §3.5.5). */
  ownerStop(session: MachineSession, source: 'menu_bar' | 'dashboard'): void {
    this.stop(session, source);
  }

  /** RAVIS restarted mid-turn: the session is uncertain, and its work waits to be saved (design §9). */
  restartRavis(session: MachineSession): void {
    session.activeTurn = null;
    session.open.clear();
    session.state = 'uncertain';
    session.settleNeeded = true;
    this.sync(session);
    session.stream.emit('session.state', { state: 'uncertain', processes: { confirmed_gone: true, leftover: [] } });
  }

  /** Another editor held the checkout when RAVIS restarted: RAVIS's lock is superseded (design §6.3). */
  supersedeLock(session: MachineSession): void {
    session.superseded = true;
    this.host.locks()?.supersede(session.root);
    this.sync(session);
    session.stream.emit('lock.changed', { state: 'superseded' });
  }

  leaveProcessesOnStop(session: MachineSession, leftover: LeftoverProcess[]): void {
    session.leftoverOnStop = leftover;
  }

  /** The processes a stop left behind are gone now. */
  processesGone(session: MachineSession): void {
    session.leftoverOnStop = [];
    this.toStopped(session, undefined);
  }

  /** A window running Clarvis's own engine holds `root`: a Codex session without the lock can't start a turn there. */
  holdRootForClarvis(root: string): void {
    this.heldByClarvis.add(root);
  }

  releaseRootFromClarvis(root: string): void {
    this.heldByClarvis.delete(root);
  }

  /** The lock machine moved a session's lock to a window (a transfer taken with its token). */
  lostLock(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.holdsLock = false;
    this.sync(session);
  }

  /** An adoption replaced RAVIS's superseded lock for `root`: its sessions can be settled again. */
  unsupersede(root: string): void {
    for (const session of this.all) {
      if (session.root !== root || !session.superseded) continue;
      session.superseded = false;
      session.holdsLock = false;
      this.sync(session);
    }
  }

  // ── Routes ──────────────────────────────────────────────────────────────────

  private create(body: CreateSessionBody): FakeAnswer {
    // RAVIS holds the model and effort to Codex's list before it looks at the lock (`sessions.py` create, R5).
    const offered = this.offered(body);
    if ('refusal' in offered) return offered.refusal;
    const locks = this.host.locks();
    const refusal = locks ? CREATE_REFUSALS[locks.sessionTakes(body.workspace_root, undefined, body.lock.transfer_token)] : undefined;
    if (refusal) return fixtureAnswer(SESSIONS, refusal);
    const session = this.seed({ root: body.workspace_root, taskId: body.clarvis_task_id });
    session.model = offered.model || session.model;
    session.effort = typeof body.effort === 'string' && body.effort !== '' ? body.effort : null;
    locks?.giveToSession(body.workspace_root, session.id, body.lock.transfer_token);
    this.sync(session);
    const answer = fixtureAnswer(SESSIONS, 'created');
    const view = session.stream.view();
    const codex = { ...(view.codex as Record<string, unknown>), active_turn_id: null };
    answer.body = {
      session: { ...view, state: 'starting', codex },
      session_token: session.token,
      events_url: `/api/v1/agent-sessions/${session.id}/events`,
    };
    setTimeout(() => this.announceTurn(session, 'brief'), this.stepMs);
    return answer;
  }

  /**
   * RAVIS's `_offered` (bc1a103): nothing named, Codex's default model; a named model must be one Codex lists, and a named
   * effort one of that model's — the default model's when none is named; before Codex lists its models, 503.
   */
  private offered(body: CreateSessionBody): { model: string } | { refusal: FakeAnswer } {
    const effort = typeof body.effort === 'string' && body.effort !== '' ? body.effort : null;
    const fallback = this.models.find((model) => model.is_default) ?? this.models[0];
    if (!body.model && effort === null) return { model: fallback?.id ?? '' };
    if (this.models.length === 0) {
      const message = "Codex hasn't listed its models yet, so the model and effort can't be checked; try again in a moment.";
      return { refusal: errorAnswer(503, 'CODEX_RUNTIME_UNAVAILABLE', message) };
    }
    const chosen = body.model ? this.models.find((model) => model.id === body.model) : fallback;
    if (!chosen) {
      return { refusal: withDetails(fixtureAnswer(SESSIONS, "a model Codex doesn't offer"), { model: body.model, models: this.models.map((model) => model.id) }) };
    }
    if (effort !== null && !chosen.efforts.includes(effort)) {
      return { refusal: withDetails(fixtureAnswer(SESSIONS, "an effort that model doesn't offer"), { model: chosen.id, effort, efforts: chosen.efforts }) };
    }
    return { model: chosen.id };
  }

  private list(root: string | null): FakeAnswer {
    const items = this.all
      .filter((session) => session.root === root)
      .map((session) => ({
        id: session.id,
        state: session.state,
        clarvis_task_id: session.taskId,
        created_at: '2026-09-13T01:12:00Z',
        updated_at: '2026-09-13T01:54:00Z',
        waiting_on_you: session.open.size > 0,
        attached_windows: 0,
      }));
    return { status: 200, body: { items } };
  }

  private turn(session: MachineSession, body: unknown): FakeAnswer {
    const refusal = this.turnRefusal(session, body as { lock?: { transfer_token?: string } });
    if (refusal) return fixtureAnswer(TURNS, refusal);
    const turn = body as { text: string; kind: string; lock?: { transfer_token?: string } };
    this.host.locks()?.giveToSession(session.root, session.id, turn.lock?.transfer_token);
    session.turns.push({ text: turn.text, kind: turn.kind });
    session.holdsLock = true;
    // Unloaded by a reopen whose resume was skipped: resumed now. Loaded before the last allowed site: reopened first (R5).
    if (!session.threadLoaded && !session.reopening) this.loadThread(session);
    this.reopenIfStale(session);
    if (session.reopening) return this.waitForReopen(session, session.reopening, turn);
    this.beginTurn(session, turn.kind);
    return { status: 202, body: { turn: { state: 'starting' } } };
  }

  /** A turn asked for while the thread reopens: `starting` now, and begun once the thread is resumed (R5). */
  private waitForReopen(session: MachineSession, reopening: FakeReopening, turn: { text: string; kind: string }): FakeAnswer {
    reopening.queued = { kind: turn.kind, text: turn.text };
    session.state = 'starting';
    this.sync(session);
    session.stream.emit('session.state', { state: 'starting', processes: { confirmed_gone: false, leftover: [] } });
    return { status: 202, body: { turn: { state: 'starting' } } };
  }

  private turnRefusal(session: MachineSession, body: { lock?: { transfer_token?: string } }): string | undefined {
    if (session.activeTurn || session.reopening?.queued) return 'a turn is active: steer instead';
    if (STOPPING.has(session.state)) return 'stopping';
    if (session.settleNeeded) return 'the last turn still needs a settle';
    if (session.superseded) return "RAVIS's lock was superseded at a restart";
    const locks = this.host.locks();
    if (locks) return TURN_REFUSALS[locks.sessionTakes(session.root, session.id, body.lock?.transfer_token)];
    if (session.holdsLock || body.lock?.transfer_token) return undefined;
    // Taken in the same request when nothing holds the root (conventions.json turns_need_the_project_lock).
    return this.heldByClarvis.has(session.root) ? "left idle by a switch while Clarvis's own engine holds the project" : undefined;
  }

  /** A file lock registered with `adopt_file_lock` replaces RAVIS's superseded lock for its root. */
  private adoptFileLock(body: unknown): undefined {
    const request = (body ?? {}) as { workspace_root?: unknown; adopt_file_lock?: unknown };
    if (request.adopt_file_lock !== true) return undefined;
    for (const session of this.all) {
      if (session.root !== request.workspace_root || !session.superseded) continue;
      session.superseded = false;
      session.holdsLock = false;
      this.sync(session);
    }
    return undefined;
  }

  private announceTurn(session: MachineSession, kind: string): void {
    session.state = 'running';
    this.sync(session);
    session.stream.emit('session.state', { state: 'running', processes: { confirmed_gone: false, leftover: [] } });
    session.stream.emit('turn.started', { turn_id: session.activeTurn ?? randomUUID(), kind });
  }

  private beginTurn(session: MachineSession, kind: string): void {
    session.activeTurn = randomUUID();
    this.announceTurn(session, kind);
  }

  // ── Blocked sites and reopening (R5) ───────────────────────────────────────

  /** Codex's thread loaded again — resumed — reading every site allowed so far (`_hold_thread`). */
  private loadThread(session: MachineSession): void {
    session.threadLoaded = true;
    session.allowedSinceLoad.clear();
  }

  /** A turn ended with asks of its group open, or with a site allowed since the thread loaded: reopen (`_reopen_after_turn`). */
  private reopenAfterTurn(session: MachineSession, turnId: string): void {
    if (session.reopening || !session.threadLoaded) return;
    const group = session.siteGroupOfTurn.get(turnId);
    if (group === undefined || !this.stillAsking(session, group)) return this.reopenIfStale(session);
    const hosts = [...(session.siteGroupHosts.get(group) ?? []), ...session.allowedSinceLoad.keys()];
    this.beginReopen(session, group, [...new Set(hosts)]);
  }

  private stillAsking(session: MachineSession, group: string): boolean {
    const ofGroup = (request: RequestView) => request.kind === 'site' && request.group_id === group;
    return [...session.open.values()].some(ofGroup) || session.sitesWaiting.some(ofGroup);
  }

  /** Never a turn in a thread loaded before the task's last allowed site (`_reopen_if_stale`). */
  private reopenIfStale(session: MachineSession): void {
    if (session.reopening || !session.threadLoaded || session.allowedSinceLoad.size === 0) return;
    const groups = [...session.allowedSinceLoad.values()];
    this.beginReopen(session, groups[groups.length - 1], [...session.allowedSinceLoad.keys()]);
  }

  /** RAVIS lets go of the thread at once: `site.reopening`, and `codex.reopening` in the view until the wait ends. */
  private beginReopen(session: MachineSession, groupId: string, hosts: string[]): void {
    session.threadLoaded = false;
    session.reopening = { groupId, hosts, since: '2026-09-14T14:03:00Z', resume: true, queued: null };
    this.sync(session);
    session.stream.emit('site.reopening', { group_id: groupId, hosts });
  }

  /** An allowed site: a loaded thread can't reach it, so it is reopened — at once while no turn runs (`_site_allowed`). */
  private siteAllowed(session: MachineSession, host: string, groupId: string): void {
    if (!session.threadLoaded) return;
    session.allowedSinceLoad.set(host, groupId);
    if (!TURN_STATES.has(session.state) && session.state !== 'stopping') this.reopenIfStale(session);
  }

  /** A group's asks open together; a later group's wait until every ask of the open group is decided (`_open_waiting_sites`). */
  private openWaitingSites(session: MachineSession): RequestView[] {
    if (session.sitesWaiting.length === 0) return [];
    const open = new Set([...session.open.values()].filter((request) => request.kind === 'site').map((request) => request.group_id));
    const groups = open.size > 0 ? open : new Set([session.sitesWaiting[0].group_id]);
    const ready = session.sitesWaiting.filter((request) => groups.has(request.group_id));
    session.sitesWaiting = session.sitesWaiting.filter((request) => !groups.has(request.group_id));
    return ready.map((request) => this.opened(session, request));
  }

  private groupFor(session: MachineSession, turnId: string): string {
    const known = session.siteGroupOfTurn.get(turnId);
    if (known) return known;
    this.counter++;
    const groupId = `sg_FAKE${String(this.counter).padStart(4, '0')}`;
    session.siteGroupOfTurn.set(turnId, groupId);
    session.siteGroupHosts.set(groupId, []);
    return groupId;
  }

  private steer(session: MachineSession, body: unknown): FakeAnswer {
    const steer = body as { text?: string; expected_turn_id?: string };
    if (!steer.text?.trim()) return fixtureAnswer(STEER, 'empty text');
    if (STOPPING.has(session.state)) return fixtureAnswer(STEER, 'stopping');
    const locks = this.host.locks();
    const lockedOut = locks ? locks.sessionTakes(session.root, session.id, undefined) !== 'ok' : !session.holdsLock && this.heldByClarvis.has(session.root);
    if (!session.activeTurn && lockedOut) return fixtureAnswer(STEER, 'no active turn and no lock: nothing is queued');
    const delivered = session.activeTurn ? 'steered' : 'queued';
    const text = steer.text;
    session.steers.push({ text, expectedTurnId: steer.expected_turn_id, delivered });
    setTimeout(() => session.stream.emit('feedback', { text, how: delivered }), this.stepMs);
    return { status: 202, body: { delivered } };
  }

  private interrupt(session: MachineSession): FakeAnswer {
    session.interrupts++;
    // Pressed again: still 202, and nothing happens twice. With no turn to stop, the state as it is.
    this.stop(session, 'window');
    return { status: 202, body: { state: session.state } };
  }

  /** RAVIS's `stop`: it skips a reopen's resume whenever it comes, and stops only a turn that runs or waits (R5). */
  private stop(session: MachineSession, by: 'window' | 'menu_bar' | 'dashboard'): void {
    if (session.reopening) session.reopening.resume = false;
    if (TURN_STATES.has(session.state)) this.stopSequence(session, by);
  }

  /** Design §5.3 step 3, in its order: stopping; open requests resolved with their stop response; the end. */
  private stopSequence(session: MachineSession, stoppedBy: 'window' | 'menu_bar' | 'dashboard'): void {
    const resolvedAs = stoppedBy === 'window' ? 'stop' : 'owner_stop';
    // A turn waiting for a reopen is dropped (R5); site asks aren't Codex's and outlive the turn (`_resolve_all`).
    if (session.reopening) session.reopening.queued = null;
    const open = [...session.open.values()].filter((request) => request.kind !== 'site').map((request) => request.id);
    for (const id of open) {
      session.open.delete(id);
      session.resolvedBy.set(id, resolvedAs);
    }
    session.state = 'stopping';
    this.sync(session);
    session.stream.emit('session.state', { state: 'stopping', stopped_by: stoppedBy, processes: { confirmed_gone: false, leftover: [] } });
    for (const id of open) session.stream.emit('request.resolved', { request_id: id, by: resolvedAs, decision_kind: 'stop' });
    setTimeout(() => this.endStoppedTurn(session, stoppedBy), this.stepMs);
  }

  private endStoppedTurn(session: MachineSession, stoppedBy: string): void {
    const leftover = session.leftoverOnStop;
    const turnId = session.activeTurn ?? randomUUID();
    session.stream.emit('turn.completed', { turn_id: turnId, status: 'interrupted', processes_confirmed_gone: leftover.length === 0 });
    session.activeTurn = null;
    if (leftover.length === 0) return this.toStopped(session, stoppedBy);
    session.state = 'leftover';
    this.sync(session);
    session.stream.emit('session.state', { state: 'leftover', stopped_by: stoppedBy, processes: { confirmed_gone: false, leftover } });
  }

  private toStopped(session: MachineSession, stoppedBy: string | undefined): void {
    session.state = 'stopped';
    session.settleNeeded = true;
    this.sync(session);
    const by = stoppedBy ? { stopped_by: stoppedBy } : {};
    session.stream.emit('session.state', { state: 'stopped', ...by, processes: { confirmed_gone: true, leftover: [] } });
  }

  private answerRequest(session: MachineSession, requestId: string, body: unknown, headers: IncomingHttpHeaders): FakeAnswer {
    // Stopping comes first: after a stop, no answer reaches Codex, whatever it was (design §5.3).
    if (STOPPING.has(session.state)) return fixtureAnswer(ANSWER, 'stopping: a late answer never starts a step');
    const by = session.resolvedBy.get(requestId);
    if (by) return errorAnswer(409, 'REQUEST_ALREADY_RESOLVED', undefined, { by });
    const request = session.open.get(requestId);
    if (!request) return fixtureAnswer(ANSWER, 'an unknown request');
    const kind = (body as { decision?: { kind?: string } }).decision?.kind ?? '';
    if (!request.allowed_decisions.includes(kind as DecisionKind)) {
      return errorAnswer(422, 'DECISION_NOT_ALLOWED', undefined, { allowed_decisions: request.allowed_decisions });
    }
    this.resolveRequest(session, requestId, kind, headers);
    return { status: 200, body: { resolved: true, decision_kind: kind } };
  }

  private resolveRequest(session: MachineSession, requestId: string, kind: string, headers: IncomingHttpHeaders): void {
    const request = session.open.get(requestId);
    const host = request?.payload.host;
    // RAVIS adds the site to Codex's list, says so, and only then resolves the ask (`_decide_site`).
    if (kind === 'allow_site') session.stream.emit('site.allowed', { request_id: requestId, host });
    session.open.delete(requestId);
    session.resolvedBy.set(requestId, 'window');
    const key = headers['idempotency-key'];
    session.answers.push({ requestId, decision: kind, key: typeof key === 'string' ? key : undefined });
    const codexStillAsks = [...session.open.values()].some((open) => open.kind !== 'site');
    if (!codexStillAsks && session.state === 'waiting_on_you') session.state = 'running';
    this.sync(session);
    session.stream.emit('request.resolved', { request_id: requestId, by: 'window', decision_kind: kind });
    if (request?.kind !== 'site') return;
    // Then, as `_decide_site` goes on (R5): an allowed site reopens a loaded thread, and a waiting group may open.
    if (kind === 'allow_site') this.siteAllowed(session, String(host), request.group_id ?? '');
    this.openWaitingSites(session);
  }

  private presence(session: MachineSession, body: unknown): FakeAnswer {
    session.presence.push(body as MachineSession['presence'][number]);
    return { status: 204 };
  }

  private claimSettle(session: MachineSession, body: unknown): FakeAnswer {
    const window = String((body as { window_id?: unknown }).window_id ?? '');
    session.claimsBy.push(window);
    const refusal = this.claimRefusal(session, window);
    if (refusal) return refusal;
    this.counter++;
    session.claim ??= { id: `FIXTURE-settle-claim-${this.counter}`, window };
    this.sync(session);
    return { status: 200, body: { claim_id: session.claim.id, expires_at: '2026-09-13T01:59:00Z' } };
  }

  private claimRefusal(session: MachineSession, window: string): FakeAnswer | undefined {
    if (session.superseded) return fixtureAnswer(CLAIM, "RAVIS's lock was superseded at a restart");
    if (session.state === 'leftover') return fixtureAnswer(CLAIM, 'processes not confirmed gone');
    if (!session.settleNeeded) return fixtureAnswer(CLAIM, 'nothing to settle');
    if (!session.claim || session.claim.window === window) return undefined;
    return errorAnswer(409, 'SETTLE_CLAIMED', undefined, { window: session.claim.window });
  }

  private settle(session: MachineSession, body: unknown): FakeAnswer {
    const settle = body as { claim_id?: string; commit?: string; next?: string };
    if (!session.claim || settle.claim_id !== session.claim.id) return fixtureAnswer(SETTLE, "a claim that isn't the current one");
    session.settles.push({ claim_id: settle.claim_id, commit: String(settle.commit), next: String(settle.next) });
    // A settle skips a reopen's resume, never its wait: the next turn resumes the thread (R5).
    if (session.reopening) session.reopening.resume = false;
    session.state = 'idle';
    session.settleNeeded = false;
    session.claim = null;
    session.holdsLock = false;
    this.host.locks()?.sessionSettled(session.id, String(settle.next));
    this.sync(session);
    session.stream.emit('session.state', { state: 'idle', processes: { confirmed_gone: true, leftover: [] } });
    return { status: 200, body: session.stream.view() };
  }

  private stopLeftover(session: MachineSession): FakeAnswer {
    if (session.state !== 'leftover') return fixtureAnswer(LEFTOVER, 'nothing left over');
    this.processesGone(session);
    return { status: 200, body: { processes_confirmed_gone: true } };
  }

  /** The lock a session's view names: the lock machine's row once it is on, the fixture lock otherwise. */
  private lockView(session: MachineSession): { id: string; state: string } | null {
    const row = this.host.locks()?.rowForSession(session.id);
    if (row) return { id: row.id, state: session.superseded ? 'superseded' : row.state };
    return session.holdsLock ? { id: MACHINE_LOCK_ID, state: session.superseded ? 'superseded' : 'running' } : null;
  }

  /** Keeps the session's view — what `GET …/{sid}` and a snapshot show — in step with the machine. */
  private sync(session: MachineSession): void {
    const view = session.stream.view();
    session.stream.patchView({
      state: session.state,
      workspace: { root: session.root, name: path.basename(session.root) },
      clarvis_task_id: session.taskId,
      codex: {
        ...(view.codex as Record<string, unknown>),
        active_turn_id: session.activeTurn,
        model: session.model,
        effort: session.effort,
        reopening: session.reopening && { group_id: session.reopening.groupId, hosts: session.reopening.hosts, since: session.reopening.since },
      },
      pending_requests: [...session.open.values()],
      lock: this.lockView(session),
      settle: { needed: session.settleNeeded, claimed_by: session.claim?.window ?? null },
    });
  }
}
