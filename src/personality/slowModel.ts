/**
 * Noticing that the character has gone quiet because the model is too slow (F14).
 *
 * **The degradation itself is correct and stays.** A missed deadline falls back to
 * the written bank, nothing hangs and nothing errors — that is the design working.
 * What was wrong is that it happened *silently*: choose a local model, and the
 * product's central claim turns into a static bank with the only evidence in a log
 * file nobody opens. This is the telling, and nothing else — the deadlines are not
 * changed here, because scaling them per provider is M8j's job and stays deferred.
 *
 * Pure and `vscode`-free on purpose: what counts as "enough to mention" and how the
 * sentence reads are exactly the parts worth testing, and neither needs an
 * extension host to decide.
 */

/**
 * How many missed deadlines before it is worth saying something.
 *
 * **Two, because one is a blip.** A single slow response happens on any provider —
 * a cold start, a busy machine, a moment of network — and announcing it would be
 * the nagging §6 exists to prevent. Two in one session is the model being slower
 * than these deadlines rather than one unlucky call, which is the fact the user can
 * actually act on. The same reasoning as `EARNED_SASS_THRESHOLD` next door: a
 * pattern is worth remarking on, an incident is not.
 *
 * **Measured, not assumed.** LM Studio JIT-loads a model that is not resident: a
 * cold `meta-llama-3.1-8b-instruct` answered in **5.3s** on this machine, against
 * an `OPENING_DEADLINE_MS` of 5s. So the first call after switching models misses
 * its deadline on a model that is perfectly quick once warm — which is precisely
 * the false positive a threshold of one would announce every single time.
 */
export const TELL_AFTER_TIMEOUTS = 2;

/** Whether this missed deadline is the one worth mentioning. */
export function shouldTell(timeouts: number, alreadyTold: boolean): boolean {
  return !alreadyTold && timeouts >= TELL_AFTER_TIMEOUTS;
}

/**
 * What to say, once.
 *
 * States the consequence before the cause — what the user is hearing is the thing
 * they noticed, and "the model is slow" only explains it. No button: every remedy
 * (a smaller model, a faster machine, a hosted provider) is a decision only they can
 * make, and a button that could only open settings is the kind that fails on click.
 */
export function slowModelLine(label: string, model: string): string {
  return (
    `Some of what I've said today came from my written lines rather than written fresh — ` +
    `${model} on ${label} is taking longer than I wait for. Nothing is broken, and nothing ` +
    `is lost; I simply sound less like myself. A smaller or faster model gets the voice back.`
  );
}

/**
 * Counts missed deadlines for one session and says when to speak up.
 *
 * A class rather than a module-level counter so a test can have its own, and so the
 * count dies with the window — this is a fact about today's session, not something
 * to persist and re-announce tomorrow.
 */
export class SlowModelWatch {
  private timeouts = 0;
  private told = false;

  /** Records a missed deadline. Returns true exactly once, when it is worth saying. */
  missedDeadline(): boolean {
    this.timeouts += 1;
    if (!shouldTell(this.timeouts, this.told)) return false;
    this.told = true;
    return true;
  }

  /** How many deadlines have been missed this session, for the log. */
  get count(): number {
    return this.timeouts;
  }
}
