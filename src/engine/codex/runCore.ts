/**
 * A Codex task RAVIS runs, followed from this window (plan.md M15, C2a; design §5.1–§5.7, §9).
 *
 * **What this is.** RAVIS runs Codex on this Mac and relays everything about a task — the messages
 * Codex writes, the commands it ran, the files it changed, the questions it asks — as an event stream,
 * and takes a window's answers, steers and Stop as plain POSTs. This core turns that into a coding run
 * the chat already knows how to show: the `AgentEvent`s Clarvis's own engine produces, the same result,
 * the same Stop. It is vscode-free and is handed its relay client, token file, cursor store, git and
 * asker, so all of it runs under `node --test` against `FakeRavisRelay`. `RemoteCodexRunner.ts` is the
 * glue that hands it the real ones.
 *
 * **Two ways in.** `start` is a new task: it asks RAVIS whether Codex may run before touching anything,
 * makes the branch, creates the session with a key that makes a retried create harmless, and keeps the
 * session's token in the token file so another window can follow it. `attach` follows a session that
 * another window — or this one, before a reload — started, from the cursor this host stored or from a
 * snapshot. Both then run the same loop.
 *
 * **The loop never waits on a person.** The stream is read continuously. A question goes to the asker
 * and the reading carries on; a reader that stopped to wait would trip the stream's 45-second silence
 * check (C1's note). Answers, steers, the stop and the settle each finish in their own time and report
 * through the event channel.
 *
 * **The guards, each with a test that fails without it** (`runCore.test.ts`):
 * - Stop lets go of every question in the same tick, before any request is made, then interrupts. An
 *   answer that comes back after Stop, after RAVIS said the task is stopping, or after the request was
 *   resolved elsewhere is dropped (`engineDecisionAfterAsking`): a late click never starts a step.
 * - Typed text is steered into a running turn, or kept (`FeedbackQueue`) and delivered once the task can
 *   take it. Never dropped.
 * - A completed item is recorded once (`CodexLedger`) however often it arrives, and nothing Codex did
 *   is done again here.
 * - Codex's requests are asked once each however often they are replayed, one at a time, and answered only with
 *   what RAVIS allows, checked again right before the answer is sent (`approvals.ts`, C2b).
 * - Work is committed only by the window holding RAVIS's settle claim, and never once RAVIS says the
 *   project lock was superseded — the fence, for a Codex task. The one way past it: the editor that held
 *   the checkout when RAVIS restarted has closed (`gone` by the shared lock rule). Then this window stops
 *   what that editor left running, takes the checkout lock file, registers it with RAVIS as an adoption,
 *   and only then claims, saves and settles — letting the lock go once the run is over (final check F-A9).
 * - "Carry on" after RAVIS's step cap is a new `carry_on` turn on the same session, followed like the
 *   first, never a new task on a new branch (design §5.5).
 * - Before a start, the sites the task will likely need are asked about once, and Cancel starts nothing; a model and
 *   effort the owner chose are held to what Codex lists (C2b+, R5).
 * - After blocked sites the task carries on (`carry_on`) only from the window whose answer decided the group's last
 *   host, only once its work is saved and no turn runs, and never after a Stop; RAVIS holds that turn until Codex's
 *   thread is reopened (R5).
 * - A panel that stops pinging is reported detached and its stream closed; when it pings again, presence
 *   is posted at once and the stream reopens from its cursor (review AH2, final check F-A8).
 */

import { randomUUID } from 'crypto';
import type { AgentEvent } from '../../agent/AgentRunner';
import type { CheckpointStatus, CodexThreadRef, OpenQuestion, TaskCheckpoint, UncertainOperation } from '../checkpoint/taskCheckpoint';
import type { LockClient } from '../lock/lockClient';
import { codexReadiness } from '../relay/codexReadiness';
import { createSessionKey, freshKey, switchCreateKey } from '../relay/idempotency';
import type { CodexStart } from '../transfer/transferState';
import { PresenceTracker, type PresenceAction } from '../relay/presence';
import type { RelayClient, TurnRequest } from '../relay/relayClient';
import type { RelayFailure, RelayOutcome } from '../relay/relayFailure';
import { abortableSleep, type Sleep } from '../relay/relayHttp';
import type {
  CodexState,
  CreateSessionBody,
  Decision,
  Host,
  SessionMode,
  SessionSummary,
  SessionView,
  TurnKind,
} from '../relay/relayTypes';
import { RECONNECT_BACKOFF_MS, RelayEventStream, SILENCE_LIMIT_MS, type StreamItem } from '../relay/sseReader';
import type { TokenRead } from '../relay/tokenStore';
import { effectiveCodexChoice, type StoredCodexChoice } from '../codexChoice';
import { CodexApprovals, type PromptShower, type SitesDecided } from './approvals';
import { EventChannel } from './eventChannel';
import { FeedbackQueue, type FeedbackEntry } from './feedback';
import { CodexLedger, type CheckRun } from './ledger';
import {
  carryOnText,
  MOST_SITES,
  preTaskAsk,
  preTaskChoice,
  refusedSites,
  SITE_LINES,
  siteDecisionsLine,
  sitesAllowedLine,
  sitesNotAddedLine,
  sitesNotAllowedLine,
  sitesRefusedLine,
  type PreTaskChoice,
} from './siteAsks';
import { notYetAllowed, type FoundSite } from './siteScan';
import {
  buildOnGoneLine,
  CODEX_LINES,
  codexModelLine,
  failureLine,
  feedbackLine,
  leftoverLine,
  modelFellBackLine,
  modeNotChangedLine,
  reattachedLine,
  refusalCode,
  requestSummary,
  settleStateLine,
  steerRefusedLine,
  stoppedByLine,
  switchStartLine,
  tokenLine,
  turnEndLine,
} from './translate';

/** The token file, as far as the runner uses it (`tokenStore.ts`). */
export interface CodexTokens {
  save(workspaceRoot: string, sessionId: string, token: string, taskId: string): void;
  read(workspaceRoot: string, sessionId: string): TokenRead;
}

/** The last event id this host saw per session, so a reload resumes rather than replays (C1's note). */
export interface CodexCursors {
  get(sessionId: string): number | null;
  set(sessionId: string, eventId: number): void;
}

export type CodexBranch =
  | { ok: true; branch: string; headCommit: string }
  /** `gitSetup`: only setting git up in the folder is missing, so the chat may offer to (plan.md M15, "Codex offers to set git up"). */
  | { ok: false; line: string; gitSetup?: boolean };
export type CodexSave = { ok: true; commit: string; committed: boolean; files: string[] } | { ok: false; line: string };

/** Git, which only Clarvis runs: RAVIS never does (design §3.5.3 "Settle"). */
export interface CodexGit {
  /** The checkpoint and the task branch, before the session exists (design §5.1 step 2). */
  begin(task: string): Promise<CodexBranch>;
  /**
   * A task switched to Codex (C3; review B2): its existing branch, checked out at the commit the other engine saved
   * or a descendant of it — never a new branch beside that work. Refused, with a line, otherwise.
   *
   * Also **Build on** (plan.md M15): the branch Codex's earlier task left, at the tip it had when the owner was asked.
   * `task` is then the new request, which the commit and the undo snapshot name.
   */
  continueOn(branch: string, headCommit: string, task?: string): Promise<CodexBranch>;
  /**
   * Commits Codex's work on the task branch at settle; `commit` is the tip the session settles at.
   * `branch` is the session's branch, so a window that didn't make it can check it stands on it.
   * `forSwitch` marks work stopped to hand the task to Clarvis's own engine.
   */
  save(work: { summary: string; stopped: boolean; files: string[]; branch: string | undefined; forSwitch?: boolean }): Promise<CodexSave>;
  /** Tidies a branch made for a session RAVIS then refused. */
  abandon(): Promise<void>;
}

/** A checkout lock this window took over, let go of once the run is over. */
export interface AdoptedCheckout {
  release(): Promise<unknown>;
}

/**
 * The checkout lock file, for a Codex task RAVIS paused because another editor held the checkout when
 * RAVIS restarted (design §5.7 step 6, §6.3's restart adoption rule; final check F-A9).
 */
export interface CodexLockFloor {
  /**
   * Takes the checkout from that editor when it is `gone` — after stopping what it had running — and
   * registers it with RAVIS with `adopt_file_lock`. A refusal when it is still there, or couldn't be judged.
   */
  takeFromGoneEditor(taskId: string): Promise<AdoptedCheckout | { refusal: string }>;
}

/** What a settle knows, for the checkpoint (C3; design §6.1). The glue turns it into the file. */
export interface CodexSettleFacts {
  taskId: string;
  session: CodexThreadRef;
  branch: string | undefined;
  headCommit: string;
  changedFiles: string[];
  checks: CheckRun[];
  /** Everything typed for the task, with whether Codex took it in. */
  feedback: FeedbackEntry[];
  unanswered: OpenQuestion[];
  uncertain: UncertainOperation[];
  status: CheckpointStatus;
}

/** Writes the checkpoint at a settle, before the settle says it did (`checkpoint_saved: true`). */
export interface CodexCheckpointPort {
  /** False: not written — and then nothing is settled. */
  save(facts: CodexSettleFacts): Promise<boolean>;
}

export type SwitchResult<T> = { ok: true; value: T } | { ok: false; line: string };

/** Codex's earlier task, idle on its own branch, that a new request builds on (plan.md M15; `leftTasks.ts`). */
export interface BuildOnTask {
  sessionId: string;
  branch: string;
  /** The branch's tip when the owner was asked: the branch must still contain it. */
  tip: string;
}

/** RAVIS's word on a stop for a switch: every process confirmed gone, what is left, or that it couldn't be told. */
export type SwitchConfirmation = { gone: true } | { gone: false; leftover: string } | { gone: undefined; line: string };

/** Clarvis's own engine → Codex: what Codex starts from (design §6.2 step 6). */
export interface SwitchIntoCodex {
  checkpoint: TaskCheckpoint;
  /** Absent for a task that stopped: nothing holds the project, and Codex takes it as a new task does. */
  transferToken?: string;
  start: CodexStart;
  /** The task and its rendered checkpoint, for a fresh start. */
  brief: string;
  /** The catch-up, for the task's idle session or its resumed thread. */
  catchUp: string;
}

export interface CodexTiming {
  streamBackoffMs: readonly number[];
  silenceLimitMs: number;
  /** For creates, steers, turns and settles: resent with the same key after RAVIS didn't answer. */
  retry: { attempts: number; delayMs: number };
  /** Design §5.3: every 2 s for up to 10 s. */
  interruptRetry: { attempts: number; delayMs: number };
  /** Design §5.3: then every 5 s, for as long as the window is open. */
  interruptKeepTryingMs: number;
}

export const CODEX_TIMING: CodexTiming = {
  streamBackoffMs: RECONNECT_BACKOFF_MS,
  silenceLimitMs: SILENCE_LIMIT_MS,
  retry: { attempts: 3, delayMs: 2_000 },
  interruptRetry: { attempts: 6, delayMs: 2_000 },
  interruptKeepTryingMs: 5_000,
};

export interface CodexRunOptions {
  relay: RelayClient;
  tokens: CodexTokens;
  cursors: CodexCursors;
  git: CodexGit;
  window: { id: string; host: Host };
  /** `git_dir` is the realpath of `<root>/.git` (design §3.5.1). */
  workspace: { root: string; gitDir: string };
  mode: SessionMode;
  /** The chat's mode as it is now, for Unattended's own answers (C2b); the mode the task started in when absent. */
  modeNow?: () => SessionMode;
  maxSteps: number;
  /** Puts one of Codex's requests to the owner, as `approvals.ts` renders it. */
  ask: PromptShower;
  /** Copies project files, by relative path, for undo before an approved file change (C2b; design §5.2). */
  capture?: (paths: string[]) => Promise<void>;
  /**
   * The hosts a new task will likely need, found in the project and the brief (C2b+; `siteScan.ts`), asked about once
   * before anything is touched. Absent: nothing is asked before a start.
   */
  sitesFor?: (task: string) => FoundSite[] | Promise<FoundSite[]>;
  /** The Codex model and effort the owner chose in the bowtie menu (C2b+). Absent or empty: Codex's own default. */
  codexChoice?: () => StoredCodexChoice;
  /** Absent: a task RAVIS paused for another editor is only followed from here, never saved. */
  floor?: CodexLockFloor;
  /** RAVIS's lock API: a switch reserves the project for Clarvis's own engine with this session's token (C3). */
  locks?: LockClient;
  /** Writes the checkpoint at every settle (C3). Absent in tests that don't look at it. */
  checkpoint?: CodexCheckpointPort;
  /** Codex's streamed text and command output: the terminal only (design §5.5). */
  terminal?: (text: string) => void;
  log?: (line: string) => void;
  now?: () => Date;
  sleep?: Sleep;
  timing?: Partial<CodexTiming>;
  newTaskId?: () => string;
}

/** States that mean the task's work is waiting to be saved (`agent-sessions.json` session_states). */
const NEEDS_SETTLE = new Set(['stopped', 'completed_needs_review', 'paused_unanswered', 'paused_for_update', 'uncertain']);
/** States a run has nothing more to follow in. */
const ENDED = new Set(['idle', 'ended', 'failed']);
/** States a steer can reach: a turn is running, or about to. */
const STEERABLE = new Set(['starting', 'running', 'waiting_on_you']);
/**
 * How long reading or adding the allowed sites gets before a start goes on without them (C2b+): RAVIS asks Codex each
 * time, and site writes wait for one another, so longer than the state's 1.5 s, and never long enough to stall a start.
 */
const SITES_TIMEOUT_MS = 10_000;

interface Session {
  id: string;
  token: string;
  taskId: string;
  threadId?: string;
}

type Handler = (data: Record<string, unknown>) => void | Promise<void>;

/** How the ask before a start ended: start, cancelled by the owner, or taken away by a Stop. */
type StartChoice = 'start' | 'cancel' | 'stopped';

/** The ask before a start, as it goes (C2b+). */
interface SitesAsking {
  /** The hosts still asked about. */
  found: FoundSite[];
  /** Whether "Allow and start" is still offered: not once allowing has failed. */
  allowOffered: boolean;
  /** Shown again after words that weren't a choice. */
  again: boolean;
  /** Said in front of the question when it is asked again: why allowing didn't go through. */
  before: string;
  /** Said once the ask is over. */
  said: string[];
}

/** A carry-on owed after blocked sites (R5): what the owner decided, and — once sent — the turn and key its retries reuse. */
interface PendingCarryOn {
  allowed: string[];
  kept: string[];
  sent?: { turn: TurnRequest; key: string; delivered: string[] };
}

export class CodexRunCore {
  readonly ledger = new CodexLedger();
  readonly feedback = new FeedbackQueue();
  /** Codex's requests in this window: asked one at a time, answered with what RAVIS allows (C2b). */
  readonly approvals: CodexApprovals;
  /** Set when a start was refused because a Codex session already holds the project: follow that one. */
  attachInstead: string | undefined;

  /** Set when a start was refused for want of git alone, in a folder RAVIS would take: the chat offers Set up git here. */
  private gitSetupWanted = false;

  private readonly channel = new EventChannel<AgentEvent>();
  private readonly presence = new PresenceTracker();
  private readonly disposer = new AbortController();
  private readonly timing: CodexTiming;
  private readonly commits: string[] = [];
  private readonly savedFiles: string[] = [];
  private readonly said = new Set<string>();
  private session: Session | undefined;
  private branchName: string | undefined;
  private state: string | undefined;
  private activeTurn: string | null = null;
  private cursor: number | null = null;
  private stream: RelayEventStream | undefined;
  private connected = false;
  private attached = true;
  private whenAttached: (() => void) | undefined;
  private dropsInARow = 0;
  private stopRequested = false;
  private ravisStopping = false;
  private superseded = false;
  private claimedElsewhere = false;
  /** RAVIS said the task's work was waiting to be saved. */
  private workWaited = false;
  /** This window committed it. */
  private savedHere = false;
  private settling = false;
  private delivering = false;
  private finished = false;
  private failed = false;
  /** The last turn ended at RAVIS's step cap, so "carry on" continues this session. */
  private stepCap = false;
  /** F-A9's adoption is tried once per run. */
  private adoptionTried = false;
  private adopted: AdoptedCheckout | undefined;
  /** A switch to Clarvis's own engine under way (C3): RAVIS's next word on the stop, and the claim once made. */
  private switching: { waiting?: (confirmation: SwitchConfirmation) => void; last?: SwitchConfirmation; claim?: { id: string; commit: string } } | undefined;
  /** The project lock RAVIS keeps for this session, as its views name it. */
  private lockId: string | undefined;
  /** Requests a switch let go: never answered for the other engine (design §6.4). */
  private readonly unanswered: OpenQuestion[] = [];
  private lastTurn: { id?: string; status: CodexThreadRef['lastTurnStatus'] } = { status: 'unknown' };
  /** Clarvis's own engine → Codex: resolved once Codex's first turn begins. */
  private switchStart: { promise: Promise<SwitchResult<void>>; resolve: (result: SwitchResult<void>) => void; done: boolean } | undefined;
  /** What `GET /api/v1/codex` said before the start: the models a chosen model and effort are held to (C2b+). */
  private codexState: CodexState | undefined;
  /** The carry-on this window owes once the site asks it decided can go on (R5). */
  private owedCarryOn: PendingCarryOn | undefined;
  private carryOnSending = false;
  /** RAVIS took the carry-on and hasn't begun its turn yet: the run follows on until it does. */
  private carryOnSent = false;
  /** "Reconnecting Codex…" is showing under the chat (R5). */
  private reconnecting = false;

  private readonly handlers = new Map<string, Handler>([
    ['snapshot', (data) => this.onSnapshot(data as unknown as SessionView)],
    ['session.state', (data) => this.onSessionState(data)],
    ['turn.started', (data) => this.onTurnStarted(data)],
    ['turn.completed', (data) => this.onTurnCompleted(data)],
    ['item.completed', (data) => this.pushAll(this.ledger.record(data.item))],
    ['item.started', (data) => this.ledger.started(data.item)],
    ['agent.delta', (data) => this.terminal(data.text)],
    ['command.output', (data) => this.terminal(data.text)],
    ['request.opened', (data) => this.approvals.open(data.request)],
    ['request.resolved', (data) => this.approvals.resolved(data)],
    // A site ask follows as its own request; the event itself only goes to the log.
    ['site.blocked', (data) => this.log(`codex: a command was blocked from reaching ${String(data.host)}`)],
    ['site.allowed', (data) => this.log(`codex: ${String(data.host)} was added to Codex's allowed sites`)],
    // RAVIS reopens Codex's thread so an allowed site reaches it (R5), as often as it needs to: "Reconnecting Codex…"
    // shows until Codex has let go of the thread, the moment an allowed site works.
    ['site.reopening', (data) => this.onReopening(data)],
    ['site.reopened', () => this.onReopened(false)],
    ['site.reopen_incomplete', () => this.onReopened(true)],
    ['feedback', (data) => this.onFeedback(data)],
    ['model.rerouted', (data) => this.say(`Codex moved from ${String(data.from)} to ${String(data.to)} (${String(data.reason)}).`)],
    ['warning', (data) => this.terminal(`Codex: ${String(data.message)}\n`)],
    ['lock.changed', (data) => this.onLockChanged(data)],
    ['session.ended', () => this.finishWith(this.closingEvent())],
  ]);

  constructor(private readonly options: CodexRunOptions) {
    this.timing = { ...CODEX_TIMING, ...options.timing };
    this.approvals = new CodexApprovals({
      answer: (requestId, decision) => this.answerRequest(requestId, decision),
      show: (prompt, signal, again) => this.options.ask(prompt, signal, again),
      steer: (text) => this.interject(text),
      stopRun: () => this.stop(),
      stopping: () => this.isStopping(),
      mode: () => this.options.modeNow?.() ?? this.options.mode,
      attached: () => this.presence.panelConnected,
      capture: options.capture,
      say: (line) => this.say(line),
      log: (line) => this.log(line),
      sitesDecided: (decided) => this.sitesDecided(decided),
    });
  }

  /**
   * A new task: refused before anything is touched unless Codex may run (design §5.1), the sites it will likely need
   * asked about first (C2b+), then the branch, the session, and the run followed.
   */
  async *start(task: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const said: string[] = [];
    const notStarted = await this.beforeStart(task, signal, said);
    for (const line of said) yield { kind: 'text', text: line, toChat: true };
    const ended = notStarted ?? (await this.branchAndCreate(task, signal));
    if (ended) {
      yield ended;
      return;
    }
    yield* this.follow(signal, null);
  }

  /** A task another window started, or this one before a reload (design §5.7). */
  async *attach(summary: SessionSummary, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const read = this.options.tokens.read(this.options.workspace.root, summary.id);
    if (read.kind !== 'found') {
      yield this.failure(tokenLine(read));
      return;
    }
    this.session = { id: summary.id, token: read.entry.token, taskId: read.entry.taskId };
    this.state = summary.state;
    yield { kind: 'text', text: reattachedLine(summary), toChat: true };
    yield* this.follow(signal, this.options.cursors.get(summary.id));
  }

  /**
   * "Carry on" after the step cap (design §5.5): a `carry_on` turn on the same session, then followed as
   * before. A turn RAVIS says is already running got the text as a steer instead, and is followed all the same.
   */
  async *carryOn(sessionId: string, text: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const started = await this.startCarryOn(sessionId, text);
    if ('line' in started) {
      yield started.failed ? this.failure(started.line) : this.doneEvent(started.line);
      return;
    }
    yield* this.follow(signal, started.cursor);
  }

  /**
   * Reads where the session's stream stands, then starts the turn, and follows from that point. Not from this
   * host's stored cursor: the run that ended at the step cap may have closed its stream before RAVIS's `idle`
   * arrived, and replaying that old ending would end this run before its turn began.
   */
  private async startCarryOn(sessionId: string, text: string): Promise<{ cursor: number } | { line: string; failed: boolean }> {
    const read = this.options.tokens.read(this.options.workspace.root, sessionId);
    if (read.kind !== 'found') return { line: tokenLine(read), failed: true };
    this.session = { id: sessionId, token: read.entry.token, taskId: read.entry.taskId };
    const view = await this.options.relay.getSession(sessionId, read.entry.token);
    if (!view.ok) return { line: failureLine(view.failure, 'during'), failed: true };
    this.noteDetails(view.value);
    const refused = await this.continueTurn(text, 'carry_on');
    return refused && refused !== CODEX_LINES.passedOn ? { line: refused, failed: false } : { cursor: view.value.last_event_id };
  }

  // ── Building on Codex's earlier work (plan.md M15; the owner's decision of 15 Sep 2026) ──

  /**
   * **Build on** Codex's earlier work, left on its branch: the idle session picked back up with a `continue` turn that
   * carries the new request, so Codex adds to its own work and keeps the earlier conversation. Never a new session or a
   * new branch.
   *
   * In this order, and nothing changes before the third step:
   * 1. the session's key from the token file, and its view, which must still say `idle` on `left.branch`;
   * 2. the task's mode brought to the chat's mode, refused when RAVIS won't. A task started in Unattended must not go on
   *    answering Codex's requests itself after the owner chose Agent;
   * 3. the window switched to the branch at `left.tip` or after it, refused when the branch moved away;
   * 4. the turn, followed from where the session's stream stood before it, as "Carry on" is.
   *
   * The owner's uncommitted work is checked before this is called (`leftTasks.buildOnRefusal`).
   */
  async *buildOn(left: BuildOnTask, task: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const started = await this.startBuildOn(left, task, signal);
    if ('line' in started) {
      yield started.failed ? this.failure(started.line) : this.doneEvent(started.line);
      return;
    }
    yield* this.follow(signal, started.cursor);
  }

  private async startBuildOn(left: BuildOnTask, task: string, signal: AbortSignal): Promise<{ cursor: number } | { line: string; failed: boolean }> {
    const view = await this.idleOn(left);
    if ('line' in view) return view;
    const modeRefused = await this.matchChatMode(view);
    if (modeRefused) return { line: modeRefused, failed: true };
    if (signal.aborted) return { line: CODEX_LINES.stopped, failed: false };
    const branch = await this.options.git.continueOn(left.branch, left.tip, task);
    if (!branch.ok) return { line: branch.line, failed: true };
    const refused = await this.continueTurn(task, 'continue');
    return refused && refused !== CODEX_LINES.passedOn ? { line: refused, failed: false } : { cursor: view.last_event_id };
  }

  /** The session, opened with its stored key, still idle on the branch the owner chose; or what to say instead. */
  private async idleOn(left: BuildOnTask): Promise<SessionView | { line: string; failed: boolean }> {
    const read = this.options.tokens.read(this.options.workspace.root, left.sessionId);
    if (read.kind !== 'found') return { line: tokenLine(read), failed: true };
    this.session = { id: left.sessionId, token: read.entry.token, taskId: read.entry.taskId };
    const view = await this.options.relay.getSession(left.sessionId, read.entry.token);
    if (!view.ok) return { line: failureLine(view.failure, 'start'), failed: true };
    if (view.value.state !== 'idle' || view.value.branch?.name !== left.branch) return { line: buildOnGoneLine(left.branch), failed: false };
    this.noteDetails(view.value);
    return view.value;
  }

  /** The chat's mode for the task's turns from now on, when it was started in another. Undefined once they match. */
  private async matchChatMode(view: SessionView): Promise<string | undefined> {
    const mode = this.options.modeNow?.() ?? this.options.mode;
    const session = this.session;
    if (!session || view.mode === mode) return undefined;
    const changed = await this.options.relay.setMode(session.id, session.token, mode);
    if (!changed.ok) {
      this.log(`codex: the earlier task's mode couldn't be set to ${mode} (${changed.failure.kind})`);
      return modeNotChangedLine(mode);
    }
    this.log(`codex: the earlier task runs in ${mode} mode from its next turn (it was ${view.mode})`);
    return undefined;
  }

  // ── Switching to Clarvis's own engine (C3; design §6.2) ─────────────────────

  /**
   * Codex → Clarvis's own engine, steps 2 and 3: the project reserved for the other engine with this session's
   * token, then every question let go — recorded as never answered — and the turn interrupted for a switch. When
   * RAVIS won't reserve it, nothing is stopped and the task carries on.
   */
  async stopForSwitch(): Promise<SwitchResult<{ transferToken: string }>> {
    const reservable = await this.reservableLock();
    if (!reservable) return { ok: false, line: CODEX_LINES.cannotSwitch };
    const { session, locks, lockId } = reservable;
    const granted = await locks.transfer(lockId, { token: session.token }, 'clarvis_run', freshKey(), { retry: this.timing.retry });
    if (!granted.ok) return { ok: false, line: failureLine(granted.failure, 'during') };
    this.switching = {};
    for (const request of this.approvals.held) this.unanswered.push({ engine: 'codex', summary: requestSummary(request) });
    this.releaseQuestions();
    this.say(CODEX_LINES.stoppingForSwitch);
    void this.interruptForSwitch(session);
    return { ok: true, value: { transferToken: granted.value.transfer_token } };
  }

  /** Step 3: RAVIS's next word on the stop — every process confirmed gone, or what is left. */
  stoppedForSwitch(): Promise<SwitchConfirmation> {
    const switching = this.switching;
    if (!switching) return Promise.resolve({ gone: undefined, line: CODEX_LINES.cannotSwitch });
    const last = switching.last;
    switching.last = undefined;
    return last ? Promise.resolve(last) : new Promise((resolve) => (switching.waiting = resolve));
  }

  /** Leftovers: RAVIS is asked to stop them (`POST …/leftover`), then its next word on the stop is awaited. */
  async stopLeftoversForSwitch(): Promise<SwitchConfirmation> {
    const session = this.session as Session;
    const stopped = await this.options.relay.stopLeftover(session.id, session.token, { retry: this.timing.retry });
    if (!stopped.ok && refusalCode(stopped.failure) !== 'NO_LEFTOVER') return { gone: undefined, line: failureLine(stopped.failure, 'during') };
    return this.stoppedForSwitch();
  }

  /**
   * Step 4, first half: the settle claimed and Codex's work committed on the task's branch as stopped for a switch.
   * What the checkpoint needs comes back; nothing is settled until `settleForSwitch`, once the checkpoint is written.
   */
  async claimForSwitch(): Promise<SwitchResult<CodexSettleFacts>> {
    const session = this.session;
    const switching = this.switching;
    if (!session || !switching || this.superseded) return { ok: false, line: this.superseded ? CODEX_LINES.superseded : CODEX_LINES.cannotSwitch };
    const claim = await this.options.relay.claimSettle(session.id, session.token, this.options.window.id);
    if (!claim.ok) return { ok: false, line: failureLine(claim.failure, 'during') };
    const branch = this.branchName ?? (await this.readBranch(session));
    const saved = await this.options.git.save({ summary: this.ledger.lastMessage, stopped: true, files: this.ledger.files, branch, forSwitch: true });
    if (!saved.ok) return { ok: false, line: saved.line };
    this.noteSaved(saved);
    switching.claim = { id: claim.value.claim_id, commit: saved.commit };
    return { ok: true, value: this.settleFacts(session, saved.commit, 'transferring', this.feedback.drainEntries()) };
  }

  /** Whether this window may write the switch's checkpoint: it holds the settle claim, on a lock RAVIS didn't give away. */
  holdsSwitchClaim(): boolean {
    return this.switching?.claim !== undefined && !this.superseded;
  }

  /** Step 4, second half, once the checkpoint is written: `settle {next:"transfer"}`. The session stays idle, never ended (AH4). */
  async settleForSwitch(): Promise<SwitchResult<void>> {
    const session = this.session;
    const claim = this.switching?.claim;
    if (!session || !claim) return { ok: false, line: CODEX_LINES.cannotSwitch };
    const body = { claim_id: claim.id, commit: claim.commit, next: 'transfer' as const };
    const settled = await this.options.relay.settle(session.id, session.token, body, freshKey(), { retry: this.timing.retry });
    if (!settled.ok) return { ok: false, line: failureLine(settled.failure, 'during') };
    this.switching = undefined;
    this.finishWith({ kind: 'done', text: CODEX_LINES.handedOver, files: this.result.files });
    return { ok: true, value: undefined };
  }

  /**
   * The switch failed or was cancelled before the destination took the project. This window goes on as after a
   * Stop: once RAVIS confirms everything gone, it settles the task itself. Work already committed for the switch
   * waits to be saved; nothing is settled on a checkpoint that wasn't written.
   */
  abandonSwitch(): void {
    const switching = this.switching;
    this.switching = undefined;
    if (!switching || this.finished) return;
    this.stopRequested = true;
    if (switching.claim) return this.finishWith(this.doneEvent(CODEX_LINES.switchAbandoned));
    if (NEEDS_SETTLE.has(this.state ?? '')) void this.settle();
  }

  // ── Switching into Codex (C3; design §6.2 step 6) ───────────────────────────

  /**
   * Clarvis's own engine → Codex: the task's branch continued at the saved commit, then the project taken with the
   * transfer token — a catch-up turn on the task's idle session (AH4), a new session resuming its thread, or a fresh
   * brief — and the session followed. `started` resolves once Codex's turn has begun, or with why it didn't.
   */
  continueFromSwitch(into: SwitchIntoCodex, signal: AbortSignal): { events: AsyncGenerator<AgentEvent>; started: Promise<SwitchResult<void>> } {
    let resolve: (result: SwitchResult<void>) => void = () => undefined;
    const promise = new Promise<SwitchResult<void>>((settle) => (resolve = settle));
    this.switchStart = { promise, resolve, done: false };
    return { events: this.switchEvents(into, signal), started: promise };
  }

  /** Whether the session holds the project for Codex: the checkpoint is written only then (C3). */
  holdsProjectLock(): boolean {
    return this.session !== undefined && !this.superseded;
  }

  private async *switchEvents(into: SwitchIntoCodex, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const opened = await this.openForSwitch(into);
    if ('line' in opened) {
      this.resolveSwitchStart({ ok: false, line: opened.line });
      yield this.failure(opened.line);
      return;
    }
    yield* this.follow(signal, opened.cursor);
  }

  private async openForSwitch(into: SwitchIntoCodex): Promise<{ cursor: number | null } | { line: string }> {
    const saved = into.checkpoint.git;
    const branch = await this.options.git.continueOn(saved.branch ?? '', saved.headCommit ?? '');
    if (!branch.ok) return { line: branch.line };
    return into.start.kind === 'catch_up' ? this.catchUpTurn(into, into.start.sessionId) : this.createForSwitch(into, branch);
  }

  /** The task's idle session takes a catch-up turn, taking the lock with the token (AH4: never a new session). */
  private async catchUpTurn(into: SwitchIntoCodex, sessionId: string): Promise<{ cursor: number } | { line: string }> {
    const read = this.options.tokens.read(this.options.workspace.root, sessionId);
    if (read.kind !== 'found') return { line: tokenLine(read) };
    this.session = { id: sessionId, token: read.entry.token, taskId: read.entry.taskId };
    const view = await this.options.relay.getSession(sessionId, read.entry.token);
    if (!view.ok) return { line: failureLine(view.failure, 'during') };
    this.noteDetails(view.value);
    // With a transfer token the lock is taken from Clarvis's own engine; without one (a stopped task) the turn takes
    // the project when nothing holds it, as any turn does.
    const turn = into.transferToken ? { text: into.catchUp, kind: 'catch_up' as const, lock: { transfer_token: into.transferToken } } : { text: into.catchUp, kind: 'catch_up' as const };
    const started = await this.options.relay.startTurn(sessionId, read.entry.token, turn, freshKey(), { retry: this.timing.retry });
    return started.ok ? { cursor: view.value.last_event_id } : { line: switchStartLine(started.failure) };
  }

  /** A new session for the same task: resuming the old thread, or from the brief — taking the lock with the token. */
  private async createForSwitch(into: SwitchIntoCodex, branch: { branch: string; headCommit: string }): Promise<{ cursor: number } | { line: string }> {
    const taskId = into.checkpoint.taskId;
    const start = into.start.kind === 'resume' ? { kind: 'resume' as const, thread_id: into.start.threadId, catch_up_text: into.catchUp } : { kind: 'brief' as const, text: into.brief };
    // The owner's model and effort, held to what Codex lists now (C2b+); unread, Codex's own default is used.
    if (this.hasChoice() && !this.codexState) this.codexState = await this.readCodexState();
    const body: CreateSessionBody ={ ...this.createBody(into.brief, taskId, branch), start, lock: { transfer_token: into.transferToken ?? null } };
    const attempt = into.transferToken ?? `checkpoint:${into.checkpoint.savedAt}`;
    const created = await this.options.relay.createSession(body, switchCreateKey(taskId, this.options.window.id, attempt), { retry: this.timing.retry });
    if (!created.ok) return { line: switchStartLine(created.failure) };
    const { session, session_token: token } = created.value;
    this.session = { id: session.id, token, taskId };
    this.keepToken(session.id, token, taskId);
    this.noteView(session);
    this.sayModel(session);
    // From the created session's own cursor, not a snapshot: Codex's first `turn.started` may come before the
    // stream opens, and a snapshot would never replay it — the switch would wait for a start that already happened.
    return { cursor: session.last_event_id };
  }

  private resolveSwitchStart(result: SwitchResult<void>): void {
    const start = this.switchStart;
    if (!start || start.done) return;
    start.done = true;
    start.resolve(result);
  }

  private async reservableLock(): Promise<{ session: Session; locks: LockClient; lockId: string } | undefined> {
    const session = this.session;
    const locks = this.options.locks;
    if (!session || !locks || this.finished) return undefined;
    const lockId = this.lockId ?? (await this.readLockId(session));
    return lockId ? { session, locks, lockId } : undefined;
  }

  private async readLockId(session: Session): Promise<string | undefined> {
    const view = await this.options.relay.getSession(session.id, session.token);
    return view.ok ? view.value.lock?.id : undefined;
  }

  private async interruptForSwitch(session: Session): Promise<void> {
    const sent = await this.options.relay.interrupt(session.id, session.token, 'switch', { retry: this.timing.interruptRetry });
    if (!sent.ok) this.resolveSwitch({ gone: undefined, line: failureLine(sent.failure, 'during') });
  }

  private resolveSwitch(confirmation: SwitchConfirmation): void {
    const switching = this.switching;
    if (!switching) return;
    const waiting = switching.waiting;
    switching.waiting = undefined;
    if (waiting) waiting(confirmation);
    else switching.last = confirmation;
  }

  /** Whether a state is the end of a stop a switch is waiting on. */
  private switchOwns(state: string): boolean {
    return this.switching !== undefined && (NEEDS_SETTLE.has(state) || state === 'leftover');
  }

  /** RAVIS's stop for a switch reached an end: confirmed gone (a state that waits to be saved), or leftover. */
  private switchStopped(state: string, processes: unknown): void {
    if (NEEDS_SETTLE.has(state)) this.workWaited = true;
    this.resolveSwitch(state === 'leftover' ? { gone: false, leftover: leftoverLine(processes) } : { gone: true });
  }

  /** The checkpoint's facts at a settle. `feedback` is what the settle hands on. */
  private settleFacts(session: Session, headCommit: string, status: CheckpointStatus, feedback: FeedbackEntry[]): CodexSettleFacts {
    return {
      taskId: session.taskId,
      session: { id: session.id, threadId: session.threadId, lastTurnId: this.lastTurn.id, lastTurnStatus: this.lastTurn.status, sawHeadCommit: headCommit },
      branch: this.branchName,
      headCommit,
      changedFiles: this.result.files,
      checks: [...this.ledger.checks],
      feedback,
      unanswered: [...this.unanswered],
      uncertain: this.ledger.unfinished.map((operation) => ({ ...operation, state: 'unknown' as const })),
      status,
    };
  }

  /** A new token for a session whose token file lost it (design §3.5.1): undefined once kept, else why not. */
  async reissue(summary: SessionSummary): Promise<string | undefined> {
    const { relay, workspace } = this.options;
    const reissued = await relay.reissueToken(summary.id, workspace.root, freshKey(), { retry: this.timing.retry });
    if (!reissued.ok) return reissued.failure.kind === 'refused' ? reissued.failure.message : failureLine(reissued.failure, 'during');
    this.keepToken(summary.id, reissued.value.session_token, summary.clarvis_task_id);
    return undefined;
  }

  /** Stop, pressed in this window (design §5.3): every question goes at once, then RAVIS is told. */
  stop(): void {
    if (this.stopRequested || this.finished) return;
    this.stopRequested = true;
    // Before anything is sent: the question on screen must not outlive the Stop that ended it.
    this.releaseQuestions();
    this.say(CODEX_LINES.stopping);
    // Saved and idle, waiting only on the owner's site decisions: nothing runs in RAVIS to stop (R5).
    if (this.state === 'idle' && !this.carryOnSent && !this.carryOnSending) return this.finishWith(this.doneEvent(CODEX_LINES.stopped));
    void this.interrupt();
  }

  /** Something the person typed for Codex (design §5.4). Steered when it can be, kept when it can't. */
  interject(text: string): void {
    const said = text.trim();
    if (said === '') return;
    if (this.canSteer()) void this.steer(said);
    else this.keepForLater(said, CODEX_LINES.keptForLater);
  }

  /** Whatever typed text Codex hasn't received, taken out of the run (review H8). */
  drainInterjections(): string[] {
    return this.feedback.drain();
  }

  /**
   * A new turn on this session: "carry on" after the step cap, a continue (design §5.5). Undefined when
   * RAVIS took it; otherwise what to say, with the text kept for later.
   */
  async continueTurn(text: string, kind: TurnKind): Promise<string | undefined> {
    const session = this.session;
    if (!session) return CODEX_LINES.tokenMissing;
    const delivered = this.feedback.pending;
    const turn = { text: this.feedback.turnText(text), kind };
    const started = await this.options.relay.startTurn(session.id, session.token, turn, freshKey(), { retry: this.timing.retry });
    if (!started.ok) return this.turnRefused(text, started.failure);
    for (const said of delivered) this.feedback.markDelivered(said);
    return undefined;
  }

  /** The chat panel pinged (every 10 s while it is there). */
  panelPinged(nowMs: number): void {
    if (this.session) this.applyPresence(this.presence.ping(nowMs));
  }

  /** A presence timer tick, every few seconds. */
  presenceTick(nowMs: number): void {
    if (this.session) this.applyPresence(this.presence.tick(nowMs));
  }

  /** Says something in the chat from outside the loop — the asker's line, say. */
  note(line: string): void {
    this.say(line);
  }

  /** The chat's mode changed: Unattended may now answer the request on screen itself (C2b). */
  modeChanged(): void {
    this.approvals.modeChanged();
  }

  /** The window is closing: stop following. The task goes on in RAVIS. */
  dispose(): void {
    this.disposer.abort();
    this.finish();
  }

  get result(): { commits: string[]; files: string[] } {
    return { commits: [...this.commits], files: union(this.ledger.files, this.savedFiles) };
  }

  /** True when the task ended on a failure. A stop, from anywhere, is not one. */
  get blocked(): boolean {
    return this.failed;
  }

  get codexSession(): { id: string; threadId?: string } | undefined {
    return this.session && { id: this.session.id, threadId: this.session.threadId };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  /** The last turn this window saw ended at RAVIS's step cap: "carry on" should continue this session. */
  get endedAtStepCap(): boolean {
    return this.stepCap;
  }

  /** The start was refused because the folder needs git set up, and nothing else stood in the way: offer to set it up. */
  get needsGitSetup(): boolean {
    return this.gitSetupWanted;
  }

  /** The turn Codex is in, as far as this window has heard; a steer names it. */
  get activeTurnId(): string | null {
    return this.activeTurn;
  }

  // ── Starting ──────────────────────────────────────────────────────────────

  /** Why a new task doesn't start, as the event that ends its run, or undefined to go on. `said` collects the ask's last word. */
  private async beforeStart(task: string, signal: AbortSignal, said: string[]): Promise<AgentEvent | undefined> {
    const refusal = await this.refusal();
    if (refusal) return this.failure(refusal);
    // A model or effort chosen before Codex has listed its models can't be checked yet (R5): a moment too early.
    if (this.hasChoice() && (this.codexState?.models ?? []).length === 0) return this.doneEvent(CODEX_LINES.modelsNotListed);
    const sites = await this.sitesBeforeStart(task, signal, said);
    if (sites === 'start') return undefined;
    return this.doneEvent(sites === 'cancel' ? SITE_LINES.cancelled : CODEX_LINES.stopped);
  }

  private async refusal(): Promise<string | undefined> {
    const state = await this.options.relay.codexState();
    if (!state.ok) return failureLine(state.failure, 'start');
    this.codexState = state.value;
    const failure = codexReadiness(state.value);
    return failure && failureLine(failure, 'start');
  }

  private async readCodexState(): Promise<CodexState | undefined> {
    const state = await this.options.relay.codexState();
    return state.ok ? state.value : undefined;
  }

  // ── The sites a task needs, before it starts (C2b+; the owner's option 1) ────

  /**
   * The sites a new task will likely need, asked about once before anything is touched: found in the project and the
   * brief, less those Codex already allows. Nothing is asked when nothing is found, or when RAVIS can't say which
   * sites it allows: Codex then asks about a blocked site as it meets one.
   */
  private async sitesBeforeStart(task: string, signal: AbortSignal, said: string[]): Promise<StartChoice> {
    const asking: SitesAsking = { found: await this.sitesToAsk(task), allowOffered: true, again: false, before: '', said };
    while (asking.found.length > 0) {
      const prompt = preTaskAsk(asking.found, asking.allowOffered, asking.before);
      const reply = await untilAborted(this.options.ask(prompt, signal, asking.again), signal);
      if (signal.aborted || reply === undefined) return 'stopped';
      const next = await this.afterSitesReply(asking, preTaskChoice(prompt, reply));
      if (next !== 'ask') return next;
    }
    return 'start';
  }

  /** The hosts to ask about: found, not yet allowed, and no more than one allow takes. */
  private async sitesToAsk(task: string): Promise<FoundSite[]> {
    const found = await this.sitesFound(task);
    if (found.length === 0) return [];
    const listed = await this.options.relay.codexSites({ timeoutMs: SITES_TIMEOUT_MS });
    if (!listed.ok) {
      this.log(`codex: the allowed sites couldn't be read, so none were asked about before the start (${listed.failure.kind})`);
      return [];
    }
    return notYetAllowed(found, [...listed.value.defaults, ...listed.value.added]).slice(0, MOST_SITES);
  }

  /** What the look through the project found; nothing when it couldn't look, since a task never waits on it. */
  private async sitesFound(task: string): Promise<FoundSite[]> {
    try {
      return (await this.options.sitesFor?.(task)) ?? [];
    } catch (error) {
      this.log(`codex: the project wasn't looked through for sites (${String(error)})`);
      return [];
    }
  }

  private async afterSitesReply(asking: SitesAsking, choice: PreTaskChoice | undefined): Promise<StartChoice | 'ask'> {
    asking.again = choice === undefined;
    if (choice === 'cancel') return 'cancel';
    if (choice === 'start_without') return 'start';
    return choice === 'allow_and_start' ? this.allowBeforeStart(asking) : 'ask';
  }

  /** "Allow and start": every host added — or the owner asked again, told why not, about what is left. */
  private async allowBeforeStart(asking: SitesAsking): Promise<StartChoice | 'ask'> {
    const hosts = asking.found.map((site) => site.host);
    const allowed = await this.options.relay.allowSites(hosts, { timeoutMs: SITES_TIMEOUT_MS, retry: this.timing.retry });
    if (allowed.ok) {
      asking.said.push(sitesAllowedLine(hosts));
      return 'start';
    }
    const refused = allowed.failure.kind === 'refused' && allowed.failure.code === 'SITES_REFUSED' ? refusedSites(allowed.failure.details) : [];
    if (refused.length > 0) {
      // Nothing was added: the hosts RAVIS would take are asked about again, without the ones it won't.
      asking.found = asking.found.filter((site) => !refused.some((entry) => entry.host === site.host));
      asking.before = sitesRefusedLine(refused);
      if (asking.found.length === 0) asking.said.push(asking.before);
      return 'ask';
    }
    asking.before = refusalCode(allowed.failure) === 'SITE_NOT_ADDED' ? sitesNotAddedLine(hosts) : sitesNotAllowedLine(hosts);
    asking.allowOffered = false;
    return 'ask';
  }

  // ── The session ─────────────────────────────────────────────────────────────

  /** The task's branch, then its session. Undefined once created; otherwise the event that ends the run. */
  private async branchAndCreate(task: string, signal: AbortSignal): Promise<AgentEvent | undefined> {
    const branch = signal.aborted ? undefined : await this.options.git.begin(task);
    if (!branch) return this.doneEvent(CODEX_LINES.stopped);
    if (!branch.ok) return this.branchRefused(branch);
    const refused = await this.create(task, branch);
    if (refused) await this.options.git.abandon();
    return refused;
  }

  /**
   * No branch, so no task: the reason, as the event that ends the run. When all that's missing is git set up in the
   * folder, the chat offers to set it up (plan.md M15, "Codex offers to set git up") — but only once RAVIS has said it
   * would take this folder at all. RAVIS checks the folder when a session is created, which comes after the branch,
   * so without asking first git could be set up in a folder Codex refuses anyway: a protected repository, one outside
   * the allowed roots, a private folder. The session list is a read, and RAVIS applies the same folder rule to it
   * (`conventions.json`: `WORKSPACE_ROOT_NOT_ALLOWED` on "session create and list"). Refused there, the chat gives
   * RAVIS's reason instead, and offers nothing.
   */
  private async branchRefused(branch: { line: string; gitSetup?: boolean }): Promise<AgentEvent> {
    if (!branch.gitSetup) return this.failure(branch.line);
    const listed = await this.options.relay.listSessions(this.options.workspace.root);
    if (!listed.ok) return this.failure(failureLine(listed.failure, 'start'));
    this.gitSetupWanted = true;
    return this.failure(branch.line);
  }

  /** Creates the session. Undefined once created; otherwise the event that ends the run. */
  private async create(task: string, branch: { branch: string; headCommit: string }): Promise<AgentEvent | undefined> {
    const taskId = (this.options.newTaskId ?? randomUUID)();
    const key = createSessionKey(taskId, this.options.window.id, 1);
    const body = this.createBody(task, taskId, branch);
    const created = await this.options.relay.createSession(body, key, { retry: this.timing.retry });
    if (!created.ok) return this.createRefused(created.failure, body);
    const { session, session_token: token } = created.value;
    this.session = { id: session.id, token, taskId };
    this.keepToken(session.id, token, taskId);
    this.noteView(session);
    this.sayModel(session);
    return undefined;
  }

  private createBody(task: string, taskId: string, branch: { branch: string; headCommit: string }): CreateSessionBody {
    const { window, workspace, mode, maxSteps } = this.options;
    return {
      workspace_root: workspace.root,
      clarvis_task_id: taskId,
      window: { id: window.id, host: window.host },
      mode,
      ...this.modelAndEffort(),
      branch: { name: branch.branch, head_commit: branch.headCommit },
      git_dir: workspace.gitDir,
      start: { kind: 'brief', text: task },
      lock: { transfer_token: null },
      limits: { max_steps: maxSteps },
    };
  }

  /**
   * The model and effort a new session runs at (C2b+, R5): the owner's choice held to the models Codex listed — a model
   * no longer offered becomes the default, said once — or Codex's own default when nothing is chosen or listed.
   */
  private modelAndEffort(): { model: string; effort?: string } {
    const stored = this.storedChoice();
    const choice = this.hasChoice() ? effectiveCodexChoice(this.codexState?.models ?? [], stored) : undefined;
    if (!choice) return { model: '' };
    if (stored.model !== undefined && stored.model !== choice.model.id) {
      this.sayOnce('model-fell-back', modelFellBackLine(stored.model, choice.model.id, choice.effort));
    }
    return { model: choice.model.id, effort: choice.effort };
  }

  private storedChoice(): StoredCodexChoice {
    return this.options.codexChoice?.() ?? {};
  }

  private hasChoice(): boolean {
    const stored = this.storedChoice();
    return stored.model !== undefined || stored.effort !== undefined;
  }

  /** Which model and effort a session this window created runs at, from its view (R5). */
  private sayModel(view: SessionView): void {
    const line = codexModelLine(view.codex?.model, view.codex?.effort);
    if (line) this.sayOnce('model', line);
  }

  private createRefused(failure: RelayFailure, body: CreateSessionBody): AgentEvent {
    this.attachInstead = codexHolder(failure);
    // Codex hadn't listed its models, so RAVIS couldn't check the chosen one: a moment too early, not an error (R5).
    const tooEarly = failure.kind === 'runtime_unavailable' && (body.model !== '' || body.effort !== undefined);
    return tooEarly ? this.doneEvent(CODEX_LINES.modelsNotListed) : this.failure(failureLine(failure, 'start'));
  }

  private keepToken(sessionId: string, token: string, taskId: string): void {
    try {
      this.options.tokens.save(this.options.workspace.root, sessionId, token, taskId);
    } catch (error) {
      // The task still runs; another window will need Reconnect to follow it.
      this.log(`codex: the session token could not be kept (${String(error)})`);
    }
  }

  // ── Following ─────────────────────────────────────────────────────────────

  private async *follow(signal: AbortSignal, cursor: number | null): AsyncGenerator<AgentEvent> {
    this.cursor = cursor;
    const onAbort = () => this.stop();
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) this.stop();
    // The run was started, or picked up, from the panel: it is there.
    this.panelPinged(this.nowMs());
    const pumping = this.pump();
    try {
      yield* this.channel;
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.finish();
      await pumping;
      // Only now, with nothing more to save from here: a checkout taken over for the save is let go (F-A9).
      await this.releaseAdopted();
      // A switch into Codex that ended before its turn began didn't start.
      this.resolveSwitchStart({ ok: false, line: CODEX_LINES.ravisDownMidTurn });
    }
  }

  private async pump(): Promise<void> {
    while (!this.finished) {
      if (this.attached) await this.readStream();
      else await new Promise<void>((resolve) => (this.whenAttached = resolve));
    }
  }

  private async readStream(): Promise<void> {
    const session = this.session as Session;
    const { relay, window, sleep } = this.options;
    const stream = new RelayEventStream({
      client: relay,
      sessionId: session.id,
      token: session.token,
      windowId: window.id,
      host: window.host,
      cursor: this.cursor,
      backoffMs: this.timing.streamBackoffMs,
      silenceLimitMs: this.timing.silenceLimitMs,
      sleep,
    });
    this.stream = stream;
    try {
      for await (const item of stream) {
        await this.onStreamItem(item);
        if (this.finished || !this.attached) break;
      }
    } finally {
      stream.close();
      this.stream = undefined;
      this.connected = false;
    }
  }

  private async onStreamItem(item: StreamItem): Promise<void> {
    if (item.type === 'event') return this.onEvent(item.id, item.event, item.data);
    if (item.type === 'connected') return this.onConnected();
    if (item.type === 'disconnected') return this.onDisconnected();
    if (item.type === 'ended') return this.finishWith(this.failure(failureLine(item.failure, 'during')));
    this.log(`codex: stream ${item.type}`);
  }

  private async onEvent(id: number | null, name: string, data: Record<string, unknown>): Promise<void> {
    if (id !== null) this.remember(id);
    const handle = this.handlers.get(name);
    if (handle) await handle(data);
    else this.log(`codex: ${name} passed over`);
  }

  private remember(id: number): void {
    this.cursor = id;
    if (this.session) this.options.cursors.set(this.session.id, id);
  }

  private onConnected(): void {
    this.connected = true;
    if (this.dropsInARow >= 2) this.say(CODEX_LINES.ravisBack);
    this.dropsInARow = 0;
    void this.deliverKept();
    // An answer RAVIS never received is asked again now that it answers; a carry-on it never took is sent again.
    this.approvals.reconnected();
    void this.sendCarryOn();
  }

  private onDisconnected(): void {
    this.connected = false;
    this.dropsInARow++;
    // One dropped connection that comes straight back is nothing to report (design §9).
    if (this.dropsInARow === 2 && !this.stopRequested) this.say(CODEX_LINES.ravisDownMidTurn);
  }

  // ── What the session says ─────────────────────────────────────────────────

  private onSnapshot(view: SessionView): void {
    this.noteView(view);
    this.showReconnecting(Boolean(view.codex?.reopening));
    for (const request of view.pending_requests ?? []) this.approvals.open(request);
    this.afterState(view.state, view.processes);
  }

  private noteView(view: SessionView): void {
    this.state = view.state;
    this.activeTurn = view.codex?.active_turn_id ?? null;
    this.noteDetails(view);
  }

  private noteDetails(view: SessionView): void {
    if (this.session && view.codex?.thread_id) this.session.threadId = view.codex.thread_id;
    if (view.branch?.name) this.branchName = view.branch.name;
    this.noteLock(view.lock);
  }

  private noteLock(lock: SessionView['lock'] | undefined): void {
    if (lock?.id) this.lockId = lock.id;
    if (lock?.state === 'superseded') this.superseded = true;
  }

  private onSessionState(data: Record<string, unknown>): void {
    const state = String(data.state);
    this.state = state;
    if (state === 'stopping') this.onRavisStopping(data.stopped_by);
    this.afterState(state, data.processes);
  }

  /** RAVIS is stopping the task, whoever asked: questions go at once, here too. */
  private onRavisStopping(stoppedBy: unknown): void {
    this.ravisStopping = true;
    this.releaseQuestions();
    // This window's own Stop has said its line; a stop from anywhere else says where it came from.
    const line = this.stopRequested || this.switching ? undefined : stoppedByLine(stoppedBy);
    if (line) this.sayOnce(`stopped-by:${String(stoppedBy)}`, line);
  }

  private afterState(state: string, processes: unknown): void {
    // During a switch the stop's end is the switch's to act on: it settles once the checkpoint is written.
    if (this.switchOwns(state)) return this.switchStopped(state, processes);
    if (NEEDS_SETTLE.has(state)) return this.toSettle(state);
    if (state === 'leftover') return this.sayOnce(`leftover`, leftoverLine(processes));
    if (state === 'failed') this.failed = true;
    if (state === 'idle') return this.endOrCarryOn();
    if (ENDED.has(state)) return this.finishWith(this.closingEvent());
    if (STEERABLE.has(state)) void this.deliverKept();
  }

  private toSettle(state: string): void {
    this.workWaited = true;
    // A carry-on's turn that ended, or never began — cut off by a Stop or a restart — is over (R5).
    this.carryOnSent = false;
    const line = settleStateLine(state);
    if (line) this.sayOnce(`state:${state}`, line);
    void this.settle();
  }

  private onTurnStarted(data: Record<string, unknown>): void {
    if (typeof data.turn_id === 'string') this.activeTurn = data.turn_id;
    // A turn that begins after this window tried its carry-on is that carry-on, even when every answer to it was lost (R5).
    if (this.owedCarryOn?.sent) this.carryOnTaken(this.owedCarryOn);
    // A new turn is new work to save, whoever saved the last — as when a carry-on's turn begins after blocked sites (R5).
    this.workWaited = false;
    this.savedHere = false;
    this.claimedElsewhere = false;
    // A switch into Codex has started once Codex's turn has begun (design §6.2 step 7).
    this.resolveSwitchStart({ ok: true, value: undefined });
    void this.deliverKept();
  }

  private onTurnCompleted(data: Record<string, unknown>): void {
    this.activeTurn = null;
    this.stepCap = (data.error as { kind?: unknown } | undefined)?.kind === 'step_cap';
    this.lastTurn = turnRef(data);
    if (data.status === 'failed') this.failed = true;
    const line = turnEndLine(data.status, data.error);
    if (line) this.say(line);
  }

  private onLockChanged(data: Record<string, unknown>): void {
    if (data.state !== 'superseded') return;
    this.superseded = true;
    this.sayOnce('superseded', CODEX_LINES.superseded);
  }

  // ── Blocked sites during a task (R5) ──────────────────────────────────────

  /** RAVIS let go of Codex's thread to reopen it, as often as it does: "Reconnecting Codex…" until Codex has let go. */
  private onReopening(data: Record<string, unknown>): void {
    this.log(`codex: reopening the thread for ${Array.isArray(data.hosts) ? data.hosts.join(', ') : 'the allowed sites'}`);
    this.showReconnecting(true);
  }

  /** Codex let go of the thread, so an allowed site reaches its next turn — or it still held it at RAVIS's two-minute cap. */
  private onReopened(incomplete: boolean): void {
    this.showReconnecting(false);
    if (incomplete) this.say(SITE_LINES.reopenIncomplete);
  }

  private showReconnecting(on: boolean): void {
    if (this.reconnecting === on || this.finished) return;
    this.reconnecting = on;
    this.channel.push({ kind: 'status', text: on ? SITE_LINES.reconnecting : '' });
  }

  /**
   * Every host of a group of site asks is decided (R5). The window whose answer decided the last host carries the task
   * on, once no turn runs and the work so far is saved; RAVIS holds that turn until Codex's thread is reopened. Another
   * group decided before the carry-on went joins it.
   */
  private sitesDecided(decided: SitesDecided): void {
    if (!decided.here || this.isStopping() || !this.session) return;
    this.say(siteDecisionsLine(decided.allowed, decided.kept));
    const owed = this.owedCarryOn;
    this.owedCarryOn = { allowed: [...(owed?.allowed ?? []), ...decided.allowed], kept: [...(owed?.kept ?? []), ...decided.kept] };
    void this.sendCarryOn();
  }

  /** Sends the carry-on once a turn may start: nothing running, the work saved, and not stopping (R5). */
  private async sendCarryOn(): Promise<void> {
    const carryOn = this.owedCarryOn;
    const session = this.session;
    if (!carryOn || !session || this.carryOnSending || !this.turnMayStart()) return;
    this.carryOnSending = true;
    try {
      carryOn.sent ??= this.composeCarryOn(carryOn);
      const { turn, key } = carryOn.sent;
      const started = await this.options.relay.startTurn(session.id, session.token, turn, key, { retry: this.timing.retry });
      if (started.ok) this.carriedOn(carryOn);
      else this.carryOnRefused(carryOn, started.failure);
    } finally {
      this.carryOnSending = false;
    }
  }

  private turnMayStart(): boolean {
    return this.state === 'idle' && this.activeTurn === null && !this.isStopping();
  }

  /** The carry-on turn, with anything typed meanwhile in front of it, and the key every retry of it reuses. */
  private composeCarryOn(carryOn: PendingCarryOn): NonNullable<PendingCarryOn['sent']> {
    const delivered = this.feedback.pending;
    const turn = { text: this.feedback.turnText(carryOnText(carryOn.allowed, carryOn.kept)), kind: 'carry_on' as const };
    return { turn, key: freshKey(), delivered };
  }

  private carriedOn(carryOn: PendingCarryOn): void {
    this.carryOnTaken(carryOn);
    this.carryOnSent = true;
    this.log('codex: the task carries on after its blocked sites');
  }

  /** RAVIS took the carry-on, as its reply or its turn's start says: what was typed went with it, and it is owed no more. */
  private carryOnTaken(carryOn: PendingCarryOn): void {
    for (const said of carryOn.sent?.delivered ?? []) this.feedback.markDelivered(said);
    this.owedCarryOn = this.owedCarryOn === carryOn ? undefined : stillToSay(this.owedCarryOn, carryOn);
  }

  /** Not taken: sent again when it can be, passed to a turn that already runs, or said and let go. */
  private carryOnRefused(carryOn: PendingCarryOn, failure: RelayFailure): void {
    if (carryOnWaits(failure)) return this.log(`codex: the carry-on waits (${refusalCode(failure) ?? failure.kind})`);
    if (this.owedCarryOn === carryOn) this.owedCarryOn = undefined;
    const code = refusalCode(failure);
    // Another window started a turn meanwhile: Codex hears the decisions in it.
    if (code === 'TURN_ACTIVE') {
      void this.steer(carryOnText(carryOn.allowed, carryOn.kept));
      return;
    }
    if (code === 'SESSION_STOPPING') return;
    this.say(code === 'PROJECT_LOCKED' ? CODEX_LINES.lockedForTurns : failureLine(failure, 'during'));
    this.endOrCarryOn();
  }

  /** The task is saved and idle: the run ends — unless site asks are still being decided, or a carry-on is owed or on its way. */
  private endOrCarryOn(): void {
    if (!this.waitingOnSites()) return this.finishWith(this.closingEvent());
    void this.sendCarryOn();
  }

  private waitingOnSites(): boolean {
    return !this.isStopping() && (this.approvals.decidingSites || this.owedCarryOn !== undefined || this.carryOnSent);
  }

  // ── Questions ─────────────────────────────────────────────────────────────

  /** An answer to one of Codex's requests: keyed `<request id>:<window id>`, and resent with that key when RAVIS didn't answer. */
  private answerRequest(requestId: string, decision: Decision): Promise<RelayOutcome<unknown>> {
    const session = this.session as Session;
    const { relay, window } = this.options;
    return relay.answer(session.id, session.token, requestId, window.id, decision, { retry: this.timing.retry });
  }

  private releaseQuestions(): void {
    const released = this.approvals.releaseAll();
    if (released > 0) this.log(`codex: ${released} question(s) let go`);
  }

  // ── Stop ──────────────────────────────────────────────────────────────────

  private async interrupt(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const options = { retry: this.timing.interruptRetry };
    const sent = await this.options.relay.interrupt(session.id, session.token, 'stop', options);
    if (sent.ok) return;
    if (sent.failure.kind !== 'unreachable') return this.finishWith(this.failure(failureLine(sent.failure, 'during')));
    // RAVIS can't be reached: say so and free the chat, and go on trying for as long as the window is open.
    this.finishWith(this.doneEvent(CODEX_LINES.stopUnreachable));
    await this.keepInterrupting(session);
  }

  private async keepInterrupting(session: Session): Promise<void> {
    const signal = this.disposer.signal;
    while (!signal.aborted) {
      await (this.options.sleep ?? abortableSleep)(this.timing.interruptKeepTryingMs, signal);
      const sent = await this.options.relay.interrupt(session.id, session.token, 'stop', { signal });
      if (sent.ok || sent.failure.kind !== 'unreachable') return;
    }
  }

  private isStopping(): boolean {
    // A switch under way is a stop: no answer is sent, and typed text is kept for the other engine.
    return this.stopRequested || this.ravisStopping || this.finished || this.switching !== undefined;
  }

  // ── Steering ──────────────────────────────────────────────────────────────

  private canSteer(): boolean {
    const followable = this.session !== undefined && this.connected && this.attached;
    return followable && !this.isStopping() && STEERABLE.has(this.state ?? '');
  }

  /** True when RAVIS took the text; otherwise it is kept. */
  private async steer(text: string): Promise<boolean> {
    const session = this.session as Session;
    const body = this.activeTurn ? { text, expected_turn_id: this.activeTurn } : { text };
    const steered = await this.options.relay.steer(session.id, session.token, body, freshKey(), { retry: this.timing.retry });
    if (steered.ok) {
      this.feedback.markDelivered(text);
      return true;
    }
    this.keepForLater(text, steerRefusedLine(steered.failure));
    return false;
  }

  private keepForLater(text: string, line: string): void {
    if (this.feedback.keep(text, this.options.window.host, this.now())) this.say(line);
  }

  /** Delivers what was kept, oldest first, for as long as RAVIS takes it. */
  private async deliverKept(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      for (const text of this.feedback.pending) {
        if (!this.canSteer() || !(await this.steer(text))) return;
      }
    } finally {
      this.delivering = false;
    }
  }

  private onFeedback(data: Record<string, unknown>): void {
    const text = typeof data.text === 'string' ? data.text : '';
    if (data.how === 'not_delivered') return this.keepForLater(text, CODEX_LINES.notDelivered);
    this.feedback.markDelivered(text);
    const line = feedbackLine(data.how);
    if (line) this.say(line);
  }

  private turnRefused(text: string, failure: RelayFailure): string {
    if (refusalCode(failure) === 'TURN_ACTIVE') {
      void this.steer(text);
      return CODEX_LINES.passedOn;
    }
    this.feedback.keep(text, this.options.window.host, this.now());
    return refusalCode(failure) === 'PROJECT_LOCKED' ? CODEX_LINES.lockedForTurns : failureLine(failure, 'during');
  }

  // ── Settling ──────────────────────────────────────────────────────────────

  /** Saves the task's work, if this window wins the claim (design §3.5.3 "Settle"). */
  private async settle(): Promise<void> {
    const session = this.session;
    if (this.settling || this.finished || !this.attached || !session) return;
    this.settling = true;
    try {
      await this.claimAndSave(session);
    } finally {
      this.settling = false;
    }
  }

  /** The claim, then the save — after taking the checkout over from a gone editor, when RAVIS's lock was superseded. */
  private async claimAndSave(session: Session): Promise<void> {
    if (this.superseded && !(await this.adoptCheckout(session))) return this.fenced();
    const claim = await this.options.relay.claimSettle(session.id, session.token, this.options.window.id);
    if (claim.ok) return this.saveAndSettle(session, claim.value.claim_id);
    if (this.mayAdoptAfter(claim.failure)) {
      this.superseded = true;
      return this.claimAndSave(session);
    }
    this.claimRefused(claim.failure);
  }

  /** RAVIS refused the claim as superseded, and this window hasn't tried taking the checkout over yet. */
  private mayAdoptAfter(failure: RelayFailure): boolean {
    return refusalCode(failure) === 'LOCK_SUPERSEDED' && this.options.floor !== undefined && !this.adoptionTried;
  }

  /**
   * Takes the checkout over from the editor that held it when RAVIS restarted, if that editor is gone
   * (final check F-A9). False — and the fence stands — when there is no lock file to use, or the editor is
   * still there, or couldn't be judged.
   */
  private async adoptCheckout(session: Session): Promise<boolean> {
    const floor = this.options.floor;
    if (!floor || this.adoptionTried) return false;
    this.adoptionTried = true;
    const taken = await floor.takeFromGoneEditor(session.taskId);
    if ('refusal' in taken) {
      this.log(`codex: the checkout stays with the other editor (${taken.refusal})`);
      return false;
    }
    this.adopted = taken;
    this.superseded = false;
    this.say(CODEX_LINES.adoptedFromGoneEditor);
    return true;
  }

  private async releaseAdopted(): Promise<void> {
    const adopted = this.adopted;
    this.adopted = undefined;
    if (adopted) await adopted.release();
  }

  private claimRefused(failure: RelayFailure): void {
    const code = refusalCode(failure);
    if (code === 'SETTLE_CLAIMED' || code === 'NOTHING_TO_SETTLE') return this.savedElsewhere(code);
    if (code === 'LOCK_SUPERSEDED') return this.fenced();
    if (code === 'PROCESSES_NOT_CONFIRMED_GONE') return this.log('codex: the settle waits until everything Codex started has stopped');
    this.say(failureLine(failure, 'during'));
  }

  /**
   * Another window claimed the save, or has already made it — this window saw work waiting, and RAVIS
   * says there is none now. Either way this window commits nothing and has nothing to review.
   */
  private savedElsewhere(code: string): void {
    this.claimedElsewhere = true;
    if (code === 'NOTHING_TO_SETTLE') return this.endOrCarryOn();
    this.sayOnce('claimed', CODEX_LINES.otherEditorSaving);
  }

  private async saveAndSettle(session: Session, claimId: string): Promise<void> {
    // The fence: a lock RAVIS gave to someone else is never committed on.
    if (this.superseded) return this.fenced();
    const branch = this.branchName ?? (await this.readBranch(session));
    const work = { summary: this.ledger.lastMessage, stopped: this.wasStopped(), files: this.ledger.files, branch };
    const saved = await this.options.git.save(work);
    if (!saved.ok) return this.finishWith(this.failure(saved.line));
    this.noteSaved(saved);
    // C3: the checkpoint is written before the settle says it was (`checkpoint_saved: true`).
    if (!(await this.checkpointSaved(session, saved.commit))) return this.finishWith(this.failure(CODEX_LINES.checkpointNotSaved));
    // A new key for each settle attempt; its retries reuse it, so a lost answer replays the settled view.
    const body = { claim_id: claimId, commit: saved.commit, next: 'idle' as const };
    const settled = await this.options.relay.settle(session.id, session.token, body, freshKey(), { retry: this.timing.retry });
    if (!settled.ok) {
      this.say(failureLine(settled.failure, 'during'));
      return this.finishWith(this.closingEvent());
    }
    // Saved: the run ends, unless the owner is still deciding blocked sites and the task carries on after them (R5).
    this.noteView(settled.value);
    this.endOrCarryOn();
  }

  /** The checkpoint for an ordinary settle: what was typed stays with the run too, so its closing can still say so. */
  private async checkpointSaved(session: Session, headCommit: string): Promise<boolean> {
    const port = this.options.checkpoint;
    if (!port) return true;
    const status: CheckpointStatus = this.state === 'uncertain' ? 'uncertain' : this.wasStopped() ? 'interrupted' : 'settled';
    return port.save(this.settleFacts(session, headCommit, status, [...this.feedback.all]));
  }

  /** The task's branch, read from RAVIS when this window resumed from a cursor and never saw a snapshot. */
  private async readBranch(session: Session): Promise<string | undefined> {
    const view = await this.options.relay.getSession(session.id, session.token);
    return view.ok ? view.value.branch?.name : undefined;
  }

  private noteSaved(saved: Extract<CodexSave, { ok: true }>): void {
    this.savedHere = true;
    if (saved.committed && !this.commits.includes(saved.commit)) this.commits.push(saved.commit);
    for (const file of saved.files) if (!this.savedFiles.includes(file)) this.savedFiles.push(file);
  }

  private fenced(): void {
    this.superseded = true;
    this.finishWith(this.failure(CODEX_LINES.superseded));
  }

  // ── Presence ──────────────────────────────────────────────────────────────

  private applyPresence(actions: PresenceAction[]): void {
    for (const action of actions) this.presenceAction(action);
  }

  private presenceAction(action: PresenceAction): void {
    if (this.finished) return;
    if (action.kind === 'post') void this.postPresence(action.panelConnected);
    else if (action.kind === 'close_stream') this.detach();
    else this.reattach();
  }

  /** The panel went away: stop counting as attached. The task is not stopped. */
  private detach(): void {
    this.attached = false;
    this.connected = false;
    this.stream?.close();
  }

  private reattach(): void {
    this.attached = true;
    const resume = this.whenAttached;
    this.whenAttached = undefined;
    resume?.();
  }

  private async postPresence(connected: boolean): Promise<void> {
    const session = this.session as Session;
    const { window } = this.options;
    const report = { window_id: window.id, host: window.host, panel_connected: connected };
    const posted = await this.options.relay.presence(session.id, session.token, report);
    if (!posted.ok) this.log(`codex: presence not posted (${posted.failure.kind})`);
  }

  // ── Output ────────────────────────────────────────────────────────────────

  private closingEvent(): AgentEvent {
    // Work was waiting and this window didn't commit it: another window did, and this one has nothing to
    // review. Said even when the settled state arrived before this window's own claim was answered.
    if (this.claimedElsewhere || (this.workWaited && !this.savedHere)) {
      return { kind: 'done', text: CODEX_LINES.savedElsewhere, files: [] };
    }
    const text = this.wasStopped() ? CODEX_LINES.stopped : this.ledger.lastMessage.trim();
    return this.doneEvent(text);
  }

  private wasStopped(): boolean {
    return this.stopRequested || this.ravisStopping;
  }

  private failure(line: string): AgentEvent {
    this.failed = true;
    return this.doneEvent(line);
  }

  private doneEvent(text: string): AgentEvent {
    return { kind: 'done', text, files: this.result.files };
  }

  private say(line: string): void {
    this.channel.push({ kind: 'text', text: line, toChat: true });
  }

  private sayOnce(key: string, line: string): void {
    if (this.said.has(key)) return;
    this.said.add(key);
    this.say(line);
  }

  private pushAll(events: AgentEvent[]): void {
    for (const event of events) this.channel.push(event);
  }

  private finishWith(event: AgentEvent): void {
    if (this.finished) return;
    this.channel.push(event);
    this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.releaseQuestions();
    if (this.reconnecting) this.channel.push({ kind: 'status', text: '' });
    this.stream?.close();
    this.whenAttached?.();
    this.channel.close();
  }

  private terminal(text: unknown): void {
    if (typeof text === 'string') this.options.terminal?.(text);
  }

  private log(line: string): void {
    this.options.log?.(line);
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private nowMs(): number {
    return this.now().getTime();
  }
}

/** The Codex session to follow instead, when a create was refused because one holds the project. */
function codexHolder(failure: RelayFailure): string | undefined {
  if (refusalCode(failure) !== 'PROJECT_LOCKED' || failure.kind !== 'refused') return undefined;
  const holder = (failure.details.lock as { holder?: { kind?: unknown; session_id?: unknown } } | undefined)?.holder;
  return holder?.kind === 'codex_session' && typeof holder.session_id === 'string' ? holder.session_id : undefined;
}

/** The turn a `turn.completed` names, and how it ended, for the checkpoint's thread reference. */
function turnRef(data: Record<string, unknown>): { id?: string; status: CodexThreadRef['lastTurnStatus'] } {
  const status = data.status === 'completed' || data.status === 'interrupted' || data.status === 'failed' ? data.status : 'unknown';
  return typeof data.turn_id === 'string' ? { id: data.turn_id, status } : { status };
}

function union(first: string[], second: string[]): string[] {
  return [...new Set([...first, ...second])];
}

/** What a carry-on decided meanwhile still has to tell Codex, once an earlier carry-on went (R5). */
function stillToSay(current: PendingCarryOn | undefined, went: PendingCarryOn): PendingCarryOn | undefined {
  if (!current) return undefined;
  const allowed = current.allowed.filter((host) => !went.allowed.includes(host));
  const kept = current.kept.filter((host) => !went.kept.includes(host));
  return allowed.length + kept.length > 0 ? { allowed, kept } : undefined;
}

/** The owner's reply, or nothing the moment `signal` aborts: a Stop ends the ask whatever the chat does with its buttons. */
function untilAborted<T>(asked: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const letGo = () => resolve(undefined);
    signal.addEventListener('abort', letGo, { once: true });
    asked.then(resolve, () => resolve(undefined)).finally(() => signal.removeEventListener('abort', letGo));
  });
}

/** A carry-on refused for now: the work still waits to be saved, or RAVIS is out of reach. */
function carryOnWaits(failure: RelayFailure): boolean {
  return refusalCode(failure) === 'SETTLE_FIRST' || failure.kind === 'unreachable';
}
