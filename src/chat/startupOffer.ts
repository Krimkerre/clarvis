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
 * the decision on its own: five inputs, one answer, no I/O.
 *
 * **And it happened a third time, which is why the handoff moved in here.** The offer
 * to pick up a task NERVIS wrote was a hand-placed `if` at the top of the method,
 * deliberately above the declined-planning guard — the position *was* the rule, and the
 * exemption it encoded existed only as a comment. Two of those have now been wrong. It
 * is an input and a branch here instead, where a test can ask about it.
 */

export interface StartupState {
  /** Whether NERVIS left a task in this workspace that nobody has answered yet. */
  nervisTaskWaiting: boolean;
  /** Whether the workspace has a `plan.md` at all. */
  planExists: boolean;
  /** Whether that plan has work in it — some milestone, somewhere, with a ticked step. */
  buildInProgress: boolean;
  /** Whether an interview was left part-way through and is still worth resuming. */
  interviewInProgress: boolean;
  /** Whether someone has already declined the offer to plan *this* workspace. */
  planningDeclined: boolean;
}

export type StartupOffer =
  | 'nervis-handoff'
  | 'resume-build'
  | 'resume-interview'
  | 'offer-planning'
  | 'nothing';

/**
 * What to say when the window opens.
 *
 * The order is the point:
 *
 *  1. **A task handed over from NERVIS comes first, and is exempt from the decline**
 *     (E-C8). Somebody typed it into a chat and pressed a button minutes ago, so it is
 *     the most specific and most recent thing anyone has asked for here — and
 *     declining *planning this project* is not an answer to *this task*. That exemption
 *     used to be a line position and a comment; it is a branch with a test now.
 *  2. **A declined offer is not re-asked**, for anything else. Someone who said no to
 *     planning this workspace does not get asked again every time the window opens —
 *     the nagging §6 exists to prevent, observed three times in one afternoon.
 *  3. **A build in progress wins**, and it needs `plan.md` to exist — which is exactly
 *     why it cannot live behind a does-the-plan-exist guard.
 *  4. **A plan with no progress is not an invitation.** Someone who approved a plan and
 *     has not started it does not need asking every time they open the window (§6).
 *  5. **A half-finished interview** is offered next, being the only remaining thing
 *     someone was actually part-way through.
 *  6. **A folder with no plan at all** gets the offer planning exists for.
 *
 * **Step 2 sitting above step 3 is preserved behaviour, not a fresh judgement.** The
 * decline guard has always run before this function, so declining planning has always
 * suppressed the resume-build offer too. Moving the guard in here keeps that exactly as
 * it was; whether a decision about *planning* should silence a build somebody is
 * part-way through is a separate question, and answering it quietly during a
 * refactor is how the two ordering bugs above got in.
 */
export function startupOffer(state: StartupState): StartupOffer {
  if (state.nervisTaskWaiting) return 'nervis-handoff';
  if (state.planningDeclined) return 'nothing';
  if (state.buildInProgress) return 'resume-build';
  if (state.planExists) return 'nothing';
  if (state.interviewInProgress) return 'resume-interview';
  return 'offer-planning';
}
