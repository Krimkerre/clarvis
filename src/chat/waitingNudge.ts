/**
 * How long to leave a question standing before saying something out loud.
 *
 * **A blocked run is worse than an interruption.** Step approval parks the whole build
 * until someone answers, and the panel may not be the window they are looking at — so
 * a question nobody noticed costs the run, not a moment. Found while running the
 * checklist: the interesting failure is not a wrong answer, it is no answer.
 *
 * Spoken rather than written, because the entire point is reaching someone who is not
 * reading the panel.
 */

/** The first nudge waits this long. Short enough to save a build, long enough not to hover. */
const FIRST_MS = 45_000;

/** Each later one waits longer, so walking away is not punished with a metronome. */
const BACKOFF = 2;

/**
 * How many times to speak up before giving up.
 *
 * **Three, and then silence.** Someone who has not answered in five minutes has left
 * the desk, and a voice repeating itself into an empty room is the behaviour that gets
 * a product uninstalled. The question stays open — the run is still parked and still
 * answerable — Clarvis simply stops asking about it.
 */
const MAX_NUDGES = 3;

/**
 * The delay before nudge number `attempt` (1-based), or `undefined` once they are done.
 *
 * 45s, then 90s, then 180s — five and a quarter minutes of total patience, spent in
 * three increasingly spaced-out reminders rather than in one long silence.
 */
export function nudgeDelay(attempt: number): number | undefined {
  if (attempt < 1 || attempt > MAX_NUDGES) return undefined;
  return FIRST_MS * BACKOFF ** (attempt - 1);
}

/**
 * What to say, given how long this has been sitting there.
 *
 * Escalating in *content* rather than in volume: the first is a nudge, the second says
 * what is actually stuck, the third says the consequence. None of them is cross —
 * §2 rule 4 holds, and the situation is nobody's fault.
 *
 * A fallback bank rather than a model call: the model may be the thing that is
 * blocked, and a nudge that has to wait for a request is not a nudge.
 */
export function nudgeLine(attempt: number, question: string): string {
  if (attempt <= 1) return `Still waiting on you: ${question}`;
  if (attempt === 2) return `That question is still open, and the build is parked behind it: ${question}`;
  return `Nothing has moved for a few minutes now. I will stop asking, but the run is still waiting: ${question}`;
}
