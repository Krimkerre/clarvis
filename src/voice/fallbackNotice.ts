/**
 * What to say when the good voice is not the one speaking.
 *
 * A separate, `vscode`-free module for the reason `docs/CURRENT_STATE.md` gives:
 * a fix inside a file that imports `vscode` at module scope cannot be reached by
 * `node --test`, and this repository has already shipped one such fix that was
 * reviewed by reading and did not work.
 *
 * The bug this exists for was an empty branch. `VoiceService` warned when the
 * preferred provider *threw* and said nothing at all when it simply reported
 * itself unavailable — so a missing key produced the system voice in silence,
 * and the only way to learn why was to guess. Surfaced in code-server, where
 * SecretStorage is a different store from desktop VS Code's, but it was never
 * code-server's bug: the same silence happens on the desktop the moment a key is
 * absent.
 */

/** Why the Fish Audio voice cannot be used right now, or `''` when it can. */
export function fishUnavailableReason(hasKey: boolean, withinDailyCap: boolean): string {
  // **Ordered: no key beats spent cap.** Without a key the cap has never been
  // consumed, so reporting the cap would be both wrong and unactionable.
  if (!hasKey) return 'no Fish Audio key is stored for this editor';
  if (!withinDailyCap) return "today's Fish Audio request cap is used up";
  return '';
}

/**
 * The one sentence the user sees, at most once a session (§4.4).
 *
 * Takes the reason rather than stating one. The old text — "the preferred voice
 * is unavailable" — told somebody nothing they had not already worked out from
 * hearing the wrong voice, and the two real causes want opposite responses: one
 * wants a key entered, the other wants waiting or a higher cap.
 *
 * `providerId` is the fallback only when the provider could not say why, which
 * happens when it threw rather than declining.
 */
export function fallbackNotice(reason: string, providerId: string): string {
  const because = reason || `the ${providerId} voice is unavailable`;
  return `Clarvis: ${because}, so I'm using the system voice for now.`;
}

/** The log line, which is written every time rather than once. */
export function fallbackLogLine(providerId: string, reason: string): string {
  // Logged per utterance on purpose: the cause does not change while a session
  // runs, and the log is where somebody debugging actually looks — whereas §4.4
  // allows exactly one toast, which they may well have dismissed.
  return `voice: ${providerId} is unavailable${reason ? ` (${reason})` : ''}; using the system voice`;
}
