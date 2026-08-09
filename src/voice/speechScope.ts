/**
 * What Clarvis is allowed to say out loud.
 *
 * Hard scope from §4.4: briefings, task-completion notices, and answers to questions
 * you actually asked. **Quips never speak.** A voice heckling you from the sidebar
 * crosses from charming to haunted, and it's the single fastest route to someone
 * disabling the feature permanently.
 *
 * The line is *solicited vs. unsolicited*, not "important vs. unimportant". A chat
 * reply is an answer to a question you just typed, so it can never surprise you —
 * which is the entire thing this scope exists to prevent.
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

export function mayBeSpoken(occasion: SpeechOccasion): boolean {
  return occasion === 'briefing' || occasion === 'completion' || occasion === 'chatReply';
}
