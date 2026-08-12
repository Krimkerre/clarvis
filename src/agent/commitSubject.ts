/**
 * The commit subject for an agent run.
 *
 * Pure and `vscode`-free, like every other decision in this project that is worth
 * testing — it was briefly a method on AgentRunner, which made it untestable the
 * moment a test tried to import it.
 */

/** Stock closing words. Fine conversation, useless in a history. */
const EMPTY_CLOSERS = /^(done|fixed( it)?|sure|ok(ay)?|there you go)[.!]?$/i;

/** Below this, a "summary" is a reaction rather than a description. */
const MIN_USEFUL_LENGTH = 15;

/**
 * What the model said, unless it said nothing useful.
 *
 * Models close with "Done." constantly. The task text is a worse sentence but a better
 * record, so it wins whenever the narration has no content in it.
 */
export function commitSubject(narration: string, task: string): string {
  const first = narration
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const useless = !first || first.length < MIN_USEFUL_LENGTH || EMPTY_CLOSERS.test(first);
  return (useless ? task : first).slice(0, 72);
}
