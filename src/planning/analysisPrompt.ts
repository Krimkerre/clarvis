import { characterWith, ONLY_WHAT_YOU_WERE_GIVEN } from '../personality/character';
import { InterviewState } from './interviewTopics';

/**
 * Turning a finished interview into findings — §4.9's safety / logic / scope /
 * improvement passes — the way `interviewPrompt.ts` turns a topic into a question.
 *
 * Same split as everywhere else in this project: this is the prompt text and the
 * parser, both pure and testable without a model; `Analysis.ts` is the thin
 * `vscode`/`ModelService` glue around it, verified live.
 */

export type FindingClass = 'safety' | 'logic' | 'scope' | 'improvement';

export interface Finding {
  class: FindingClass;
  what: string;
  whyItMatters: string;
  /**
   * Ways to resolve it — one to three, most obvious first.
   *
   * **Plural because a finding usually has more than one honest answer.** "Passwords
   * are stored in plaintext" can be fixed by hashing them or by dropping accounts
   * from v1 entirely, and those are different projects. Offering one and a free-text
   * box made the second option something the user had to think of and type, which
   * favours whichever answer the model happened to name first.
   */
  fixes: string[];
}

export interface AnalysisResult {
  findings: Finding[];
  /** Set when the project is too small to need a plan at all — a legitimate result, not a failure to find anything. */
  noPlanNeeded?: string;
  /**
   * Why the review did not finish, when it did not (M9i): no model, a timeout, a failed call,
   * or a reply that was not in the review format. Absent means it finished, whatever it found —
   * which used to be the same empty list either way.
   */
  problem?: string;
}

const VALID_CLASSES: FindingClass[] = ['safety', 'logic', 'scope', 'improvement'];

/**
 * The instruction for one analysis pass over a finished interview.
 *
 * **Structured output, not prose** — the same lesson the language shortlist already
 * learned. A finding the panel can render and record a verdict against (M9c) has to
 * be parseable; a paragraph of critique is not.
 */
export function analysisPrompt(state: InterviewState): string {
  const known = state.answers
    .filter((answer) => answer.text)
    .map((answer) => `${answer.topic}: ${answer.text}`)
    .join('\n');
  const open = state.answers
    .filter((answer) => answer.text === undefined)
    .map((answer) => answer.topic)
    .join(', ');

  return [
    'Here is everything established in a project-planning interview:',
    '',
    known || '(nothing established)',
    open ? `\nStill open (recorded as "don\'t know yet"): ${open}` : '',
    '',
    'Review it for real problems in four classes:',
    '- safety: something that could hurt a user or leak/lose their data.',
    '- logic: two answers that contradict each other.',
    '- scope: something quietly bigger than what was described as v1.',
    '- improvement: a concrete way the plan could be meaningfully better, not a style opinion.',
    '',
    'Only real findings. A finding needs a genuine "why it matters" that follows from',
    'what was actually said above — do not invent a problem to fill a quota, and do not',
    'flag something already an open question.',
    '',
    'If this is so small that writing a plan would be ceremony rather than help — a',
    'throwaway script, not a real project — output exactly one line:',
    'NO-PLAN-NEEDED: <one sentence why>',
    'and nothing else.',
    '',
    'Otherwise output each finding as a block in exactly this shape, one blank line',
    'between blocks, nothing else — no intro, no summary, no markdown:',
    'class: safety|logic|scope|improvement',
    'what: <one concrete sentence>',
    'why: <one concrete sentence, grounded in what was actually said>',
    'fix: <one way to resolve it, as a short instruction — "Hash the passwords before storing">',
    'fix: <a genuinely different way, if there is one — "Drop accounts from v1 entirely">',
    '',
    'One to three `fix:` lines, most obvious first. Give a second only when it is a',
    'real alternative rather than the first one reworded — the point is a choice',
    'between different answers, and two lines saying the same thing is a false one.',
    'Keep each under about twelve words: they are shown as buttons to click.',
    '',
    // **Nothing to raise is said, not left silent (M9i).** An empty reply is also what a failed
    // call, a timeout or a broken stream produces, and every one of those used to read as a
    // clean review.
    'If there is nothing worth raising, output exactly one line and nothing else:',
    'NO-FINDINGS',
    'Zero findings is a legitimate result — never pad the list to avoid it.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/** The system prompt for an analysis pass, shared across the whole review. */
export function analysisSystemPrompt(): string {
  return characterWith(
    'You are reviewing a project-planning interview for problems worth raising before',
    'the plan is written (§4.9). You are not running the interview and must not ask a',
    'question — only report findings, in the exact structured format requested.',
    'Never invent a fact about their project. If it was not said above, you do not know it.',
    ONLY_WHAT_YOU_WERE_GIVEN
  );
}

/**
 * Parses the model's structured findings (or the `NO-PLAN-NEEDED` outcome).
 *
 * **Skips malformed blocks rather than crashing on them** — the same discipline as
 * `parseLanguageOptions`: a block missing a field, or a stray blank line, is dropped
 * rather than taken down the whole result.
 */
export function parseAnalysisResult(text: string): AnalysisResult {
  const trimmed = text.trim();
  const noPlanMatch = /^NO-PLAN-NEEDED:\s*(.+)$/im.exec(trimmed);
  if (noPlanMatch) return { findings: [], noPlanNeeded: noPlanMatch[1].trim() };

  const findings = trimmed
    .split(/\n\s*\n/)
    .map((block) => parseFindingBlock(block))
    .filter((finding): finding is Finding => finding !== undefined);

  return { findings };
}

function parseFindingBlock(block: string): Finding | undefined {
  const fields: Record<string, string> = {};
  // Every `fix:` line, not the last one to arrive — the single-value map below would
  // otherwise keep only the final alternative and silently drop the obvious one.
  const fixes: string[] = [];

  for (const line of block.split('\n')) {
    const match = /^(class|what|why|fix):\s*(.+)$/i.exec(line.trim());
    if (!match) continue;

    if (match[1].toLowerCase() === 'fix') fixes.push(match[2].trim());
    else fields[match[1].toLowerCase()] = match[2].trim();
  }

  const findingClass = fields.class?.toLowerCase() as FindingClass | undefined;
  if (!findingClass || !VALID_CLASSES.includes(findingClass)) return undefined;
  if (!fields.what || !fields.why || fixes.length === 0) return undefined;

  return { class: findingClass, what: fields.what, whyItMatters: fields.why, fixes };
}

/** A reply that says, in so many words, that there was nothing to raise. */
const NO_FINDINGS = /^NO-FINDINGS\s*$/m;

/**
 * The analysis as a result: what it found, and whether it actually finished (M9i).
 *
 * **"Found nothing" and "did not work" used to be the same empty list.** An empty reply, a
 * paragraph of prose instead of blocks, and a timeout all parsed as zero findings, and the
 * draft that followed read as reviewed. So nothing counts as a finished review unless it says
 * so: findings, `NO-PLAN-NEEDED`, or `NO-FINDINGS`. A timeout keeps what arrived — a finding
 * that parsed is still a finding — and says the review did not finish.
 */
export function readAnalysis(text: string, timedOut: boolean): AnalysisResult {
  const result = parseAnalysisResult(text);
  if (timedOut) return { ...result, problem: 'the model ran out of time' };
  if (result.noPlanNeeded || result.findings.length > 0 || NO_FINDINGS.test(text)) return result;
  return { ...result, problem: text.trim() ? 'the reply was not in the review format' : 'the model sent back nothing' };
}
