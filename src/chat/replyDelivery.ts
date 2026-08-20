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
 * Roughly how long a line takes to say.
 *
 * Speech runs near 150 words a minute, so this is deliberately crude — it only has to
 * make "that is too long" obvious. It lived in `voiceCheck.ts` until 20 Aug, which meant
 * the debug tool owned a threshold the product needed; the check imports it from here
 * now, so the number the report flags and the number the voice acts on cannot drift.
 */
export function spokenSeconds(text: string): number {
  return Math.round((text.trim().split(/\s+/).length / 150) * 60);
}

/**
 * The point where a spoken reply has outstayed its welcome.
 *
 * Two sentences and an aside runs to about fifteen seconds. Twenty allows for a long one;
 * past that it is a paragraph being read at someone, and §9's seventh criterion — *keeps
 * him running for a week and doesn't mute him* — is what a paragraph read aloud costs.
 */
export const SPOKEN_CEILING_SECONDS = 20;

/**
 * What is read aloud when a reply runs past the ceiling (F20).
 *
 * **Under the ceiling, nothing changes** — he says the whole thing, which is the case
 * that was never broken. Past it, the voice gets the **opening sentence and his closing
 * line**: the answer and the character, with the elaboration between them left on screen.
 *
 * **Why the pair rather than the line alone.** The first version spoke only part 2, and
 * two things were wrong with it. A coda heard cold answers nothing — *"Everything else is
 * logistics."* — and a four-word fragment gives a speech renderer nothing to build a
 * contour from, so the delivery goes flat. Same voice, same settings, a quarter of the
 * material. Two sentences carry both the sense and the intonation, and still come in
 * around ten seconds.
 *
 * **Why the first and last specifically.** `ANSWER_SHAPE` puts the answer first and
 * requires part 2 to be his own — an opinion, a jab, something he noticed — and puts it
 * last. So those two positions are the substance and the voice by construction, and the
 * middle is where a point gets made a second and third time.
 *
 * **Why this is code and not a shorter prompt.** Six versions of `ANSWER_SHAPE` tried to
 * cap length by asking, and the effect proved smaller than the noise: one scene returned
 * 36s, 44s and 84s on three takes of the *same* prompt. Tightening also cost the
 * character, because the long replies contain no padding — they are good lines making one
 * point from several angles — so trimming quantity trims the thing worth keeping. This
 * bounds the audio and leaves the writing alone.
 */
export function spokenPart(text: string): string {
  const said = text.trim();
  if (spokenSeconds(said) <= SPOKEN_CEILING_SECONDS) return said;

  // Split on sentence ends followed by a space, so `src/app.ts` and `1.5` stay whole.
  const sentences = said.split(/(?<=[.!?])\s+/).filter((piece) => piece.trim());

  // A single sentence over the ceiling has no line to fall back to, and cutting one in
  // half is worse than reading it. He gets to finish it.
  if (sentences.length <= 1) return said;

  const last = sentences[sentences.length - 1];
  const pair = `${sentences[0]} ${last}`;

  // The pair when it fits, his line alone when it does not — never a third sentence, and
  // never half of one.
  return spokenSeconds(pair) <= SPOKEN_CEILING_SECONDS ? pair : last;
}
