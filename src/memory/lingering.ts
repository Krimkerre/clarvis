/**
 * An error that has been sitting there long enough to be worth mentioning.
 *
 * **The third occurrence is the wrong trigger for the first mistake.** §4.2 speaks when
 * the same error has happened three times in seven days, which is the right rule for a
 * pattern and no help at all the first time — the file is broken now, and the answer
 * "come back on Thursday" is not one. Found while following a book: a deliberate syntax
 * error produced silence, correctly per the spec and uselessly for the person typing.
 *
 * The distinction that makes this not-a-linter:
 *
 *  - **A linter speaks on the keystroke.** This waits three minutes. Anything fixed
 *    inside that window was work in progress, and work in progress is nobody's business.
 *  - **A linter repeats.** This says it once per error, ever. If it is still broken
 *    twenty minutes later that is a decision, not news.
 *  - **A linter is a panel.** This goes through the same one-a-minute budget as every
 *    other unsolicited surface (§6), so it queues behind a failing build rather than
 *    talking over it.
 *
 * Pure: the timing and the wording, so both can be argued with in a test rather than
 * discovered in a session.
 */

/**
 * How long an error must survive before it is worth a word.
 *
 * Three minutes. Long enough that a half-typed line has been finished, a paste has been
 * tidied, and a rename has caught up — all of which produce errors that mean nothing.
 * Short enough to save the twenty minutes someone spends staring past a missing colon,
 * which is the entire point.
 */
export const LINGER_MS = 3 * 60_000;

/**
 * What he says about it.
 *
 * The duration is honest because *we started the clock*: nothing in the editor reports
 * when a diagnostic first appeared — §4.2 is explicit that this number cannot be made
 * true — but an error we watched arrive and re-checked three minutes later is one we
 * genuinely know the age of. It is the difference between the measured "for a few
 * minutes" and the invented "for the past six minutes" that produced the rule.
 *
 * Named at the situation, never at the person (§2 rule 4): the file has a problem, the
 * reader is not being told off for it.
 */
export function lingeringLine(file: string, line: number, message: string): string {
  return `${file} line ${line} has been unhappy for a few minutes now: ${message}`;
}
