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
  onAbort: () => T,
  /**
   * Fired the moment the deadline passes, before the abort.
   *
   * **Not the same as `onAbort`, and the difference is not obvious.** Collectors
   * swallow their own abort and return whatever text arrived, so `work` resolves
   * normally and `onAbort` never runs — which left callers unable to tell "the
   * model was too slow" from "the model finished". That distinction is the whole
   * of F14: it is what makes the character quietly falling back to written lines
   * something the product can mention rather than a fact only the log knows.
   */
  onTimeout?: () => void
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    onTimeout?.();
    controller.abort();
  }, timeoutMs);
  try {
    return await work(controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return onAbort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How much longer a model that reasons gets than a deadline written for one that answers
 * straight away.
 *
 * **Found live, 13 September 2026.** With `google/gemini-3.8-flash` through RAVIS, the opening
 * line (5 s), every interview question (6 s) and the first gap review (15 s) came back empty,
 * so each fell back to its written line. On a one-line prompt the model spent 227 of its 240
 * completion tokens thinking and showed its first word after 3.1 s; Clarvis's real prompts are
 * longer. The deadlines were written for models that start answering at once.
 *
 * Three times, not a fixed number of seconds: a 6 s question becomes 18 s and a 15 s review 45 s,
 * which keeps each deadline in proportion to the work it guards.
 */
export const REASONING_DEADLINE_FACTOR = 3;

/** A deadline written for a model that answers at once, stretched for one that thinks first. */
export function reasoningDeadline(baseMs: number): number {
  return baseMs * REASONING_DEADLINE_FACTOR;
}
