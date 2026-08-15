import * as vscode from 'vscode';
import { Finding } from './analysisPrompt';
import { appendMilestone } from './planUpdate';
import { MilestoneStep } from './milestonePrompt';

/**
 * What happens to a finding once someone has decided about it.
 *
 * Two of the three answers do something, and both of them are the same act as
 * everywhere else in this product: work gets written down before it gets done.
 */

/**
 * The findings as steps in a new milestone.
 *
 * **Each finding becomes a step with a check**, because a milestone without checks is
 * the thing that produced these findings in the first place. The check is written from
 * the finding's own "why": a defect described as "chance of rain is always 0" has an
 * obvious falsifiable test, and stating it here means the fix cannot be ticked off by
 * the code merely running again.
 */
export function findingSteps(findings: readonly Finding[]): MilestoneStep[] {
  return findings.map((finding) => ({
    step: finding.fixes[0] ?? finding.what,
    check: `${finding.what} — no longer true. Prove it with a run whose output would differ if it were.`,
  }));
}

/** Writes them into `plan.md` as a milestone of their own. Returns its number. */
export async function addFindingsToPlan(
  findings: readonly Finding[],
  log: (message: string) => void
): Promise<number | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || findings.length === 0) return undefined;

  const planUri = vscode.Uri.joinPath(folder.uri, 'plan.md');
  const existing = await vscode.workspace.fs.readFile(planUri).then(
    (bytes) => Buffer.from(bytes).toString('utf8'),
    () => undefined
  );
  if (existing === undefined) return undefined;

  const updated = appendMilestone(existing, 'Fix what the read-back found', findingSteps(findings));
  if (updated === existing) return undefined;

  await vscode.workspace.fs.writeFile(planUri, Buffer.from(updated, 'utf8'));

  const number = (updated.match(/^#{2,4}\s*Milestone\s+(\d+)/gim) ?? []).length;
  log(`review: written into plan.md as milestone ${number}`);
  return number;
}

/**
 * The task for fixing them straight away.
 *
 * **Named as fixes, with the defect attached.** Handing over "fix the findings" loses
 * the half that matters — what was wrong — and a fix written without it tends to be a
 * rewrite of whatever the model remembers writing.
 */
export function fixFindingsTask(findings: readonly Finding[]): string {
  return [
    'Fix what the read-back found in the code you just wrote. Nothing else — no new',
    'features, no tidying that was not asked for.',
    '',
    ...findings.flatMap((finding) => [
      `- ${finding.what}`,
      `  Why it matters: ${finding.whyItMatters}`,
      `  Suggested fix: ${finding.fixes[0] ?? '(none given)'}`,
    ]),
    '',
    'For each one, prove it afterwards with a run whose output would have been',
    'different before the fix. A command that merely succeeds is not proof — that is',
    'the mistake that let these through in the first place.',
  ].join('\n');
}
