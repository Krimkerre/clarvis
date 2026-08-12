import { ButlerViewProvider } from '../panels/ButlerViewProvider';

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
    private readonly shared: { running: boolean; noteCommit?: (hash: string) => void }
  ) {}

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
  start(kind: 'reply' | 'run'): AbortController {
    this.controller?.abort();
    this.controller = new AbortController();

    this.announced = false;
    if (kind === 'run') {
      this.running = true;
      this.shared.running = true;
    }

    this.show(true);
    return this.controller;
  }

  /** Ends it, whatever it was. Safe to call from a `finally` that may run twice. */
  finish(): void {
    this.controller = undefined;

    if (this.running) {
      this.running = false;
      this.shared.running = false;
    }

    this.show(false);
  }

  /** Aborts without ending — the work's own `finally` does that. */
  stop(): void {
    this.controller?.abort();
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
