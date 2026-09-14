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
import type { RelayClient } from '../relay/relayClient';
import type { RelayFailure, RelayOutcome } from '../relay/relayFailure';
import { abortableSleep, type Sleep } from '../relay/relayHttp';
import type {
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
import { CodexApprovals, type PromptShower } from './approvals';
import { EventChannel } from './eventChannel';
import { FeedbackQueue, type FeedbackEntry } from './feedback';
import { CodexLedger, type CheckRun } from './ledger';
import {
  CODEX_LINES,
  failureLine,
  feedbackLine,
  leftoverLine,
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

export type CodexBranch = { ok: true; branch: string; headCommit: string } | { ok: false; line: string };
export type CodexSave = { ok: true; commit: string; committed: boolean; files: string[] } | { ok: false; line: string };

/** Git, which only Clarvis runs: RAVIS never does (design §3.5.3 "Settle"). */
export interface CodexGit {
  /** The checkpoint and the task branch, before the session exists (design §5.1 step 2). */
  begin(task: string): Promise<CodexBranch>;
  /**
   * A task switched to Codex (C3; review B2): its existing branch, checked out at the commit the other engine saved
   * or a descendant of it — never a new branch beside that work. Refused, with a line, otherwise.
   */
  continueOn(branch: string, headCommit: string): Promise<CodexBranch>;
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

interface Session {
  id: string;
  token: string;
  taskId: string;
  threadId?: string;
}

type Handler = (data: Record<string, unknown>) => void | Promise<void>;

export class CodexRunCore {
  readonly ledger = new CodexLedger();
  readonly feedback = new FeedbackQueue();
  /** Codex's requests in this window: asked one at a time, answered with what RAVIS allows (C2b). */
  readonly approvals: CodexApprovals;
  /** Set when a start was refused because a Codex session already holds the project: follow that one. */
  attachInstead: string | undefined;

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
    ['site.allowed', (data) => this.approvals.siteAllowed(data)],
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
    });
  }

  /** A new task: refused before anything is touched unless Codex may run (design §5.1). */
  async *start(task: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const refusal = await this.refusal();
    if (refusal) {
      yield this.failure(refusal);
      return;
    }
    const branch = signal.aborted ? undefined : await this.options.git.begin(task);
    if (!branch?.ok) {
      yield branch ? this.failure(branch.line) : this.doneEvent(CODEX_LINES.stopped);
      return;
    }
    const refused = await this.create(task, branch);
    if (refused) {
      await this.options.git.abandon();
      yield this.failure(refused);
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
    const body: CreateSessionBody = { ...this.createBody(into.brief, taskId, branch), start, lock: { transfer_token: into.transferToken ?? null } };
    const attempt = into.transferToken ?? `checkpoint:${into.checkpoint.savedAt}`;
    const created = await this.options.relay.createSession(body, switchCreateKey(taskId, this.options.window.id, attempt), { retry: this.timing.retry });
    if (!created.ok) return { line: switchStartLine(created.failure) };
    const { session, session_token: token } = created.value;
    this.session = { id: session.id, token, taskId };
    this.keepToken(session.id, token, taskId);
    this.noteView(session);
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

  /** The turn Codex is in, as far as this window has heard; a steer names it. */
  get activeTurnId(): string | null {
    return this.activeTurn;
  }

  // ── Starting ──────────────────────────────────────────────────────────────

  private async refusal(): Promise<string | undefined> {
    const state = await this.options.relay.codexState();
    if (!state.ok) return failureLine(state.failure, 'start');
    const failure = codexReadiness(state.value);
    return failure && failureLine(failure, 'start');
  }

  /** Creates the session. Undefined once created; otherwise why not. */
  private async create(task: string, branch: { branch: string; headCommit: string }): Promise<string | undefined> {
    const taskId = (this.options.newTaskId ?? randomUUID)();
    const key = createSessionKey(taskId, this.options.window.id, 1);
    const body = this.createBody(task, taskId, branch);
    const created = await this.options.relay.createSession(body, key, { retry: this.timing.retry });
    if (!created.ok) return this.createRefused(created.failure);
    const { session, session_token: token } = created.value;
    this.session = { id: session.id, token, taskId };
    this.keepToken(session.id, token, taskId);
    this.noteView(session);
    return undefined;
  }

  private createBody(task: string, taskId: string, branch: { branch: string; headCommit: string }): CreateSessionBody {
    const { window, workspace, mode, maxSteps } = this.options;
    return {
      workspace_root: workspace.root,
      clarvis_task_id: taskId,
      window: { id: window.id, host: window.host },
      mode,
      model: '',
      branch: { name: branch.branch, head_commit: branch.headCommit },
      git_dir: workspace.gitDir,
      start: { kind: 'brief', text: task },
      lock: { transfer_token: null },
      limits: { max_steps: maxSteps },
    };
  }

  private createRefused(failure: RelayFailure): string {
    this.attachInstead = codexHolder(failure);
    return failureLine(failure, 'start');
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
    // An answer RAVIS never received is asked again now that it answers.
    this.approvals.reconnected();
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
    if (ENDED.has(state)) return this.finishWith(this.closingEvent());
    if (STEERABLE.has(state)) void this.deliverKept();
  }

  private toSettle(state: string): void {
    this.workWaited = true;
    const line = settleStateLine(state);
    if (line) this.sayOnce(`state:${state}`, line);
    void this.settle();
  }

  private onTurnStarted(data: Record<string, unknown>): void {
    if (typeof data.turn_id === 'string') this.activeTurn = data.turn_id;
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
    if (code === 'NOTHING_TO_SETTLE') return this.finishWith(this.closingEvent());
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
    if (!settled.ok) this.say(failureLine(settled.failure, 'during'));
    this.finishWith(this.closingEvent());
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
