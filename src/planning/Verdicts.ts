import { Finding } from './analysisPrompt';
import { PlanningIO } from './PlanningIO';
import { FindingVerdict } from './verdictSummary';

/** The escape hatch, offered on every finding. */
const OTHER = 'Something else';

/** Turning the finding down entirely, which is not one of its fixes. */
const REJECT = 'No, drop this';

/**
 * Collects a decision on each analysis finding (M9c — §4.9).
 *
 * **The fixes are the buttons.** A finding usually has more than one honest answer —
 * "passwords are stored in plaintext" is settled by hashing them *or* by dropping
 * accounts from v1, and those are different projects. The old shape offered Accept /
 * Reject / Modify against a single suggested fix, which made the first fix the model
 * happened to name the default and every alternative something the user had to think
 * of and type. Found live: fixes arrived phrased as "Either tie the reset to a manual
 * trigger, or establish how the system learns when rent has been paid" — two options
 * already, presented as one paragraph behind an Accept button.
 *
 * So each fix is its own button, `Something else` covers the answer Clarvis didn't
 * think of, and nothing has to be typed to choose between the ones he did.
 *
 * Cancelling any prompt (Escape, or an unrecognised chat reply) counts as accepting
 * the finding with its first fix — silently dropping a finding the user didn't
 * actively reject would be worse than keeping it.
 *
 * **The whole finding is shown, not a truncated line.** Found live: a QuickPick's
 * `placeHolder` is a single line and VS Code truncated findings mid-sentence in it.
 * `confirm()` carries a `detail` that wraps, so what and why arrive intact whichever
 * front end is in use.
 */
export async function collectVerdicts(
  findings: Finding[],
  io: PlanningIO,
  log: (message: string) => void
): Promise<FindingVerdict[]> {
  const verdicts: FindingVerdict[] = [];

  for (const finding of findings) {
    const pick = await io.confirm(`[${finding.class}] ${finding.what}`, `Why it matters: ${finding.whyItMatters}`, [
      ...finding.fixes,
      OTHER,
      REJECT,
    ]);

    if (!pick) {
      log(`planning: verdict [${finding.class}] accepted (no answer) — ${finding.fixes[0]}`);
      verdicts.push({ finding, status: 'accepted' });
      continue;
    }

    if (pick === REJECT) {
      const reasoning = await io.askText('Why drop this one?');
      log(`planning: verdict [${finding.class}] rejected — ${reasoning || '(no reason given)'}`);
      verdicts.push({ finding, status: 'rejected', reasoning: reasoning?.trim() || undefined });
      continue;
    }

    const chosen = finding.fixes.find((fix) => fix === pick);
    if (chosen) {
      log(`planning: verdict [${finding.class}] accepted — ${chosen}`);
      verdicts.push({ finding, status: 'accepted', chosenFix: chosen });
      continue;
    }

    // Either `Something else` was clicked, or an answer was typed rather than picked —
    // both mean the same thing, and the typed one is already the answer, so asking for
    // it again would be Clarvis not listening.
    const own = pick === OTHER ? await ownSolution(io, finding) : pick;
    if (!own?.trim()) {
      log(`planning: verdict [${finding.class}] own-solution cancelled, kept as-is`);
      verdicts.push({ finding, status: 'accepted' });
      continue;
    }
    log(`planning: verdict [${finding.class}] settled the user's way — ${own.trim()}`);
    verdicts.push({ finding, status: 'modified', reasoning: own.trim() });
  }

  return verdicts;
}

/** The first fix, in the box, editable — a starting point beats an empty prompt. */
function ownSolution(io: PlanningIO, finding: Finding): Promise<string | undefined> {
  return io.askText('What should happen instead?', undefined, finding.fixes[0] ?? finding.what);
}
