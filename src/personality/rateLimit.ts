/**
 * The interruption budget (§6): at most one unsolicited surface per ten minutes.
 *
 * This is the number that decides whether Clarvis is a presence or a pest, so it lives
 * here with its reasoning rather than inline at a call site.
 */
export const INTERRUPTION_WINDOW_MS = 10 * 60 * 1000;

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
export function mayInterrupt(lastSurfaceAt: number | undefined, now: number): boolean {
  if (lastSurfaceAt === undefined) return true;
  return now - lastSurfaceAt >= INTERRUPTION_WINDOW_MS;
}
