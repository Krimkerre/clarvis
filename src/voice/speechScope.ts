/**
 * What Clarvis is allowed to say out loud.
 *
 * Hard scope from §4.4: briefings and task-completion notices only. **Quips never
 * speak.** A voice heckling you from the sidebar crosses from charming to haunted, and
 * it's the single fastest route to someone disabling the feature permanently.
 *
 * Pure, and separate from the delivery machinery, so the scope is a rule that can be
 * tested rather than an `if` buried in a notification handler.
 */
export type SpeechOccasion = 'briefing' | 'completion' | 'quip' | 'patternHit';

export function mayBeSpoken(occasion: SpeechOccasion): boolean {
  return occasion === 'briefing' || occasion === 'completion';
}
