import * as vscode from 'vscode';
import { Finding } from './analysisPrompt';
import { FindingVerdict } from './verdictSummary';

/**
 * Collects accept / reject / modify for each analysis finding (M9c — §4.9).
 *
 * Same temporary front end as M9a/M9b: chained dialogs per finding rather than the
 * eventual panel, real and usable today without waiting on that separate piece of
 * work. Cancelling any prompt (Escape) counts as accepting that finding as-is —
 * silently dropping a finding the user didn't actively reject would be worse than
 * keeping it.
 *
 * **A modal message, not a QuickPick.** Found live: a QuickPick's `placeHolder` is a
 * single line, and a finding's `what` alone routinely ran past it — unreadable,
 * truncated by VS Code itself before this project's own 400-char bug ever entered
 * into it. A modal's `detail` wraps and shows the full finding — what, why it
 * matters, and the suggested fix — before asking for a decision.
 */
export async function collectVerdicts(
  findings: Finding[],
  log: (message: string) => void
): Promise<FindingVerdict[]> {
  const verdicts: FindingVerdict[] = [];

  for (const finding of findings) {
    const pick = await vscode.window.showInformationMessage(
      `[${finding.class}] ${finding.what}`,
      {
        modal: true,
        detail: `Why it matters: ${finding.whyItMatters}\n\nSuggested fix: ${finding.suggestedResolution}`,
      },
      'Accept',
      'Reject',
      'Modify'
    );

    if (!pick || pick === 'Accept') {
      log(`planning: verdict [${finding.class}] accepted`);
      verdicts.push({ finding, status: 'accepted' });
      continue;
    }

    if (pick === 'Reject') {
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
