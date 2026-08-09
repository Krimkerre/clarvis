/**
 * The interruption budget (§6): at most one unsolicited surface per minute.
 *
 * This is the number that decides whether Clarvis is a presence or a pest, so it lives
 * here with its reasoning rather than inline at a call site.
 *
 * **Lowered from ten minutes at M8a.** Ten was chosen on paper against a day of
 * imagined use; against real use it was silently eating most of what he had to say,
 * and a butler you have to wait ten minutes to hear from twice isn't a presence
 * either. A minute is short enough to keep a working session conversational and long
 * enough that a burst of activity doesn't turn into a burst of noise.
 */
export const INTERRUPTION_WINDOW_MS = 60 * 1000;

/**
 * The floor for things you actually need to know — a build going red, chiefly.
 *
 * Not exempt, just cheaper. A failure suppressed because a *success* spoke moments
 * earlier is the budget working exactly backwards: it spent the allowance on the good
 * news and swallowed the bad. But an exemption would let a flapping build machine-gun
 * notifications, so failures get their own, much shorter window instead.
 *
 * It has to stay well under the routine window to mean anything: running a passing
 * build and a failing one back to back — seconds apart, the most ordinary thing a
 * developer does — must report both.
 */
export const IMPORTANT_WINDOW_MS = 10 * 1000;

/**
 * How much a surface is worth interrupting for.
 *
 * `important` is deliberately narrow — a failure, or a repeat error you are about to
 * waste an hour on. Quips and successes are `routine`. Widening this set is how a
 * budget quietly becomes decorative.
 */
export type Priority = 'routine' | 'important';

/**
 * Decides whether an unsolicited surface is allowed right now.
 *
 * Pure function over "when did we last speak", so the budget is testable without
 * waiting ten real minutes.
 *
 * A suppressed surface is **dropped silently and never queued**. Queuing would mean
 * saving up remarks and delivering them late, out of context, which is worse than not
 * saying them: the moment has passed and the observation is stale.
 */
export function mayInterrupt(
  lastSurfaceAt: number | undefined,
  now: number,
  priority: Priority = 'routine'
): boolean {
  if (lastSurfaceAt === undefined) return true;

  const window = priority === 'important' ? IMPORTANT_WINDOW_MS : INTERRUPTION_WINDOW_MS;
  return now - lastSurfaceAt >= window;
}
