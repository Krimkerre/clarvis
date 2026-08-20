/**
 * What happens to a reply once its stream has ended (F24).
 *
 * **One rule, in one place, because having it in two is what broke it.** Both reply
 * paths — the plain stream and the tool loop — ended with the same unconditional
 * `if (text) { note(); say(); }`, and neither asked whether the user had pressed
 * stop. `withModel` even logged *"stream aborted by the user"* on the line above
 * doing it. Observed 20 Aug: a typed stop produced `Stopped.` and then nineteen
 * seconds of the cancelled reply read aloud, including the model narrating the work
 * it was about to start.
 *
 * Pure and `vscode`-free so the rule is reachable from a test — the discipline F15
 * cost this project to learn.
 */

export interface ReplyDelivery {
  /** Whether to read it out. Never, once the user has asked for silence. */
  speak: boolean;
  /** The line for the log, or `undefined` when there is nothing worth recording. */
  logLine?: string;
}

/**
 * Decides what to do with whatever arrived before the stream ended.
 *
 * **The text is kept either way.** Fragments were already streamed into the panel and
 * into the live turn as they arrived, so the user has seen them; deleting them on stop
 * would be a second surprise rather than a kindness. What stops is the *speech*, which
 * is the part the user was actually asking to end — and the log says plainly that a
 * partial reply is partial, so nothing later mistakes it for a finished thought.
 */
export function afterReply(text: string, aborted: boolean): ReplyDelivery {
  const said = text.trim();
  if (!said) return { speak: false };

  if (aborted) {
    return { speak: false, logLine: `chat: stopped — kept what had arrived, said none of it aloud` };
  }

  return { speak: true };
}
