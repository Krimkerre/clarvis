/**
 * The daily spend cap, as a decision rather than a side effect.
 *
 * Extracted from `FishAudioProvider` on 16 Aug, when a verification pass found that the
 * only spend guard this product actually has had no test of any kind. It could not have
 * had one where it lived: the provider imports `vscode`, and the suite runs under plain
 * `node --test` with no host, so nothing in that file is reachable from a test.
 *
 * This is the pattern `docs/CURRENT_STATE.md` prescribes for exactly that situation —
 * extract the decision, test it, leave the side effects (the `globalState` read and
 * write) in the class. Nothing here knows what a request costs, what is being spoken, or
 * where the counter is stored.
 */

/**
 * The `globalState` key holding today's request count.
 *
 * Day-keyed rather than a stored reset timestamp, so the rollover needs no timer and no
 * cleanup: yesterday's key simply stops being read. Old keys are left behind — a handful
 * of integers a year, which is cheaper than the code that would tidy them.
 *
 * **The day here is UTC**, because `toISOString()` is. See `dailyCap.test.ts` — that is
 * current behaviour, deliberately preserved by this extraction rather than quietly
 * changed, and it is a live question rather than a settled one.
 */
export function capKeyFor(now: Date): string {
  return `clarvis.voice.requests.${now.toISOString().slice(0, 10)}`;
}

/**
 * Whether another request is allowed.
 *
 * Strictly less-than, so a cap of 200 permits 200 requests and refuses the 201st — the
 * number a user types is the number they get, not one fewer.
 *
 * A cap of zero means zero, and a negative cap is treated the same way. Neither is a
 * sensible setting, but "nonsense means unlimited" is how a spend guard turns into a
 * bill: the failure of a cap must always be toward refusing, never toward spending.
 */
export function withinCap(used: number, cap: number): boolean {
  if (!Number.isFinite(cap) || cap <= 0) return false;
  return used < cap;
}
