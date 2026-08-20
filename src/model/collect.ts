import { ModelService } from './ModelService';
import { CompletionRequest } from './ModelProvider';

/**
 * Reads a stream into one string, stopping at a character limit, and swallowing only
 * its own abort.
 *
 * **The twelve lines every phrasing call in this codebase had written out by hand.**
 * Four files had it as a private `collect()` and eight more inlined it at the call
 * site, which is where the caps drifted: 40, 300, 400, 500, 800, 2000 and a shared
 * constant, with nothing saying which of those were decisions. They are decisions now,
 * because a caller has to pass one.
 *
 * **`if (!signal.aborted) throw error` is the subtle half.** `withDeadline` cancels by
 * aborting, and an aborted `for await` throws — so a collector that let that through
 * would turn every timeout into an error, and one that swallowed everything would hide
 * a real provider failure behind an empty string. Only our own abort is caught. Each
 * hand-written copy got this right; a thirteenth might not have.
 *
 * Deliberately not wrapped in `withDeadline` here: the deadlines differ per caller and
 * are theirs to choose, and `onTimeout` is how F14's "the model was too slow" is told
 * apart from "the model finished", which only the caller can act on.
 */
export async function collect(
  models: ModelService,
  request: Omit<CompletionRequest, 'model'>,
  /** Stop reading past this many characters. Omitted means read it all. */
  limit?: number
): Promise<string> {
  let text = '';

  try {
    for await (const fragment of models.stream(request)) {
      text += fragment;
      // No point streaming past the limit — the answer is already too long, and the
      // caller's parser is going to reject it either way.
      if (limit !== undefined && text.length > limit) break;
    }
  } catch (error) {
    if (!request.signal?.aborted) throw error;
  }

  return text;
}
