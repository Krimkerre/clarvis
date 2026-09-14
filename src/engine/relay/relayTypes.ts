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

/**
 * What a request asks for. The first four are Codex's own; `site` is RAVIS's: a site Codex's network
 * proxy blocked a command from reaching, asked of the owner (`agent-sessions.json` request_kinds).
 */
export type RequestKind = 'command' | 'fileChange' | 'permissions' | 'question' | 'site';

/**
 * How a window may answer a request. RAVIS lists the allowed ones per request: `once`, `skip` and `stop`
 * for an approval, `answer` and `stop` for a question, `allow_site` and `keep_blocked` for a site.
 */
export type DecisionKind = 'once' | 'skip' | 'stop' | 'answer' | 'allow_site' | 'keep_blocked';

/** Why a new turn starts: an ordinary continue, "carry on" after the step cap, or a catch-up after a switch. */
export type TurnKind = 'continue' | 'carry_on' | 'catch_up';

/** Why a window stops a turn. */
export type InterruptReason = 'stop' | 'switch' | 'scope_change';

/** What becomes of a session once its work is saved. */
export type SettleNext = 'idle' | 'end' | 'transfer';

/** Who holds a project lock: a Codex session in RAVIS, or a run of Clarvis's own engine in a window. */
export type HolderKind = 'codex_session' | 'clarvis_run';

/**
 * What `GET /api/v1/codex` says, as far as Clarvis needs it (`codex-state.json`): whether a task may start,
 * and which Codex models the owner may choose from. The body has much more — usage, runs, sign-in — which
 * the menu bar and the dashboard read; Clarvis doesn't.
 */
export interface CodexState {
  state: string;
  reason: string;
  runtime: { verdict?: string; strict_rules?: string; running_sha256?: string; process?: { state?: string } };
  /** The Codex home RAVIS runs on: a thread can be resumed only in the home it lives in (C3). */
  home?: { fingerprint?: string };
  /** Whether Codex is signed in to the account the owner confirmed (C3: a resume needs it). */
  account?: { fingerprint_matches?: boolean } | null;
  /** The models Codex offers this account, from Codex's `model/list`. Empty while signed out. */
  models?: CodexModel[];
  /** The ChatGPT plan's allowance, as Codex last reported it: never money, and never 0 when unknown. */
  usage?: CodexUsage;
}

/** `GET /api/v1/codex` → `usage` (`codex-state.json` usage_rules). */
export interface CodexUsage {
  /** False until Codex has reported: then `windows` is empty and there are no percentages. */
  known: boolean;
  /** True after 30 minutes without a reading while no turn runs. */
  stale: boolean;
  observed_at: string | null;
  /** Codex's `rateLimitReachedType`: non-null once a limit is reached. */
  limit_reached: unknown;
  spend_control_reached: boolean | null;
  windows: CodexUsageWindow[];
}

/** One allowance window: the five-hour one, the weekly one. */
export interface CodexUsageWindow {
  id: string;
  /** From the window's length, e.g. "5-hour window". */
  label: string;
  duration_minutes: number;
  used_percent: number;
  remaining_percent: number;
  resets_at: string;
}

/** One Codex model and the efforts it takes (`codex-state.json` → `models`). */
export interface CodexModel {
  id: string;
  display_name: string;
  is_default: boolean;
  /** The effort this model uses when none is chosen. */
  default_effort: string;
  /** How hard it may think, e.g. `low`, `medium`, `high`: the levels Codex lists for this model. */
  efforts: string[];
}

/** A request Codex opened, as RAVIS relays it (`RequestView`). */
export interface RequestView {
  id: string;
  kind: RequestKind;
  turn_id: string;
  /** A site ask's group (R5): the asks one turn opened share it, and a group's asks are open together. */
  group_id?: string;
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
    /** The effort the task runs at, fixed for its life (R5); null when it is the model's default. */
    effort?: string | null;
    runtime_sha256: string;
    /** While RAVIS reopens Codex's thread so newly allowed sites reach it (R5); null otherwise. */
    reopening?: CodexReopening | null;
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

/** `SessionView` → `codex.reopening` (R5; `agent-sessions.json` → `reopening`): which sites, and since when. */
export interface CodexReopening {
  group_id: string | null;
  hosts: string[];
  since: string;
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
  /** Empty lets Codex choose: its default model. */
  model: string;
  /** How hard the model thinks (R5): one of that model's efforts; absent for the model's default. */
  effort?: string;
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

/** `GET` and `POST /api/v1/codex/sites` (R5; `codex-admin.json`): the sites Codex's commands may reach. */
export interface SitesView {
  /** RAVIS's own list, in its order; its wildcard entries are the owner's. */
  defaults: string[];
  /** Every other site Codex allows, sorted: the ones the owner added. */
  added: string[];
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
