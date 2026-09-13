import { Finding } from './analysisPrompt';
import { PlanningIO, PlanningPaused } from './PlanningIO';
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
 * **Cancelling decides nothing (M9i).** Escape on any of these prompts, or Stop in the
 * chat, pauses planning: nothing is recorded for the finding, and nothing after it is
 * asked. It used to count as accepting the finding with its first fix, on the grounds that
 * silently dropping a finding the user had not actively rejected would be worse than keeping
 * it — but dropping it was never the only other choice, and keeping it wrote a decision
 * nobody made into the plan as one they had.
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
    if (!pick) throw new PlanningPaused();

    if (pick === REJECT) {
      verdicts.push(await rejection(io, finding, log));
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
    // An emptied box is no more a decision than Escape on it.
    if (!own?.trim()) throw new PlanningPaused();
    log(`planning: verdict [${finding.class}] settled the user's way — ${own.trim()}`);
    verdicts.push({ finding, status: 'modified', reasoning: own.trim() });
  }

  return verdicts;
}

/** Turning a finding down, with the reason given — or none, when the box is sent empty. Escape pauses. */
async function rejection(io: PlanningIO, finding: Finding, log: (message: string) => void): Promise<FindingVerdict> {
  const reasoning = await io.askText('Why drop this one?');
  if (reasoning === undefined) throw new PlanningPaused();
  log(`planning: verdict [${finding.class}] rejected — ${reasoning.trim() || '(no reason given)'}`);
  return { finding, status: 'rejected', reasoning: reasoning.trim() || undefined };
}

/** The first fix, in the box, editable — a starting point beats an empty prompt. */
function ownSolution(io: PlanningIO, finding: Finding): Promise<string | undefined> {
  return io.askText('What should happen instead?', undefined, finding.fixes[0] ?? finding.what);
}
