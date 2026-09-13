/**
 * The shapes RAVIS's agent-session relay and project-lock API send and take (plan.md M15, C1).
 *
 * **Where they come from.** RAVIS owns the contract: `RAVIS.md` §15.1.2 lists the routes, and the
 * fixtures copied into `src/test/fixtures/relay-contract/` fix every request, response and error.
 * Nothing here is guessed from what would be convenient for Clarvis — a field that is not in the
 * fixtures is not here, and `FakeRavisRelay`'s contract check fails any response that adds one.
 *
 * **Types only.** Nothing in this file checks a value at runtime. The relay client does the few
 * checks it relies on (`relayClient.ts`), and the tests hold whole bodies to the fixtures.
 *
 * Field names keep RAVIS's snake_case on purpose: these objects go over the wire unchanged, and a
 * renaming layer would be one more place for a field to be dropped silently.
 */

/** Which editor a window is: the browser editor (code-server) or desktop VS Code. */
export type Host = 'desktop' | 'code-server';

/** Clarvis's modes as RAVIS takes them; RAVIS maps each to Codex's approval settings. */
export type SessionMode = 'agent' | 'auto' | 'unattended';

/** A session's state (`agent-sessions.json` session_states). */
export type SessionState =
  | 'starting'
  | 'running'
  | 'waiting_on_you'
  | 'stopping'
  | 'stopped'
  | 'leftover'
  | 'paused_unanswered'
  | 'paused_for_update'
  | 'completed_needs_review'
  | 'idle'
  | 'uncertain'
  | 'failed'
  | 'ended';

/** What Codex is asking for. */
export type RequestKind = 'command' | 'fileChange' | 'permissions' | 'question';

/** How a window may answer a request. RAVIS lists the allowed ones per request. */
export type DecisionKind = 'once' | 'skip' | 'stop' | 'answer';

/** Why a new turn starts: an ordinary continue, "carry on" after the step cap, or a catch-up after a switch. */
export type TurnKind = 'continue' | 'carry_on' | 'catch_up';

/** Why a window stops a turn. */
export type InterruptReason = 'stop' | 'switch' | 'scope_change';

/** What becomes of a session once its work is saved. */
export type SettleNext = 'idle' | 'end' | 'transfer';

/** Who holds a project lock: a Codex session in RAVIS, or a run of Clarvis's own engine in a window. */
export type HolderKind = 'codex_session' | 'clarvis_run';

/**
 * What `GET /api/v1/codex` says, as far as starting a task needs it (`codex-state.json`). The body has
 * much more — usage, runs, models, sign-in — which the menu bar and the dashboard read; Clarvis doesn't.
 */
export interface CodexState {
  state: string;
  reason: string;
  runtime: { verdict?: string; strict_rules?: string; running_sha256?: string; process?: { state?: string } };
  /** The Codex home RAVIS runs on: a thread can be resumed only in the home it lives in (C3). */
  home?: { fingerprint?: string };
  /** Whether Codex is signed in to the account the owner confirmed (C3: a resume needs it). */
  account?: { fingerprint_matches?: boolean } | null;
}

/** A request Codex opened, as RAVIS relays it (`RequestView`). */
export interface RequestView {
  id: string;
  kind: RequestKind;
  turn_id: string;
  item_id: string;
  opened_at: string;
  /** Differs per kind (`agent-sessions.json` request_kinds); rendering it is C2b's job. */
  payload: Record<string, unknown>;
  /** Computed by RAVIS, so no client can grant more than it offers. */
  allowed_decisions: DecisionKind[];
}

/** One session, as its token holder sees it (`SessionView`). */
export interface SessionView {
  id: string;
  state: SessionState;
  workspace: { root: string; name: string };
  clarvis_task_id: string;
  mode: SessionMode;
  file_rules: string;
  codex: {
    thread_id: string;
    active_turn_id: string | null;
    model: string;
    runtime_sha256: string;
  };
  branch: { name: string; head_commit_at_start: string };
  pending_requests: RequestView[];
  queued_feedback: number;
  attached_windows: { id: string; host: string; since: string }[];
  processes: {
    attributed: number;
    confirmed_gone: boolean;
    leftover: { pid: number; comm: string; started_at: string }[];
  };
  /** Null once a settle released it (the fixtures' settled view). */
  lock: { id: string; state: string } | null;
  settle: { needed: boolean; claimed_by: string | null };
  created_at: string;
  updated_at: string;
  /** The stream cursor this view is current up to: reconnect with `?after=` this after a snapshot. */
  last_event_id: number;
}

/** One row of a workspace's session list: no token, no payloads. */
export interface SessionSummary {
  id: string;
  state: SessionState;
  clarvis_task_id: string;
  created_at: string;
  updated_at: string;
  waiting_on_you: boolean;
  /** A count here, not the list `SessionView` carries. */
  attached_windows: number;
}

/** The body of `POST /api/v1/agent-sessions`. It carries no sandbox or approval settings: RAVIS derives those. */
export interface CreateSessionBody {
  workspace_root: string;
  clarvis_task_id: string;
  window: { id: string; host: Host };
  mode: SessionMode;
  model: string;
  branch: { name: string; head_commit: string };
  git_dir: string;
  start: { kind: 'brief'; text: string } | { kind: 'resume'; thread_id: string; catch_up_text: string };
  lock: { transfer_token: string | null };
  limits: { max_steps: number };
}

/** What creating a session returns. The token comes back this once (and from a reissue). */
export interface CreatedSession {
  session: SessionView;
  session_token: string;
  events_url: string;
}

/** A window's answer to a request. */
export interface Decision {
  kind: DecisionKind;
  text?: string;
  /** A question's answers by question id (`{"q1": "Yes"}` in the fixtures). */
  answers?: Record<string, string>;
}

/** A project lock (`LockView`). */
export interface LockView {
  id: string;
  workspace: { name: string; root_hash: string };
  holder: {
    kind: HolderKind;
    session_id: string | null;
    window_id: string | null;
    host: string;
    since: string;
  };
  state: 'running' | 'stopping' | 'transferring' | 'leftover' | 'superseded';
  waiting_on_you: boolean;
  heartbeat_age_seconds: number;
  verdict: 'alive' | 'unresponsive' | 'gone';
  taken_over_from: string | null;
}

/** The sandboxed command a Clarvis-engine run has running, so a takeover can stop its whole group. */
export interface RunningCommand {
  pid: number;
  /** Clarvis spawns commands detached, so this equals `pid`. */
  pgid: number;
  start: string;
  comm: string;
}

/** A window taking a project lock for a run of Clarvis's own engine. */
export interface LockHolder {
  kind: 'clarvis_run';
  window_id: string;
  host: Host;
  pid: number;
  /** `ps -o lstart=` of the extension host, for the shared lock rule. */
  pid_start: string;
}

/** The body of `POST /api/v1/project-locks`. */
export interface AcquireLockBody {
  workspace_root: string;
  clarvis_task_id: string;
  holder: LockHolder;
  git_dir: string;
  transfer_token?: string;
  /** True when re-registering a checkout lock file taken while RAVIS was unreachable or restarting. */
  adopt_file_lock?: boolean;
}
