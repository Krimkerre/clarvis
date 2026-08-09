/**
 * What Clarvis is allowed to say out loud.
 *
 * Everything Clarvis says may now be spoken, including quips and pattern hits.
 *
 * **This deliberately reverses §4.4's original rule** that quips stay silent. That
 * rule was protecting against volume, and it was solving that problem in the wrong
 * place: the thing that stops a voice becoming exhausting is *how often he speaks at
 * all*, which the §6 interruption budget already governs — one unsolicited surface
 * per ten minutes, shared across M3's notices, M5's pattern hits and M6's quips. A
 * remark that has already earned its way past that budget is one worth hearing, and
 * silencing it only in audio meant the voice carried the dull half of his character
 * and the text carried the funny half.
 *
 * The escape hatches are unchanged and are what make this safe: voice is off by
 * default, Mute silences him instantly mid-sentence, and the budget is untouched.
 *
 * Pure, and separate from the delivery machinery, so the scope is a rule that can be
 * tested rather than an `if` buried in a notification handler.
 */
export type SpeechOccasion =
  | 'briefing'
  | 'completion'
  | 'chatReply'
  | 'quip'
  | 'patternHit';

export function mayBeSpoken(_occasion: SpeechOccasion): boolean {
  return true;
}
