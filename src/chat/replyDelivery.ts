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

/**
 * The part of a finished reply that is read aloud (F20).
 *
 * **Why this is code and not a sentence in the prompt.** Five versions of `ANSWER_SHAPE`
 * tried to cap spoken length by asking — "whatever room it actually needs" became a word
 * budget, then four sentences, then three plus a clause about clauses. Measured on Haiku
 * 4.5, the scene the finding exists for read **70s, 72s, 69s and 71s** across four of
 * them, and two runs of an *unchanged* prompt varied by up to 32%, so most of the
 * apparent movement was noise. Tightening further only made the replies flatter, which
 * is §2.1's documented cost and the same trap as F18: the fix that removes the defect by
 * removing the character is not a fix.
 *
 * **The constraint was never "his answers must be short".** It is that twenty seconds is
 * all anyone wants read at them. Those are different things, and conflating them is what
 * made this a prompt problem. The panel keeps every word; only the audio is bounded.
 *
 * **First sentence, plus his own line if there is one.** `ANSWER_SHAPE` puts the answer
 * first and the line that is his last, so those two are the opening and the close by
 * construction — the substance and the voice, which are exactly the two things that must
 * survive. What is dropped is the middle, which is where the elaboration lives.
 */
export function spokenPart(text: string): string {
  const said = text.trim();
  if (!said) return said;

  // Split on sentence ends followed by a space, so "src/app.ts" and "1.5" stay whole —
  // the same reason `numberUses` stopped treating a dot as structure.
  const sentences = said.split(/(?<=[.!?])\s+/).filter((piece) => piece.trim());
  if (sentences.length <= 2) return said;

  return `${sentences[0]} ${sentences[sentences.length - 1]}`;
}
