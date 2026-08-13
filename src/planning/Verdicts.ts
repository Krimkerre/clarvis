import { Finding } from './analysisPrompt';
import { PlanningIO } from './PlanningIO';
import { FindingVerdict } from './verdictSummary';

/**
 * Collects accept / reject / modify for each analysis finding (M9c — §4.9).
 *
 * Cancelling any prompt (Escape, or an unrecognised chat reply) counts as accepting
 * that finding as-is — silently dropping a finding the user didn't actively reject
 * would be worse than keeping it.
 *
 * **The whole finding is shown, not a truncated line.** Found live: a QuickPick's
 * `placeHolder` is a single line and VS Code truncated findings mid-sentence in it.
 * `confirm()` carries a `detail` that wraps, so what/why/fix all arrive intact
 * whichever front end is in use.
 */
export async function collectVerdicts(
  findings: Finding[],
  io: PlanningIO,
  log: (message: string) => void
): Promise<FindingVerdict[]> {
  const verdicts: FindingVerdict[] = [];

  for (const finding of findings) {
    const pick = await io.confirm(
      `[${finding.class}] ${finding.what}`,
      `Why it matters: ${finding.whyItMatters}\n\nSuggested fix: ${finding.suggestedResolution}`,
      ['Accept', 'Reject', 'Modify']
    );

    if (!pick || pick === 'Accept') {
      log(`planning: verdict [${finding.class}] accepted`);
      verdicts.push({ finding, status: 'accepted' });
      continue;
    }

    if (pick === 'Reject') {
      const reasoning = await io.askText('Why reject this?');
      log(`planning: verdict [${finding.class}] rejected — ${reasoning || '(no reason given)'}`);
      verdicts.push({ finding, status: 'rejected', reasoning: reasoning?.trim() || undefined });
      continue;
    }

    // The finding itself, in the box, editable — not a placeholder to retype.
    const reasoning = await io.askText('Rewrite this finding', undefined, finding.what);
    if (!reasoning?.trim()) {
      log(`planning: verdict [${finding.class}] modify cancelled, kept as-is`);
      verdicts.push({ finding, status: 'accepted' });
      continue;
    }
    log(`planning: verdict [${finding.class}] modified — ${reasoning.trim()}`);
    verdicts.push({ finding, status: 'modified', reasoning: reasoning.trim() });
  }

  return verdicts;
}
