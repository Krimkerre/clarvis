/**
 * Clarvis's client for RAVIS's agent-session relay (plan.md M15, C1; `RAVIS.md` §15.1.2).
 *
 * One method per route a Clarvis window calls. The owner's Stop route (`owner-stop`) is not here: it
 * belongs to the menu bar and the dashboard, and refuses every Clarvis credential.
 *
 * **What each method promises.** Its request is the one the contract fixtures show — the tests send
 * every one through `FakeRavisRelay`, which checks it — and its result is a `RelayOutcome`: the body,
 * typed as the fixtures fix it, or a typed failure (`relayFailure.ts`). A success whose body lacks what
 * the caller will read comes back `malformed`, never as a half-filled value.
 *
 * **Keys.** Routes that need an `Idempotency-Key` take it as an argument, because the key has to
 * outlive the call: make it once per logical attempt (`idempotency.ts`) and pass the same one to every
 * retry. `answer` is the exception: its key is always `<request id>:<window id>`, so it is made here.
 *
 * **Authority.** A session's token goes on every `{sid}` route except `reissue-token`, which proves
 * the workspace root instead. The client credential goes on everything (`relayHttp.ts`).
 *
 * The reconnecting event-stream reader is `sseReader.ts`, built on `openEvents`. vscode-free.
 */

import { anyBody, sendExpecting, shaped, type Guard } from './bodies';
import { answerKey } from './idempotency';
import type { RelayOutcome } from './relayFailure';
import type { CallOptions, RelayHttp, RelayRequest } from './relayHttp';
import type {
  CodexState,
  CreateSessionBody,
  CreatedSession,
  Decision,
  DecisionKind,
  Host,
  InterruptReason,
  SessionMode,
  SessionSummary,
  SessionView,
  SettleNext,
  SitesView,
  SkillFile,
  SkillListing,
  TurnKind,
} from './relayTypes';
import { SESSION_TOKEN_FORMAT } from './tokenStore';

const SESSIONS = '/api/v1/agent-sessions';
/** The sites Codex's commands may reach (R5; `codex-admin.json`). */
const SITES = '/api/v1/codex/sites';
/** The skills switched on for the models that aren't Codex, and the read of one (RAVIS 0.27.0; `skills.json`). */
const SKILLS_FOR_MODELS = '/api/v1/skills/models';

/**
 * How long `GET /api/v1/codex` gets before RAVIS counts as not answering (design §9). RAVIS answers it
 * from memory, so a slow answer means RAVIS is in trouble, not busy.
 */
export const CODEX_STATE_TIMEOUT_MS = 1_500;

export interface TurnRequest {
  text: string;
  kind: TurnKind;
  /** Only on a switch back: takes the project lock with the transfer token, atomically. */
  lock?: { transfer_token: string };
}

export interface SteerRequest {
  text: string;
  expected_turn_id?: string;
}

export interface PresenceReport {
  window_id: string;
  host: Host;
  panel_connected: boolean;
}

export interface SettleRequest {
  claim_id: string;
  commit: string;
  next: SettleNext;
}

export interface EventsRequest {
  windowId: string;
  host: Host;
  /** Sent as `Last-Event-ID`: replay what came after it. */
  lastEventId?: number | null;
  /** Sent as `?after=`: the same, used when reconnecting after an expired cursor. */
  after?: number | null;
}

export interface TurnAccepted {
  turn: { state: string };
}
export interface SteerResult {
  delivered: 'steered' | 'queued';
}
export interface StateChange {
  state: string;
}
export interface Answered {
  resolved: boolean;
  decision_kind: DecisionKind;
}
export interface ModeChanged {
  mode: SessionMode;
  applies_from: string;
}
export interface LeftoverResult {
  processes_confirmed_gone: boolean;
}
export interface SettleClaim {
  claim_id: string;
  expires_at: string;
}
export interface Cancelled {
  state: string;
  end_after_settle: boolean;
}
export interface ReissuedToken {
  session_token: string;
}
export interface Transcript {
  turns: unknown[];
}

export class RelayClient {
  constructor(readonly http: RelayHttp) {}

  /** Codex's state on this Mac: whether a task may start at all (C2a; design §5.1 step 1). */
  codexState(options: CallOptions = { timeoutMs: CODEX_STATE_TIMEOUT_MS }): Promise<RelayOutcome<CodexState>> {
    const guard = shaped({ state: 'string', reason: 'string', runtime: 'object' });
    return this.call({ method: 'GET', path: '/api/v1/codex' }, guard, options);
  }

  /** RAVIS's default sites and the ones the owner added (R5), read before a task starts. */
  codexSites(options?: CallOptions): Promise<RelayOutcome<SitesView>> {
    return this.call({ method: 'GET', path: SITES }, isSitesView, options);
  }

  /**
   * Allows `hosts` — at most 20 — for every Codex task from now on (R5): the owner's "Allow and start". RAVIS checks
   * every host before it writes any (`422 SITES_REFUSED` names the ones it won't take), and allowing a host twice
   * changes nothing, so a retry needs no key.
   */
  allowSites(hosts: string[], options?: CallOptions): Promise<RelayOutcome<SitesView>> {
    return this.call({ method: 'POST', path: SITES, body: { hosts } }, isSitesView, options);
  }

  /**
   * The skills the owner switched on for the models that aren't Codex, the NERVIS folder's first (plan.md §4.6, "Skills").
   * RAVIS reads the folders and the switches on every call, so a run of Clarvis's own engine reads this at its start
   * rather than keeping it. A list with an entry lacking an id, a name or a description is `malformed`, never half a list.
   */
  async skillsForModels(options?: CallOptions): Promise<RelayOutcome<SkillListing[]>> {
    const outcome = await this.call<{ skills: SkillListing[] }>({ method: 'GET', path: SKILLS_FOR_MODELS }, isSkillsList, options);
    return outcome.ok ? { ...outcome, value: outcome.value.skills } : outcome;
  }

  /** A switched-on skill's `SKILL.md`, or `file` inside its folder. A refusal keeps RAVIS's code and reason. */
  readSkill(skill: string, file?: string, options?: CallOptions): Promise<RelayOutcome<SkillFile>> {
    const request: RelayRequest = { method: 'GET', path: `${SKILLS_FOR_MODELS}/read`, query: { skill, file } };
    return this.call(request, isSkillFile, options);
  }

  /** Starts a task. `key` is `createSessionKey(taskId, windowId, attempt)`. */
  createSession(body: CreateSessionBody, key: string, options?: CallOptions): Promise<RelayOutcome<CreatedSession>> {
    return this.call({ method: 'POST', path: SESSIONS, body, idempotencyKey: key }, isCreatedSession, options);
  }

  /** The workspace's sessions, without tokens or payloads. */
  async listSessions(workspaceRoot: string, options?: CallOptions): Promise<RelayOutcome<SessionSummary[]>> {
    const request: RelayRequest = { method: 'GET', path: SESSIONS, query: { workspace_root: workspaceRoot } };
    const outcome = await this.call<{ items: SessionSummary[] }>(request, shaped({ items: 'array' }), options);
    return outcome.ok ? { ...outcome, value: outcome.value.items } : outcome;
  }

  /** The session with its open requests; also the snapshot a reader takes after an expired cursor. */
  getSession(sessionId: string, token: string, options?: CallOptions): Promise<RelayOutcome<SessionView>> {
    return this.call({ method: 'GET', path: sessionPath(sessionId), token }, isSessionView, options);
  }

  /** Codex's own turns, read through; RAVIS stores none of it. */
  transcript(sessionId: string, token: string, limit = 50, options?: CallOptions): Promise<RelayOutcome<Transcript>> {
    const request: RelayRequest = { method: 'GET', path: `${sessionPath(sessionId)}/transcript`, token, query: { limit } };
    return this.call(request, shaped({ turns: 'array' }), options);
  }

  /** A new turn. Needs the project lock, or takes it with `turn.lock.transfer_token`. */
  startTurn(
    sessionId: string,
    token: string,
    turn: TurnRequest,
    key: string,
    options?: CallOptions
  ): Promise<RelayOutcome<TurnAccepted>> {
    return this.post(sessionId, '/turns', { token, body: turn, idempotencyKey: key }, shaped({ turn: 'object' }), options);
  }

  /** Passes text into the running turn, or has RAVIS queue it for the next one. */
  steer(sessionId: string, token: string, steer: SteerRequest, key: string, options?: CallOptions): Promise<RelayOutcome<SteerResult>> {
    return this.post(sessionId, '/steer', { token, body: steer, idempotencyKey: key }, shaped({ delivered: 'string' }), options);
  }

  /** Stops the turn. Pressing it again is harmless: RAVIS answers 202 each time. */
  interrupt(sessionId: string, token: string, reason: InterruptReason, options?: CallOptions): Promise<RelayOutcome<StateChange>> {
    return this.post(sessionId, '/interrupt', { token, body: { reason } }, shaped({ state: 'string' }), options);
  }

  /** Answers request `requestId` from window `windowId`, with a decision RAVIS offered. */
  answer(
    sessionId: string,
    token: string,
    requestId: string,
    windowId: string,
    decision: Decision,
    options?: CallOptions
  ): Promise<RelayOutcome<Answered>> {
    const path = `/requests/${encodeURIComponent(requestId)}/answer`;
    const parts = { token, body: { decision }, idempotencyKey: answerKey(requestId, windowId) };
    return this.post(sessionId, path, parts, shaped({ resolved: 'boolean', decision_kind: 'string' }), options);
  }

  /** Tells RAVIS whether this window's chat panel is there (`presence.ts` decides when). */
  presence(sessionId: string, token: string, report: PresenceReport, options?: CallOptions): Promise<RelayOutcome<null>> {
    return this.post(sessionId, '/presence', { token, body: report }, anyBody, options);
  }

  /** Changes the mode from the next turn. */
  setMode(sessionId: string, token: string, mode: SessionMode, options?: CallOptions): Promise<RelayOutcome<ModeChanged>> {
    return this.post(sessionId, '/mode', { token, body: { mode } }, shaped({ mode: 'string', applies_from: 'string' }), options);
  }

  /** Asks RAVIS to stop processes the task left behind. */
  stopLeftover(sessionId: string, token: string, options?: CallOptions): Promise<RelayOutcome<LeftoverResult>> {
    const guard = shaped({ processes_confirmed_gone: 'boolean' });
    return this.post(sessionId, '/leftover', { token, body: { action: 'stop_them' } }, guard, options);
  }

  /** Claims the right to save the task's work, so only one window commits. */
  claimSettle(sessionId: string, token: string, windowId: string, options?: CallOptions): Promise<RelayOutcome<SettleClaim>> {
    const guard = shaped({ claim_id: 'string', expires_at: 'string' });
    return this.post(sessionId, '/settle-claim', { token, body: { window_id: windowId } }, guard, options);
  }

  /**
   * Records the settle. Call it only after the commit is made and the checkpoint saved: the body says
   * `checkpoint_saved: true`, and there is no other value to send.
   */
  settle(sessionId: string, token: string, settle: SettleRequest, key: string, options?: CallOptions): Promise<RelayOutcome<SessionView>> {
    const body = { ...settle, checkpoint_saved: true };
    return this.post(sessionId, '/settle', { token, body, idempotencyKey: key }, isSessionView, options);
  }

  /** Stops the task and ends it once its work is settled. */
  cancel(sessionId: string, token: string, options?: CallOptions): Promise<RelayOutcome<Cancelled>> {
    const guard = shaped({ state: 'string', end_after_settle: 'boolean' });
    return this.post(sessionId, '/cancel', { token, body: {} }, guard, options);
  }

  /** Ends a settled session. Codex's thread is kept. */
  end(sessionId: string, token: string, options?: CallOptions): Promise<RelayOutcome<StateChange>> {
    return this.call({ method: 'DELETE', path: sessionPath(sessionId), token }, shaped({ state: 'string' }), options);
  }

  /** A new token for a session whose token file was lost, proven by its workspace root. */
  reissueToken(sessionId: string, workspaceRoot: string, key: string, options?: CallOptions): Promise<RelayOutcome<ReissuedToken>> {
    const parts = { body: { workspace_root: workspaceRoot }, idempotencyKey: key };
    return this.post(sessionId, '/reissue-token', parts, isReissuedToken, options);
  }

  /** Opens the session's event stream once. Reconnecting is `RelayEventStream`'s job. */
  openEvents(sessionId: string, token: string, request: EventsRequest, signal: AbortSignal): Promise<RelayOutcome<Response>> {
    const resume = request.lastEventId === null || request.lastEventId === undefined;
    return this.http.open(
      {
        method: 'GET',
        path: `${sessionPath(sessionId)}/events`,
        token,
        headers: resume ? {} : { 'Last-Event-ID': String(request.lastEventId) },
        query: { window_id: request.windowId, host: request.host, after: request.after },
      },
      signal
    );
  }

  private post<T>(
    sessionId: string,
    suffix: string,
    parts: Omit<RelayRequest, 'method' | 'path'>,
    guard: Guard,
    options?: CallOptions
  ): Promise<RelayOutcome<T>> {
    return this.call({ method: 'POST', path: `${sessionPath(sessionId)}${suffix}`, ...parts }, guard, options);
  }

  private call<T>(request: RelayRequest, guard: Guard, options?: CallOptions): Promise<RelayOutcome<T>> {
    return sendExpecting<T>(this.http, request, guard, options);
  }
}

function sessionPath(sessionId: string): string {
  return `${SESSIONS}/${encodeURIComponent(sessionId)}`;
}

const isSessionView = shaped({ id: 'string', state: 'string', pending_requests: 'array', last_event_id: 'number' });
const isSitesView = shaped({ defaults: 'array', added: 'array' });

function isCreatedSession(value: unknown): boolean {
  if (!shaped({ session: 'object', session_token: 'string', events_url: 'string' })(value)) return false;
  const created = value as { session: unknown; session_token: string };
  return isSessionView(created.session) && SESSION_TOKEN_FORMAT.test(created.session_token);
}

function isReissuedToken(value: unknown): boolean {
  return shaped({ session_token: 'string' })(value) && SESSION_TOKEN_FORMAT.test((value as ReissuedToken).session_token);
}

const isSkillListing = shaped({ id: 'string', name: 'string', description: 'string' });
const isSkillFile = shaped({ skill: 'string', name: 'string', file: 'string', bytes: 'number', text: 'string' });

/** A list whose every entry carries what a run's instructions name. */
function isSkillsList(value: unknown): boolean {
  return shaped({ skills: 'array' })(value) && (value as { skills: unknown[] }).skills.every(isSkillListing);
}
