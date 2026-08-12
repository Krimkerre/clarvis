import * as vscode from 'vscode';
import { Finding } from './analysisPrompt';
import { FindingVerdict } from './verdictSummary';

/**
 * Collects accept / reject / modify for each analysis finding (M9c — §4.9).
 *
 * Same temporary front end as M9a/M9b: a chained QuickPick per finding rather than
 * the eventual panel, real and usable today without waiting on that separate piece
 * of work. Cancelling any prompt (Escape) counts as accepting that finding as-is —
 * silently dropping a finding the user didn't actively reject would be worse than
 * keeping it.
 */
export async function collectVerdicts(
  findings: Finding[],
  log: (message: string) => void
): Promise<FindingVerdict[]> {
  const verdicts: FindingVerdict[] = [];

  for (const finding of findings) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Accept', description: 'Keep this finding as-is' },
        { label: 'Reject', description: 'Say why — it gets recorded, not just dropped' },
        { label: 'Modify', description: 'Rewrite it in your own words' },
      ],
      { placeHolder: `[${finding.class}] ${finding.what}`, ignoreFocusOut: true }
    );

    if (!choice || choice.label === 'Accept') {
      log(`planning: verdict [${finding.class}] accepted`);
      verdicts.push({ finding, status: 'accepted' });
      continue;
    }

    if (choice.label === 'Reject') {
      const reasoning = await vscode.window.showInputBox({
        prompt: 'Why reject this?',
        ignoreFocusOut: true,
      });
      log(`planning: verdict [${finding.class}] rejected — ${reasoning || '(no reason given)'}`);
      verdicts.push({ finding, status: 'rejected', reasoning: reasoning?.trim() || undefined });
      continue;
    }

    const reasoning = await vscode.window.showInputBox({
      prompt: 'Rewrite this finding',
      value: finding.what,
      ignoreFocusOut: true,
    });
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
