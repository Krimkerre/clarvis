/**
 * What Clarvis is doing, as a value rather than as a set of live controllers.
 *
 * This is M14's read-only seam, and it exists for three reasons that turned out
 * to be the same reason.
 *
 * **The Bridge must not be able to act.** `CLARVIS.md` §6.7 forbids NERVIS
 * resolving a gate, invoking a tool, expanding the workspace root or reading
 * SecretStorage. Handing the Bridge `Busy`, `BusyTracker` or `AgentRunner` would
 * make that a rule somebody has to remember, because every one of those objects
 * has acting methods and most of them hold `vscode.ExtensionContext` — whose
 * `.secrets` is the credential store. Handing it *this* makes it structural:
 * there is nothing here to call.
 *
 * **Nothing that knows the state is testable.** `Busy` imports
 * `ButlerViewProvider`, which imports `vscode`, and the 1,022-test fast suite
 * never imports `vscode`. So the flag that says whether a run is in progress
 * could be dead for months without a single test noticing — which is exactly
 * what happened. This module imports nothing at all.
 *
 * **Unknown has to be representable.** §6.3: *"Unknown values stay unknown.
 * Never invent a duration, step total, branch, task or model route."* A field
 * that is absent here means nobody knows, and every optional field below is
 * optional for that reason rather than for convenience.
 */

import { randomBytes } from 'crypto';

/** §6.3's interpreted states, and the whole set. */
export type ActivityState =
  | 'idle'
  | 'chatting'
  | 'agent_running'
  | 'waiting_for_approval'
  | 'stopping'
  | 'failed';

/**
 * What a reader is told. Deliberately flat and made only of primitives — a
 * nested object is somewhere a live reference could hide, and this type is the
 * boundary that keeps one out.
 */
export interface ActivitySnapshot {
  readonly state: ActivityState;
  /**
   * Opaque id of the run or turn in flight, when there is one.
   *
   * **Minted here, never supplied.** §6.3 calls it an opaque ID, and the only
   * way that stays true is for no caller to be able to choose it: an id a caller
   * passes is an id that can be a task description, a command, or a path, and it
   * would then be the one free-form string in a payload that is otherwise
   * incapable of carrying any of those.
   */
  readonly activity_id?: string;
  /**
   * Steps taken so far, *only when genuinely counted*. §6.3 forbids inventing a
   * step total, so there is no `steps_total` here at all: the agent loop does
   * not know one in advance, and a field for it would be filled with a guess by
   * the first person who wanted a progress bar.
   */
  readonly steps_taken?: number;
  /** Milliseconds since this state began, when a clock was actually read. */
  readonly elapsed_ms?: number;
  /**
   * Why the state is `waiting_for_approval`, as a category — never the command
   * string, the path, or the question put to the user. §6.4 forbids all three,
   * and a gate's text is the most tempting of them.
   */
  readonly awaiting?: 'command' | 'sensitive_read' | 'step' | 'other';
}

/** A clock, injected so a test can hold it still. */
export type Clock = () => number;

/**
 * A fresh id for one run or turn.
 *
 * Sixteen hex characters of randomness and nothing derived: enough that two
 * activities in one window cannot collide, and carrying no information about
 * what the activity is. Deliberately not a counter — a counter tells a reader
 * how many runs this window has had, which is not a fact anybody asked to
 * publish.
 */
const opaqueId = (): string => randomBytes(8).toString('hex');

/**
 * One transition, for whoever wants to publish it.
 *
 * Carries `from` as well as `to` because most of §6.4's event names are about the
 * *edge* rather than the state: `agent_running` reached from `idle` is a run
 * starting and reached from `waiting_for_approval` is a gate being answered, and
 * a listener given only the destination cannot tell those apart.
 *
 * `kind` is here for the one thing the states cannot say. A run that is stopped
 * passes through `stopping` and lands on `idle`, and by then nothing in the state
 * remembers whether it was a run or a chat turn that ended — so §6.4's
 * `clarvis.agent.cancelled` and `clarvis.chat.cancelled` would be a coin toss.
 */
export interface ActivityChange {
  readonly from: ActivityState;
  readonly to: ActivityState;
  readonly kind: 'chat' | 'run' | undefined;
  /**
   * The operation this change belongs to, or '' when none is in flight.
   *
   * Carried on the change rather than looked up later because §11.2 joins a
   * waterfall on it: an event published without the trace is a bar that cannot
   * be placed beside the RAVIS call it caused.
   */
  readonly traceId: string;
  /**
   * The model session the operation's requests carry, or '' when it has none —
   * a Codex run, or a change outside any operation (runbook §4.3).
   */
  readonly sessionId: string;
  readonly snapshot: ActivitySnapshot;
}

/**
 * One model request, as §6.4's `clarvis.model.*` describes it.
 *
 * **Its own trace and session, never the activity's.** A title or a voice check
 * can be asked for while an agent run is in flight, and filing it under the run's
 * trace would put a request the run never made into the run's waterfall. The ids
 * are the ones the request itself carried, empty when it carried none.
 */
export interface ModelNote {
  readonly kind: 'model';
  readonly phase: 'requested' | 'completed' | 'failed';
  readonly role: 'chat' | 'agent';
  /** The provider's id from `providers.ts` — never its address. */
  readonly provider: string;
  readonly model: string;
  /** The `x-request-id` the request was sent with. */
  readonly requestId: string;
  readonly traceId: string;
  readonly sessionId: string;
  /** From the request being made to its stream ending, measured. */
  readonly elapsedMs?: number;
  /** From the request being made to the first thing it streamed, when anything came. */
  readonly firstOutputMs?: number;
  readonly textChunks?: number;
  readonly toolCalls?: number;
  /**
   * How it ended. `cancelled` is a stop — not a failure, the same rule `fail()`
   * keeps — and `closed` is a reader that stopped reading before the stream ended.
   */
  readonly result?: 'answered' | 'cancelled' | 'closed' | 'error';
  /** For a failure: whether trying again could plausibly work. Never the reason. */
  readonly retryable?: boolean;
}

/**
 * One tool call, as §6.4's `clarvis.tool.*` describes it: which tool, never its
 * arguments — a path, a command and a search pattern are all forbidden payload.
 */
export interface ToolNote {
  readonly kind: 'tool';
  readonly phase: 'started' | 'completed' | 'failed' | 'refused';
  /** A name from the tool registry, or `unknown` for one a model made up. */
  readonly tool: string;
  readonly writes?: boolean;
  /** This call's number in the run, as the transcript numbers it. */
  readonly call?: number;
  readonly elapsedMs?: number;
  /**
   * The call put a question to the user. **Such a call ends as `completed`
   * whichever way it went**: `failed` straight after a gate would say the user
   * refused, which is the one thing `clarvis.gate.resolved` is built not to say.
   */
  readonly asked?: boolean;
  /** Why a call never ran, as a category. */
  readonly reason?: 'unknown_tool' | 'invalid_arguments' | 'project_taken';
}

/**
 * How a tool call that ran is published as ending. One that asked the user is
 * `completed` whichever way it went — see `ToolNote.asked`.
 */
export function toolEnding(isError: boolean | undefined, asked: boolean): 'completed' | 'failed' {
  return isError && !asked ? 'failed' : 'completed';
}

/** The editor's problem counts (§6.3's aggregate diagnostic counts) — counts only, no file. */
export interface ProblemsNote {
  readonly kind: 'problems';
  readonly errors: number;
  readonly warnings: number;
  readonly information: number;
  readonly hints: number;
  /** How many files have at least one problem. */
  readonly files: number;
}

/**
 * A task NERVIS handed over (§6.4's `clarvis.task.*`, the owner's decision of 16 Sep 2026): its id and
 * where it has got to. `started` is said again each time the stage changes — picked up and planning,
 * building, paused between runs — and `completed` once, when the whole plan is built.
 */
export interface TaskNote {
  readonly kind: 'task';
  readonly phase: 'started' | 'completed';
  readonly taskId: string;
  readonly stage?: 'planning' | 'building' | 'paused';
  readonly outcome?: 'built';
}

/** How a build or test run in the editor ended: exit 0, anything else, or no exit code at all. */
export type CheckResult = 'passed' | 'failed' | 'unknown';

/**
 * What `/v1/status` reports beside the state (§6.3's list, Clarvis 0.17.15): the editor's problem
 * counts, the last build and test run, the last model request, and the task handed over. Flat
 * primitives, each absent until it is known — §6.3's "unknown values stay unknown".
 */
export interface StatusFacts {
  readonly diagnostics_errors?: number;
  readonly diagnostics_warnings?: number;
  readonly diagnostics_information?: number;
  readonly diagnostics_hints?: number;
  readonly diagnostics_files?: number;
  readonly build_result?: CheckResult;
  readonly build_finished_at?: string;
  readonly test_result?: CheckResult;
  readonly test_finished_at?: string;
  /** The `x-request-id` of the last model request — the reference to RAVIS's route decision for it. */
  readonly last_request_id?: string;
  readonly last_request_model?: string;
  readonly last_request_provider?: string;
  /** How it ended; absent while it is still in flight. */
  readonly last_request_result?: string;
  readonly task_id?: string;
  readonly task_stage?: string;
}

type Facts = { -readonly [K in keyof StatusFacts]: StatusFacts[K] };

/** Something that happened inside Clarvis without changing its state. */
export type ActivityNote = ModelNote | ToolNote | ProblemsNote | TaskNote;

/** A note, with the operation it belongs to. */
export interface NoteChange {
  readonly note: ActivityNote;
  readonly traceId: string;
  readonly sessionId: string;
}

/** Keeps the latest of each kind of note for the status. Nothing here can fail. */
function remember(facts: Facts, note: ActivityNote): void {
  if (note.kind === 'model') return rememberRequest(facts, note);
  if (note.kind === 'problems') return rememberProblems(facts, note);
  if (note.kind === 'task') rememberTask(facts, note);
}

function rememberRequest(facts: Facts, note: ModelNote): void {
  facts.last_request_id = note.requestId;
  facts.last_request_model = note.model;
  facts.last_request_provider = note.provider;
  facts.last_request_result = note.phase === 'requested' ? undefined : note.result;
}

function rememberProblems(facts: Facts, note: ProblemsNote): void {
  facts.diagnostics_errors = note.errors;
  facts.diagnostics_warnings = note.warnings;
  facts.diagnostics_information = note.information;
  facts.diagnostics_hints = note.hints;
  facts.diagnostics_files = note.files;
}

/** A finished task is no longer the current one. */
function rememberTask(facts: Facts, note: TaskNote): void {
  facts.task_id = note.phase === 'completed' ? undefined : note.taskId;
  facts.task_stage = note.phase === 'completed' ? undefined : note.stage;
}

/**
 * A note with the operation it belongs to. A task spans many operations and a problem count none, so
 * neither names one.
 */
function noteChange(note: ActivityNote, traceId: string, sessionId: string): NoteChange {
  if (note.kind === 'model') return { note, traceId: note.traceId, sessionId: note.sessionId };
  if (note.kind === 'tool') return { note, traceId, sessionId };
  return { note, traceId: '', sessionId: '' };
}

/**
 * The store. One per extension host, owned by the extension and handed to the
 * Bridge as a reader.
 *
 * Every transition is a plain assignment. There is no queue, no async, and no
 * failure path, because telemetry state must never be able to delay or fail
 * editor work — `CLARVIS.md` §6.5 says so about tracing and it is the same rule.
 */
export class Activity {
  private current: ActivityState = 'idle';
  private id?: string;
  private steps?: number;
  private awaiting?: ActivitySnapshot['awaiting'];
  private since: number;
  /** What is in flight, in the terms §6.4's event families are named in. */
  private kind?: 'chat' | 'run';
  /** The trace the current operation belongs to; cleared when it ends. */
  private traceId = '';
  /** The model session its requests carry, set with the trace. */
  private sessionId = '';
  private readonly observers = new Set<(change: ActivityChange) => void>();
  private readonly noteObservers = new Set<(change: NoteChange) => void>();
  /** Every gate ever opened here, so a tool call can tell whether it asked one. */
  private gates = 0;
  /** The latest of each note and check, for `/v1/status`. */
  private readonly facts: Facts = {};

  constructor(private readonly now: Clock = Date.now) {
    this.since = now();
  }

  /**
   * A chat turn began. Distinct from a run: §6.3 lists `chatting` and
   * `agent_running` separately because one edits files and the other does not,
   * and an operator glancing at a dashboard is entitled to that distinction.
   */
  startChat(traceId = '', sessionId = ''): void {
    this.traceId = traceId;
    this.sessionId = sessionId;
    this.kind = 'chat';
    this.enter('chatting', opaqueId());
  }

  /** An agent run began — the one that writes files. */
  /**
   * Name the operation already in flight.
   *
   * Two routes start a run — the palette and the panel — and both begin the
   * activity before `AgentRunner` mints the trace its steps will share. Rather
   * than thread an id through both call sites, the runner names it once it has
   * one, and the completion event carries it either way.
   */
  noteTrace(traceId: string, sessionId = ''): void {
    this.traceId = traceId;
    if (sessionId) this.sessionId = sessionId;
  }

  startRun(traceId = '', sessionId = ''): void {
    this.traceId = traceId;
    this.sessionId = sessionId;
    this.kind = 'run';
    this.enter('agent_running', opaqueId());
    this.steps = 0;
  }

  /**
   * Watch every transition.
   *
   * Separate from `snapshot()` because polling cannot see an edge: a gate opened
   * and answered between two reads leaves no trace in the state, and it is
   * exactly the thing §6.7 says NERVIS may be shown.
   *
   * An observer that throws is dropped rather than allowed to propagate. This is
   * called from inside editor work, and §6.5 is unambiguous that telemetry must
   * never delay or fail it.
   */
  observe(observer: (change: ActivityChange) => void): () => void {
    this.observers.add(observer);
    return () => this.observers.delete(observer);
  }

  /**
   * Watch what happens without changing the state: model requests, tool calls,
   * problem counts. A separate channel from `observe`, because none of these is
   * an edge between §6.3's states, and `eventFor` reads every change as one.
   */
  observeNotes(observer: (change: NoteChange) => void): () => void {
    this.noteObservers.add(observer);
    return () => this.noteObservers.delete(observer);
  }

  /**
   * Tell the note observers, and never let one of them reach the caller — the same
   * rule as `announce`, for the same reason.
   *
   * A tool call happens inside the operation in flight, so it takes that
   * operation's trace; a model request names its own (see `ModelNote`).
   */
  note(note: ActivityNote): void {
    remember(this.facts, note);
    if (this.noteObservers.size === 0) return;
    const change = noteChange(note, this.traceId, this.sessionId);
    for (const observer of [...this.noteObservers]) {
      try {
        observer(change);
      } catch {
        this.noteObservers.delete(observer);
      }
    }
  }

  /** A build or test run in the editor ended (a VS Code task in the Build or Test group). */
  recordCheck(kind: 'build' | 'test', result: CheckResult, finishedAt: string): void {
    this.facts[`${kind}_result`] = result;
    this.facts[`${kind}_finished_at`] = finishedAt;
  }

  /** What `/v1/status` adds to the state. A fresh object each time. */
  statusFacts(): StatusFacts {
    return { ...this.facts };
  }

  /** How many gates have opened in this host, so a caller can tell whether its work asked one. */
  get gatesOpened(): number {
    return this.gates;
  }

  /**
   * One agent step completed. Counted rather than estimated, and only ever
   * incremented from a real step boundary.
   */
  noteStep(): void {
    if (this.current !== 'agent_running') return;
    this.steps = (this.steps ?? 0) + 1;
    // Published as a transition from `agent_running` to itself: a step is an
    // event without being a change of state, and §6.4 lists `clarvis.agent.step`
    // separately from the states for that reason.
    this.announce('agent_running');
  }

  /**
   * A gate is open and the user is being asked. `CLARVIS.md` §6.7 permits NERVIS
   * to display *the fact that* a gate awaits — and nothing more, which is why
   * this takes a category and not the question.
   *
   * The previous state is remembered so resolving returns to it: a gate inside a
   * run is an interruption of that run, and reporting `idle` afterwards would
   * say the run had ended.
   */
  awaitApproval(kind: NonNullable<ActivitySnapshot['awaiting']>): void {
    const from = this.current;
    this.gates += 1;
    if (this.current !== 'waiting_for_approval') this.resumeTo = this.current;
    this.awaiting = kind;
    this.current = 'waiting_for_approval';
    this.since = this.now();
    this.announce(from);
  }

  /** The gate was answered, either way. What the user chose is not recorded here. */
  resolveApproval(): void {
    if (this.current !== 'waiting_for_approval') return;
    this.awaiting = undefined;
    this.current = this.resumeTo ?? 'idle';
    this.resumeTo = undefined;
    this.since = this.now();
    this.announce('waiting_for_approval');
  }

  /** A stop was asked for and is being honoured. */
  stopping(): void {
    this.enter('stopping', this.id);
  }

  /** Whatever was in flight ended without a reported failure. */
  finish(): void {
    const from = this.current;
    this.current = 'idle';
    this.since = this.now();
    this.resumeTo = undefined;
    this.id = undefined;
    this.steps = undefined;
    this.announce(from);
    // Cleared after the announcement, not before: the listener is being told what
    // ended, and by definition that is the kind which is on its way out.
    this.kind = undefined;
  }

  /**
   * It ended badly. No reason is carried: a failure reason is composed from the
   * thing that failed — a command, a path, a model response — and §6.4 forbids
   * every one of those leaving the machine.
   *
   * **A stop is not a failure.** An aborted run leaves through the same `finally`
   * as a crashed one and looks identical from there — the abort surfaces as a
   * thrown error, so the caller would have to know it asked for the stop in order
   * to report it correctly. It does not, and would get that wrong. So the state
   * that already knows decides: once `stopping()` has been called, the run ends
   * quietly, because the user pressing Stop got exactly what they asked for.
   */
  fail(): void {
    if (this.current === 'stopping') {
      this.finish();
      return;
    }
    const from = this.current;
    this.current = 'failed';
    this.since = this.now();
    this.resumeTo = undefined;
    this.steps = undefined;
    this.announce(from);
    this.kind = undefined;
  }

  /** What a reader sees. A fresh object each time, holding only primitives. */
  snapshot(): ActivitySnapshot {
    const snapshot: {
      -readonly [K in keyof ActivitySnapshot]: ActivitySnapshot[K];
    } = { state: this.current };
    if (this.id !== undefined) snapshot.activity_id = this.id;
    if (this.steps !== undefined) snapshot.steps_taken = this.steps;
    if (this.awaiting !== undefined) snapshot.awaiting = this.awaiting;
    // Measured, never estimated: this is the difference between the clock this
    // object was given and the moment the state began, and nothing else.
    snapshot.elapsed_ms = Math.max(0, this.now() - this.since);
    return snapshot;
  }

  private resumeTo?: ActivityState;

  private enter(state: ActivityState, activityId?: string): void {
    const from = this.current;
    this.current = state;
    this.since = this.now();
    this.resumeTo = undefined;
    if (activityId !== undefined) this.id = activityId;
    this.announce(from);
  }

  /**
   * Tell the observers, and never let one of them reach the caller.
   *
   * The snapshot is taken once and shared, which is safe because it is already a
   * fresh flat object of primitives — the property that made it publishable in
   * the first place is the same one that makes it safe to hand to several
   * listeners.
   */
  private announce(from: ActivityState): void {
    if (this.observers.size === 0) return;
    const change: ActivityChange = {
      from,
      to: this.current,
      kind: this.kind,
      // Read before any transition clears it, so the *end* of an operation
      // still names the trace it belonged to — the completion event is half
      // the span, and a span with only a start has no duration.
      traceId: this.traceId,
      sessionId: this.sessionId,
      snapshot: this.snapshot(),
    };
    for (const observer of [...this.observers]) {
      try {
        observer(change);
      } catch {
        this.observers.delete(observer);
      }
    }
  }
}

/**
 * Runs a gate with the wait made visible, whichever way the gate ends.
 *
 * Lives here rather than beside the three modals it wraps, because the part that
 * must not be forgotten is the *un*-marking: a gate left open in the reported
 * state after the user has answered it is a run that looks stuck forever, and the
 * `finally` that prevents it belongs somewhere a test can reach. `AgentRunner`
 * imports `vscode`, so nothing in the fast suite can reach it there.
 *
 * `activity` is optional because a runner that answers to nobody is a real case.
 *
 * `PromiseLike<T> | T` rather than `Promise<T>`: every VS Code dialog returns a
 * `Thenable`, which is structurally a `PromiseLike` — spelled the standard-library
 * way here because `Thenable` is a `vscode` type and this module imports nothing.
 */
export async function whileAwaiting<T>(
  activity: Activity | undefined,
  kind: NonNullable<ActivitySnapshot['awaiting']>,
  ask: () => PromiseLike<T> | T
): Promise<T> {
  activity?.awaitApproval(kind);
  try {
    return await ask();
  } finally {
    activity?.resolveApproval();
  }
}
