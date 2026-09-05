import { GateVerdict, mayEscapeConfinement } from './Gate';

/**
 * What a gated command does next, given the verdict and what the user said.
 *
 * **The branch nothing could reach.** `Gate.ts`'s classification is tested nine ways,
 * and so is `explainGate`'s wording — but the decision that *acts* on them lived inside
 * `AgentRunner.runGated`, a private method on a class that imports `vscode`, so no test
 * under `node --test` could get near it. What was covered was which commands are
 * dangerous and how that is phrased; what was not covered was whether saying no stops
 * the command. That is the half the gate exists for.
 *
 * Separating it is not only for the test. Three inputs decide four outcomes, and read
 * inline they were spread across two `if`s, a reassignment and a later refusal check —
 * with the sandbox's absence changing the meaning of the answer halfway through.
 */

/** What the person was asked, and what they chose. */
export type GateAnswer = 'approved' | 'unconfined' | 'refused';

export interface GateOutcome {
  /** Whether the command runs at all. */
  run: boolean;
  /** Whether it runs inside the sandbox. Meaningless when `run` is false. */
  confined: boolean;
  /**
   * Whether this is a deliberate step *out* of a sandbox that was standing.
   *
   * Distinct from `!confined`, which is also true on a machine that has no sandbox at
   * all — and those two want opposite handling: one has been permitted by the person
   * in front of the modal, the other has permitted nothing and still owes them the
   * separate question about running unconfined.
   */
  escapes: boolean;
  /**
   * What the model is told when it does not run.
   *
   * Addressed to the model rather than to the user, and phrased to stop a retry: an
   * agent told only "that failed" tries again, which turns one refusal into a loop of
   * modal dialogs — the failure mode that makes people approve things to make the
   * dialogs stop.
   */
  toldTheModel?: string;
}

/**
 * The whole decision, in one place.
 *
 * `verdict` absent means the command was never gated — nothing classified it as
 * dangerous, so it runs under whatever confinement the machine offers.
 */
export function gateOutcome(
  verdict: GateVerdict | undefined,
  answer: GateAnswer | undefined,
  sandboxConfined: boolean
): GateOutcome {
  // Ungated: the ordinary case, and the one that must not be made conditional on an
  // answer nobody was asked for.
  if (!verdict) return { run: true, confined: sandboxConfined, escapes: false };

  if (answer === 'refused') {
    return {
      run: false,
      confined: sandboxConfined,
      escapes: false,
      toldTheModel: "The user declined that command. Don't retry it — find another way, or ask.",
    };
  }

  // **Stepping out is only on offer where there is something to step out of.** A
  // machine with no sandbox confines nothing, so "run it unconfined" is not a
  // concession the user can make — every command is already unconfined, and treating
  // the answer as one would silently skip the separate refusal that case has.
  if (answer === 'unconfined' && sandboxConfined && mayEscapeConfinement(verdict)) {
    return { run: true, confined: false, escapes: true };
  }

  return { run: true, confined: sandboxConfined, escapes: false };
}
