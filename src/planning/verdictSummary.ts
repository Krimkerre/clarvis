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
    return [
      `- **[${finding.class}]** ${reasoning ?? finding.what}`,
      `  Why it matters: ${finding.whyItMatters}`,
      `  Suggested fix: ${finding.suggestedResolution}`,
    ];
  }

  return [
    `- **[${finding.class}]** ${finding.what}`,
    `  Why it matters: ${finding.whyItMatters}`,
    `  Suggested fix: ${finding.suggestedResolution}`,
  ];
}
