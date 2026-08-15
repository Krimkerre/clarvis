import { Finding } from '../planning/analysisPrompt';
import { characterWith } from '../personality/character';

/**
 * Reading back the code a milestone just produced.
 *
 * **The plan gets analysed; the code never did.** §4.9's analysis pass picks holes in
 * the *idea* — safety, contradictions, scope — and it is the most valuable thing in
 * planning. Nothing did the same for what got written afterwards, so a milestone was
 * finished on the strength of its own checks passing.
 *
 * Found by reading a finished project by hand. `forecast Berlin` printed "Chance of
 * rain: 0%" — always, structurally: the code matched `current.time` (`12:30`) against
 * hourly timestamps (`12:00`), never matched, and fell back to a hard `return 0`. Five
 * checks passed over it, twice against the live API, because every one of them asked
 * whether output appeared. Alongside it: an HTTP client with no timeout, in a tool
 * whose entire purpose is coping with an unreachable server; five parallel arrays
 * indexed without a length check; and a green `go test ./...` over zero test files.
 *
 * None of that is exotic, and none of it needed a human to spot — it needed *someone
 * to look*, once, at the diff rather than at the output.
 *
 * The prompt asks two questions and nothing else. Findings come back in the same shape
 * as the plan analysis, so they flow through the same parser and the same buttons.
 */

/**
 * The brief for the read-back, in his own voice.
 *
 * Same shape as the plan analysis's: a reviewer, not an interviewer, reporting in a
 * fixed format. The character is not decoration here — a finding written flatly reads
 * as boilerplate and gets skimmed, and these are the findings most worth reading.
 */
export function reviewSystemPrompt(): string {
  return characterWith(
    'You are reading back code you have just written, looking for what is wrong with it.',
    'Report findings in the exact structured format requested and ask no questions.',
    'Only what is in the diff in front of you. If it is not there, you do not know it —',
    'and a defect you cannot point at is a guess, which is worth less than nothing here.',
    'You are not marking your own homework kindly. The point of doing this at all is that',
    'the checks already passed and something got through them anyway.'
  );
}

/** Said when the code is fine, so silence is never the only signal. */
export const NOTHING_TO_REPORT = 'NOTHING-TO-REPORT';

export interface ReviewSubject {
  /** The milestone's title, for context on what this was meant to achieve. */
  milestone: string;
  /** Each step and the check that was recorded against it. */
  steps: { step: string; check?: string; result?: string }[];
  /** The diff of what the milestone actually wrote. */
  diff: string;
  /** The project's language, as the plan recorded it. */
  language?: string;
}

export function reviewPrompt(subject: ReviewSubject): string {
  return [
    `You have just finished the milestone "${subject.milestone}"${subject.language ? ` in ${subject.language}` : ''}.`,
    'Here is what you wrote, and what you reported about it. Read it as though someone',
    'else wrote it and you have been asked whether it is any good.',
    '',
    'The steps, their checks, and what you said happened:',
    ...subject.steps.map((entry) =>
      [
        `- ${entry.step}`,
        entry.check ? `  Check: ${entry.check}` : '  Check: (none was written)',
        entry.result ? `  You reported: ${entry.result}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    ),
    '',
    'The diff:',
    subject.diff,
    '',
    'Two questions, in this order.',
    '',
    // The first is the one that would have caught the constant. A model asked "is this
    // correct?" says yes about code it just wrote; asked "what would produce this
    // output while being wrong?" it has somewhere to look.
    '1. **Is any of this wrong?** Not "could be better" — wrong. A value that cannot',
    '   vary when it should, a fallback that swallows the real answer, a wait with no',
    '   bound, data indexed on an assumption nobody checked, an error discarded so the',
    '   cause is gone. Ask what would happen on the second-most-likely input rather',
    '   than the one you tested.',
    '',
    '2. **Would the check have caught it?** For each check above, ask what broken code',
    '   would still pass it. A check satisfied by output appearing is satisfied by a',
    '   constant. A test command that passes with no tests written is not a result.',
    '   If a check proves less than it appears to, that is a finding in itself.',
    '',
    'Report only what you can point at in the diff. No style opinions, no "consider',
    'adding", nothing about code that is not here. If you find nothing real, say',
    `${NOTHING_TO_REPORT} and stop — a clean read is a legitimate outcome and padding`,
    'it with something plausible costs more than saying nothing.',
    '',
    'Otherwise output each finding as a block in exactly this shape, one blank line',
    'between blocks, nothing else:',
    'class: safety|logic|scope|improvement',
    'what: <the defect, naming the file and what is wrong>',
    'why: <what goes wrong for the user, concretely>',
    'fix: <one way to resolve it, as a short instruction>',
    'fix: <a genuinely different way, if there is one>',
    '',
    'Use `logic` for output that is wrong, `safety` for what can hang, crash or lose',
    'data, `scope` for work the milestone claimed and did not do, and `improvement`',
    'for the rest. Most severe first.',
  ].join('\n');
}

/** How the findings are said in chat, before anyone decides what to do about them. */
export function reviewSummary(findings: Finding[]): string {
  if (findings.length === 0) return 'I read back what I wrote and found nothing worth raising.';

  const worst = findings.filter((finding) => finding.class === 'logic' || finding.class === 'safety').length;

  return [
    `I read back what I wrote. ${findings.length} thing${findings.length === 1 ? '' : 's'} worth raising`,
    worst > 0 ? `, ${worst} of them wrong rather than untidy` : '',
    ':',
  ].join('');
}
