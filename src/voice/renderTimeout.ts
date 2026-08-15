/**
 * How long to wait for rendered speech before giving up and using the plain voice.
 *
 * §4.4 originally specified 3s, on the reasoning that "waiting is worse than a plainer
 * voice arriving now". Measured against the real API that was wrong twice over: a
 * two-line briefing routinely takes longer than 3s to render, and **nothing is blocked
 * while we wait** — the notification has already been shown, and speech is
 * fire-and-forget. Late audio costs nothing; the wrong voice costs the feature.
 *
 * Only first-time lines pay this at all, since anything repeated comes from cache.
 *
 * **Flat was the wrong shape.** Rendering time tracks the length of the text — the
 * measured range was 900ms for a one-liner and about 5s for a paragraph — so a single
 * ceiling is either too tight for a long answer or pointlessly patient with a short
 * one. Found live: a considered four-paragraph reply to a question about unattended
 * mode aborted at exactly 15s and dropped to the system voice, while every short line
 * that session rendered in under five. The one time he had something worth saying at
 * length is the one time he lost his voice for it.
 */
const TIMEOUT_FLOOR_MS = 8_000;

/** Roughly twice the measured cost per character, so ordinary variation is not a miss. */
const TIMEOUT_PER_CHAR_MS = 15;

/**
 * The ceiling, past which waiting is worse than a plainer voice arriving now.
 *
 * Nothing is blocked while we wait, but a minute of silence after a remark is its own
 * kind of broken.
 */
const TIMEOUT_CEILING_MS = 45_000;

/** How long this particular line is worth waiting for. */
export function renderTimeout(characters: number): number {
  return Math.min(TIMEOUT_CEILING_MS, TIMEOUT_FLOOR_MS + characters * TIMEOUT_PER_CHAR_MS);
}
