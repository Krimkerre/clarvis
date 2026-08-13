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
  suggestedResolution: string;
}

export interface AnalysisResult {
  findings: Finding[];
  /** Set when the project is too small to need a plan at all — a legitimate result, not a failure to find anything. */
  noPlanNeeded?: string;
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
    'fix: <one concrete sentence>',
    '',
    'Zero findings is a legitimate result too — output nothing rather than pad the list.',
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
  for (const line of block.split('\n')) {
    const match = /^(class|what|why|fix):\s*(.+)$/i.exec(line.trim());
    if (match) fields[match[1].toLowerCase()] = match[2].trim();
  }

  const findingClass = fields.class?.toLowerCase() as FindingClass | undefined;
  if (!findingClass || !VALID_CLASSES.includes(findingClass)) return undefined;
  if (!fields.what || !fields.why || !fields.fix) return undefined;

  return { class: findingClass, what: fields.what, whyItMatters: fields.why, suggestedResolution: fields.fix };
}
