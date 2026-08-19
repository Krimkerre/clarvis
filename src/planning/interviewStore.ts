import { InterviewState, readyToDraft } from './interviewTopics';

/**
 * An interview that outlives the window it was started in.
 *
 * §4.9 asked for this from the beginning and M9a shipped without it: answer four
 * questions, reload, and all four were gone. An interview is two minutes of someone's
 * attention, and losing it to a window reload teaches people not to start one.
 *
 * The storage itself is the caller's (`workspaceState`); this is the shape and the
 * rules about what is worth keeping.
 */

export interface InterviewSnapshot {
  seed: string;
  state: InterviewState;
  /** When it was last touched, so a stale one can be described honestly. */
  at: number;
}

/** Where a half-finished interview lives. Workspace-scoped: a plan is about *this* project. */
export const INTERVIEW_KEY = 'clarvis.planning.interview';

/**
 * How long a half-finished interview is worth offering back.
 *
 * A week. Long enough to survive a weekend and a distraction; short enough that
 * "carry on where we left off" never means an interview about a project the user has
 * genuinely forgotten starting.
 */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a snapshot is worth offering back.
 *
 * **Not every interruption is worth resuming.** One answer in is barely an interview —
 * offering to resume it costs more attention than retyping the sentence.
 *
 * A *finished* one very much is worth resuming, which this used to assume otherwise
 * about. Between the last question and the plan being written sit the analysis, the
 * findings the user ruled on one by one, and the draft itself; reloading there lost all
 * of it and asked for the eight answers again. Resuming a complete interview costs
 * nothing, because `runInterview` breaks out immediately when there is nothing left to
 * ask.
 */
export function worthResuming(snapshot: InterviewSnapshot | undefined, now: number): boolean {
  if (!snapshot?.seed) return false;
  if (now - snapshot.at > STALE_AFTER_MS) return false;

  // The seed itself is one answer, and it is recorded as `what-it-does`. Two or more
  // means they actually got somewhere.
  return snapshot.state.answers.length >= 2;
}

/**
 * How far in they got, for the line that offers to carry on.
 *
 * A complete interview is described as complete rather than counted. "Ego Refill — 8
 * questions in" is true and useless: it reads as though there are more to come, when what
 * is actually waiting is the plan itself.
 */
export function describeProgress(snapshot: InterviewSnapshot): string {
  const name = snapshot.state.projectName ?? snapshot.seed;
  if (readyToDraft(snapshot.state)) return `${name} — all answered, no plan written yet`;

  const answered = snapshot.state.answers.filter((answer) => answer.text).length;
  return `${name} — ${answered} question${answered === 1 ? '' : 's'} in`;
}

/**
 * Reads a snapshot back, rejecting anything that is not one.
 *
 * Stored JSON outlives the code that wrote it: a shape change, a half-written value,
 * or a user editing their workspace state by hand all arrive here, and none of them
 * should be able to crash a window on startup.
 */
export function parseSnapshot(stored: unknown): InterviewSnapshot | undefined {
  if (!stored || typeof stored !== 'object') return undefined;

  const candidate = stored as Partial<InterviewSnapshot>;
  if (typeof candidate.seed !== 'string' || typeof candidate.at !== 'number') return undefined;
  if (!candidate.state || !Array.isArray(candidate.state.answers)) return undefined;

  return { seed: candidate.seed, state: candidate.state, at: candidate.at };
}

/**
 * Whether planning reached an outcome, and the saved interview can be dropped.
 *
 * The plan was written, or there was no plan to write. **A draft the user walked away
 * from is not an outcome** — the same rule the resume offer already holds to, where
 * Escape means "not now" and never "delete it".
 */
export function planningIsSettled(approved: boolean, noPlanNeeded: string | undefined): boolean {
  return approved || Boolean(noPlanNeeded);
}
