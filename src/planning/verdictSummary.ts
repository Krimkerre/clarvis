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
