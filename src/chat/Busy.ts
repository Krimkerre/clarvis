import { ButlerViewProvider } from '../panels/ButlerViewProvider';
import { Activity } from '../bridge/activity';

/**
 * The one object per extension host that knows what a run is doing.
 *
 * Named here rather than written out inline at each of its four holders, which is
 * what let it drift: `activity` is the fourth thing to belong on it and the first
 * that every holder has to agree about, since §6.6 gives the Bridge exactly one
 * per host.
 */
export interface RunState {
  /** Whether an agent run is in progress. Quips and the watcher both read it. */
  running: boolean;
  /** Told about the agent's own commits, so the quips do not congratulate it. */
  noteCommit?: (hash: string) => void;
  /**
   * The same facts as a value a reader can hold (M14).
   *
   * Not a second owner: `Activity` decides nothing and is asked nothing. It is
   * written to for the same reason `running` is — one thing knows whether Clarvis
   * is busy — and the Bridge reads a *copy* of it rather than being handed this
   * object, which has `stop()` next to it.
   */
  activity: Activity;
}

/**
 * Whether Clarvis is doing something, and how to make him stop.
 *
 * **One owner, because the alternative has already failed twice.** Stop was first wired
 * to the text-stream frames, which agent runs never post — so the button was hidden for
 * the whole of every run, the one situation it exists for. Then four clicks during one
 * run produced four separate "Stopped." lines, each independently rewritten and none
 * agreeing with the others. Both were the same bug: more than one thing believed it knew
 * whether he was busy.
 *
 * So the abort controller, the panel's Stop button and the "already said that" flag live
 * together. A reply path and a run path can each `start()`, and neither has to know the
 * other exists.
 */
export class Busy {
  /** The work currently in flight, so Stop has something to abort. */
  private controller?: AbortController;

  /** Whether "Stopped." has already been said about whatever is running. */
  private announced = false;

  /** True while an agent run is in progress — a run reports its own ending. */
  private running = false;

  constructor(
    private readonly panel: ButlerViewProvider,
    /**
     * The flag the quips and the watcher read.
     *
     * Shared with the rest of the extension rather than owned here: quips keep out of
     * the way during a run (§4.6) and the watcher holds its completion toasts, and both
     * were reading this long before it had a home.
     */
    private readonly shared: RunState
  ) {}

  /**
   * Where the reported state is written.
   *
   * Public because an `AgentRunner` needs it: a gate opens deep inside a run and
   * `Busy` never hears about it, so the only way `waiting_for_approval` can ever be
   * true is for the thing that raises the modal to say so. Handing over the store
   * rather than the whole `Busy` keeps `stop()` out of the runner's reach.
   */
  get reported(): Activity {
    return this.shared.activity;
  }

  /** The same thing, spelled the way the transitions below read. */
  private get activity(): Activity {
    return this.shared.activity;
  }

  get isBusy(): boolean {
    return Boolean(this.controller) || this.shared.running;
  }

  /** Whether the thing in flight is a run, which reports its own ending. */
  get isRunning(): boolean {
    return this.shared.running;
  }

  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }

  /**
   * Begins something abortable, cancelling whatever came before it.
   *
   * A fresh controller each time: Stop must abort *this* turn, not every future one.
   */
  /**
   * `traceId` is the operation this belongs to (§11.2). Optional because two
   * call sites start work that is not a model request — a probe and a briefing
   * — and inventing a trace for them would put empty spans in the waterfall.
   */
  start(kind: 'reply' | 'run', traceId = '', sessionId = ''): AbortController {
    this.controller?.abort();
    this.controller = new AbortController();

    this.announced = false;
    if (kind === 'run') {
      this.running = true;
      this.shared.running = true;
    }
    // The one place the distinction is recorded, so a Bridge reader cannot see a
    // run and a chat turn as the same thing — and so the `'reply'`/`'run'` choice
    // at each call site is finally observable from a test.
    if (kind === 'run') this.activity.startRun(traceId, sessionId);
    else this.activity.startChat(traceId, sessionId);

    this.show(true);
    return this.controller;
  }

  /**
   * Ends it, whatever it was. Safe to call from a `finally` that may run twice.
   *
   * `outcome` exists only so the reported state can tell a run that finished from
   * one that threw. It defaults to `'ok'` because most callers leave through a
   * `finally` that cannot tell the difference, and guessing `'failed'` there would
   * report a failure for every ordinary reply.
   */
  finish(outcome: 'ok' | 'failed' = 'ok'): void {
    this.controller = undefined;

    if (this.running) {
      this.running = false;
      this.shared.running = false;
    }

    if (outcome === 'failed') this.activity.fail();
    else this.activity.finish();

    this.show(false);
  }

  /** Aborts without ending — the work's own `finally` does that. */
  stop(): void {
    // Only when there is something to stop. The button is always visible, so a
    // press with nothing running is ordinary — and reporting `stopping` for it
    // would be a state nothing ever leaves, since the `finally` that would clear
    // it belongs to work that never started.
    if (!this.controller) return;

    this.controller.abort();
    // Said before the abort has landed, because that is when it is true: the work
    // is being wound down and has not stopped yet. It is also what tells
    // `Activity.fail` that the error about to arrive is one the user asked for.
    this.activity.stopping();
  }

  /**
   * Whether this stop is the first one for the current work.
   *
   * The button is always visible and a worried user clicks it more than once. Only the
   * first press is worth a sentence; the rest abort silently.
   */
  claimAnnouncement(): boolean {
    if (this.announced) return false;

    this.announced = true;
    return true;
  }

  /**
   * Tells the panel whether there is something to stop.
   *
   * Its own signal, not inferred from text arriving — that inference is what hid the
   * button for the whole of every agent run.
   */
  show(busy: boolean): void {
    this.panel.post({ type: 'busy', busy });
  }
}
