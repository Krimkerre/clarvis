/**
 * Runs a timed unit of work against a real deadline, and actually cancels it
 * when the deadline wins — rather than merely walking away from it (F23).
 *
 * **The bug this replaces.** Every phrasing call in this codebase raced a model
 * stream against a `setTimeout` with `Promise.race`, and losing that race only
 * stopped the *caller* waiting — the `for await` loop reading the stream kept
 * running underneath, uncancelled, because nothing ever called `AbortController.abort()`.
 * The request stayed open and the model kept generating, on every provider including
 * paid ones, for as long as it took the response to finish on its own — observed
 * live as several minutes of a local model sitting at `GENERATING` with nothing in
 * the log, well after Clarvis had told the user it gave up and moved on. That is not
 * "spend is the provider's console" (M8h's own position) — it is spend nobody, not
 * even the provider's own dashboard read at the moment, would think to still be
 * running.
 *
 * `onAbort` gets whatever partial result the caller has accumulated by the time the
 * deadline fires, preserving the original behaviour (a timeout keeps partial text
 * rather than discarding it) — only the cancellation is new.
 */
export async function withDeadline<T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
  onAbort: () => T
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return onAbort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
