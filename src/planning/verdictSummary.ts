import { Finding } from './analysisPrompt';

/**
 * A user's decision on one analysis finding (M9c — §4.9).
 *
 * **Rejections carry a reason, not just a no.** §4.9 is explicit that the decision
 * record is the point — a later session should see *why* a finding was turned down,
 * not just that it was, or planning will re-raise the same settled question.
 */
export type VerdictStatus = 'accepted' | 'rejected' | 'modified';

export interface FindingVerdict {
  finding: Finding;
  status: VerdictStatus;
  /** The rejection reason, or the user's replacement text for a modified finding. */
  reasoning?: string;
  /**
   * Which of the finding's fixes was clicked.
   *
   * Only meaningful when accepted, and absent when the finding offered one fix and it
   * was taken by default — `agreedResolution` falls back to the first for exactly that
   * case, so nothing has to record "the obvious one" explicitly.
   */
  chosenFix?: string;
}

/**
 * What was actually agreed for one finding, in the user's terms.
 *
 * **One definition, because there were four.** Plan, handoff, milestone prompt and
 * summary each carried their own copy of "the user's wording wins for a modified
 * finding, otherwise the suggested fix", and adding a chosen-fix case would have meant
 * getting the same three-way rule right in four files — the sort of near-duplication
 * that goes stale in three of them.
 */
export function agreedResolution(verdict: FindingVerdict): string {
  if (verdict.status === 'modified') return verdict.reasoning ?? verdict.finding.what;
  return verdict.chosenFix ?? verdict.finding.fixes[0] ?? verdict.finding.what;
}

/**
 * A finding the user turned down, as the one line the milestone planner needs.
 *
 * **F5, found live on 19 Aug.** The user rejected a finding about file format with *"no
 * separate file, embed compliments in script"*, and three seconds later the first step of
 * the first milestone was *"Create a compliments data file with 30 entries"*, checked by
 * asserting that file existed. The rejection was recorded and then ignored.
 *
 * The cause was a filter: rejected verdicts were dropped before milestone generation ever
 * saw them, so the model planned from the interview alone — and the interview's `data`
 * answer *had* said the compliments would live in a file. The user's later correction
 * never reached it.
 *
 * So the reason travels, and it is worth being clear about what it is. **A rejection
 * reason is frequently not a reason but a decision** — "no separate file, embed them in
 * the script" is an instruction, given later than the answer it overrides. Dropping it
 * loses a decision; keeping it as prose lets the model weigh it against what came before.
 */
export function rejectionNote(verdict: FindingVerdict): string {
  const why = verdict.reasoning?.trim();
  return why
    ? `${verdict.finding.what} — turned down, because: ${why}`
    : `${verdict.finding.what} — turned down, no reason given`;
}

/**
 * Renders one verdict as the lines it contributes to the plan/summary.
 *
 * Pure and separate from `Verdicts.ts` for the same reason `interviewPrompt.ts` is
 * separate from `Interview.ts`: this is the part worth testing without a QuickPick.
 *
 * **A modified finding shows the user's version, not Clarvis's original** — §4.9's
 * own exit checklist calls this out by name, so the original text is dropped
 * entirely rather than kept alongside the edit.
 */
export function formatVerdict(verdict: FindingVerdict): string[] {
  const { finding, status, reasoning } = verdict;

  if (status === 'rejected') {
    return [
      `- ~~**[${finding.class}]** ${finding.what}~~ — rejected`,
      `  Reason: ${reasoning ?? '(no reason given)'}`,
    ];
  }

  if (status === 'modified') {
    // Why-it-matters and suggested-fix are Clarvis's take on the *original* wording —
    // stale the moment the user rewrites it, and confusing rather than useful once
    // they no longer describe the same finding. Found live: a finding modified to
    // "ESLint" still showed the original "name a linter" fix underneath it.
    return [`- **[${finding.class}]** ${reasoning ?? finding.what}`];
  }

  return [
    `- **[${finding.class}]** ${finding.what}`,
    `  Why it matters: ${finding.whyItMatters}`,
    // The one that was picked, not the whole menu: the alternatives were a question,
    // and the answer is what the plan should carry.
    `  Fix: ${agreedResolution(verdict)}`,
  ];
}
