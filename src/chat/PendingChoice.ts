import { nudgeDelay, nudgeLine } from './waitingNudge';

/**
 * One question in the chat panel, waiting for the next thing the user says.
 *
 * **Modelled on `PlanningChatIO`, which has held exactly this for the whole
 * interview** — a promise resolved by the next message, with buttons offered
 * alongside. Step approval needed the same thing, and the alternative was a fourth
 * near-identical waiting flag in `ChatService`, which is the shape that already made
 * that file hard to follow.
 *
 * `PlanningChatIO` has **not** been moved onto this yet, so the mechanism does exist
 * twice for now. That is deliberate rather than overlooked: the interview is being
 * run end to end this week for the first time, and the M8 refactor is on record for
 * introducing a bug that 411 tests did not catch. It gets collapsed once the
 * first-run checklist is through, not during it.
 *
 * A message arriving with nobody waiting is dropped rather than queued: queueing
 * would silently answer a *later* question with an earlier message.
 */
export class PendingChoice {
  private waiting?: (answer: string | undefined) => void;
  private offered: string[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    /** Puts the buttons in the panel, and clears them with an empty list. */
    private readonly offer: (items: { label: string; detail?: string }[]) => void,
    /**
     * Says something out loud when the question has gone unanswered.
     *
     * Optional, because not every caller of this is blocking a build — and the ones
     * that are not have no business talking to an empty room.
     */
    private readonly nudge?: (line: string) => void
  ) {}

  /** Whether an answer is expected right now. Chat checks this before routing. */
  get isWaiting(): boolean {
    return this.waiting !== undefined;
  }

  /**
   * Asks, and resolves with the chosen label — or with whatever was typed instead.
   *
   * Typing has to keep working: the buttons are the fast path, not the only one, and
   * someone answering "no, do the other thing" is saying something the buttons could
   * not have offered.
   */
  ask(options: { label: string; detail?: string }[], about?: string): Promise<string | undefined> {
    // A second question while one is pending would leave the first hanging forever.
    this.cancel();
    this.offered = options.map((option) => option.label);
    this.offer(options);
    if (about && this.nudge) this.startNudging(about);

    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /**
   * Speaks up while nobody answers, then stops.
   *
   * Chained rather than repeating on an interval: each delay is longer than the last,
   * and the chain ends itself once `nudgeDelay` runs out of attempts.
   */
  private startNudging(about: string, attempt = 1): void {
    const delay = nudgeDelay(attempt);
    if (delay === undefined) return;

    this.timer = setTimeout(() => {
      // Answered between the timer firing and this running: say nothing.
      if (!this.waiting) return;
      this.nudge?.(nudgeLine(attempt, about));
      this.startNudging(about, attempt + 1);
    }, delay);
  }

  /** Stops the reminders — on an answer, on a cancel, and on the way to a new question. */
  private stopNudging(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Hands the user's message to the question waiting for it. */
  supply(answer: string): void {
    const waiting = this.waiting;
    if (!waiting) return;

    this.waiting = undefined;
    this.stopNudging();
    this.offer([]);
    waiting(this.match(answer));
  }

  /**
   * Abandons the question in flight.
   *
   * Resolves as `undefined` rather than leaving the promise hanging — every caller
   * treats that as "no answer", so cancelling unwinds through paths that exist.
   */
  cancel(): void {
    const waiting = this.waiting;
    if (!waiting) return;

    this.waiting = undefined;
    this.stopNudging();
    this.offer([]);
    waiting(undefined);
  }

  /**
   * The label the user meant, or their own words.
   *
   * Numbers work because the panel used to render options as a numbered list and
   * people still type "1"; case-insensitive matching because "do it" and "Do it" are
   * the same answer and refusing one of them would be pedantry.
   */
  private match(answer: string): string {
    const trimmed = answer.trim();

    const byNumber = Number.parseInt(trimmed, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= this.offered.length) {
      return this.offered[byNumber - 1];
    }

    return this.offered.find((label) => label.toLowerCase() === trimmed.toLowerCase()) ?? trimmed;
  }
}
