/**
 * Which of the three "where we left off" offers a window opens with.
 *
 * **Because the ordering has now been wrong twice, in the same file, for the same
 * reason.** The resume-build offer was written to fire "before anything else" and was
 * placed *after* a guard that returns when `plan.md` exists — and a build in progress
 * always has a `plan.md`, so it could never run at all. The interview-resume offer had
 * the mirror-image problem: it was reachable, but only after the user had agreed to
 * plan something.
 *
 * Both were one line in the wrong place inside a long method, and neither was visible
 * to a test, because the method needs a workspace, a panel and a model to run. This is
 * the decision on its own: four inputs, one answer, no I/O.
 */

export interface StartupState {
  /** Whether the workspace has a `plan.md` at all. */
  planExists: boolean;
  /** Whether that plan has work in it — some milestone, somewhere, with a ticked step. */
  buildInProgress: boolean;
  /** Whether an interview was left part-way through and is still worth resuming. */
  interviewInProgress: boolean;
}

export type StartupOffer = 'resume-build' | 'resume-interview' | 'offer-planning' | 'nothing';

/**
 * What to say when the window opens.
 *
 * The order is the point:
 *
 *  1. **A build in progress wins**, and it needs `plan.md` to exist — which is exactly
 *     why it cannot live behind a does-the-plan-exist guard.
 *  2. **A plan with no progress is not an invitation.** Someone who approved a plan and
 *     has not started it does not need asking every time they open the window (§6).
 *  3. **A half-finished interview** is offered next, being the only remaining thing
 *     someone was actually part-way through.
 *  4. **A folder with no plan at all** gets the offer planning exists for.
 */
export function startupOffer(state: StartupState): StartupOffer {
  if (state.buildInProgress) return 'resume-build';
  if (state.planExists) return 'nothing';
  if (state.interviewInProgress) return 'resume-interview';
  return 'offer-planning';
}
