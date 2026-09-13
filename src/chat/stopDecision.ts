/**
 * What Stop does when a question is on screen.
 *
 * **Reported 11 September 2026: Stop did not release a waiting question.** With "Do it /
 * Skip this step" in the panel, Stop aborted the run's signal and nothing else — the run
 * stayed parked on the unanswered question, the buttons stayed, and the stop only took
 * effect once someone answered. Over "fold this into master?" it was worse: that is asked
 * after the run has finished, so Stop found nothing busy, said "Nothing to stop", and
 * left the question up.
 *
 * Pulled out of `AgentRunner` and `ChatService`, which both import `vscode`, so the two
 * decisions the fix rests on can be checked under `node --test`.
 */

/** What a gated step does once its question has come back. */
export type StepAfterAsking = 'run' | 'skip' | 'stop';

/**
 * Whether the step goes ahead, is skipped, or the run ends here.
 *
 * **Stop wins over the answer, whatever it was.** A "Do it" that raced the stop must not
 * start the step — the stop was the instruction. And a stop is not a decline: telling the
 * model "the user declined that step", and writing "Skipped" into the chat, would describe
 * something that did not happen.
 */
export function stepAfterAsking(approved: boolean, stopped: boolean): StepAfterAsking {
  if (stopped) return 'stop';
  return approved ? 'run' : 'skip';
}

/**
 * What the chat says about a stop.
 *
 * `silent` when a run is in progress: the run reports its own ending, and saying it here
 * as well is how two disagreeing "Stopped." lines happened. `paused` when a planning
 * sitting is under way.
 */
export type StopReply = 'nothing to stop' | 'stopped' | 'silent' | 'paused';

/**
 * What Stop says, given what it found.
 *
 * **A question left waiting counts as something to stop**, with or without a run in
 * progress — "Nothing to stop" said over a question's buttons is simply false.
 *
 * **Planning pauses (M9i).** It is never busy in `Busy`'s sense — no answer streaming, no run
 * going — so a stop typed while a model worked out its next question fell through to "Nothing
 * to stop", and planning asked that question a moment later.
 */
export function stopReply(state: { busy: boolean; waiting: boolean; runWillSayIt: boolean; planning?: boolean }): StopReply {
  if (state.planning) return 'paused';
  if (!state.busy && !state.waiting) return 'nothing to stop';
  return state.runWillSayIt ? 'silent' : 'stopped';
}
