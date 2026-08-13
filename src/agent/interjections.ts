/**
 * Turning what the user said mid-run into the next message the model reads.
 *
 * Pure and apart from `AgentRunner` for the usual reason: the wording is the whole
 * feature — it decides whether an interruption reads as a correction or as an
 * afterthought — and testing it should not require an extension host.
 */

/**
 * The interruption, framed so it outranks the plan already in flight.
 *
 * **Priority has to be stated.** Arriving as one more user message among tool
 * results, an interruption reads as extra context rather than a change of course,
 * and a model will finish what it was doing before addressing it — which is exactly
 * the behaviour the user interrupted to prevent.
 *
 * Returns an empty string for an empty queue, so the caller can pass it straight to
 * a message whose real payload is the tool results.
 */
export function interjectionMessage(said: readonly string[]): string {
  if (said.length === 0) return '';

  return [
    'The user interrupted to say this. It takes priority over the plan you were',
    'following — adjust what you are doing rather than finishing the old way first,',
    'and say what you changed:',
    ...said.map((line) => `- ${line}`),
  ].join('\n');
}
