import { QuipTrigger } from './quipBank';

/**
 * Quips written for the moment, rather than drawn from a bank of fixed lines.
 *
 * The bank has five triggers and two registers — a fixed number of jokes, and
 * therefore a countdown to hearing one twice. A model can write a line about *this*
 * commit, on *this* branch, after *that* failure.
 *
 * This module is the prompt and the guard on what comes back. Both are pure, because
 * the interesting failures are all about the text: too long, quoted, explained,
 * multi-line, or a cheerful remark about a broken build.
 */

/** What the moment is, in the few facts worth writing about. */
export interface QuipContext {
  trigger: QuipTrigger;
  /** Free-form specifics: the command, the branch, the file, the count. */
  detail?: string;
  /** True once the session has earned the sharper register (§2 rule 2). */
  sharp: boolean;
}

/** Longer than this and it stops being an aside. Matches the bank's own limit. */
export const MAX_QUIP_LENGTH = 100;

const SITUATIONS: Record<QuipTrigger, string> = {
  buildSlow: 'a build has been running for an unreasonably long time',
  repeatFailure: 'the same thing has failed several times in a row',
  suiteWentGreen: 'a test suite that was failing is now passing',
  firstCommitAfterSilence: 'the user has just committed after a long stretch of not committing',
  bigDiff: 'the user has changed an enormous number of files at once',
  newBranch: "a branch has appeared that the project's written flow doesn't account for",
};

/**
 * The instruction for one line.
 *
 * States the character, the situation, and the constraints — and the constraints are
 * the load-bearing part. A model asked for "a witty remark" returns three sentences of
 * setup, a quoted punchline, and an offer to help.
 */
export function quipPrompt(context: QuipContext): string {
  return [
    'You are Clarvis, a dry, faintly exasperated butler living in a code editor.',
    `Situation: ${SITUATIONS[context.trigger]}.`,
    context.detail ? `Specifics: ${context.detail}` : '',
    '',
    'Write ONE remark about it. Rules:',
    '- One sentence. Under 100 characters. No quotation marks around it.',
    '- Dry and understated. Never enthusiastic, never cruel.',
    '- The joke is about the situation or about you, never about the user being bad at their job.',
    `- ${context.sharp ? 'You may be pointed; the session has earned it.' : 'Stay polite; nothing has gone wrong enough to warrant more.'}`,
    '- No greeting, no offer of help, no question, no emoji, no explanation of the joke.',
    'Reply with the remark alone.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Makes a model's reply usable, or rejects it.
 *
 * Returns undefined rather than a repaired mess: the bank is right there, and a canned
 * line that lands beats a generated one that needed rescuing. Every rule here comes
 * from something models actually do — wrapping in quotes, adding a preamble, answering
 * in three sentences, or appending an offer of assistance.
 */
export function sanitiseQuip(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  let text = raw.trim();

  // Models like to preface. "Here's a remark:" is not the remark.
  text = text.replace(/^[^:\n]{0,40}:\s*/, (match) =>
    /clarvis|remark|line|quip|response/i.test(match) ? '' : match
  );

  // Only the first line: a second one is invariably an explanation of the first.
  text = text.split('\n')[0].trim();

  // Surrounding quotes, straight or curly.
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

  if (!text) return undefined;
  if (text.length > MAX_QUIP_LENGTH) return undefined;

  // A question is an invitation to answer, which is not what an aside is for.
  if (text.endsWith('?')) return undefined;

  // Emoji and the exclamation-marked enthusiasm this character does not have.
  if (/[\p{Extended_Pictographic}]/u.test(text)) return undefined;
  if (/!{1,}$/.test(text) && !/\?$/.test(text)) return undefined;

  return text;
}

/**
 * The line said when a job is picked up, written for the job.
 *
 * "That reads as a job, so I picked up the tools" is fine once and wallpaper by the
 * fourth time. It is also the first thing said in every run, which makes it the single
 * most repeated sentence in the product.
 *
 * Same sanitiser as the quips, and the same fallback: an unusable line means the fixed
 * one, which was never wrong — only tired.
 */
export function acknowledgementPrompt(task: string): string {
  return [
    'You are Clarvis, a dry, faintly exasperated butler living in a code editor.',
    `The user has just asked you to do this: ${task}`,
    '',
    'Say one short line acknowledging that you are starting. Rules:',
    '- One sentence, under 80 characters. No quotation marks.',
    '- Dry and understated. You are about to do it, not delighted about it.',
    '- Refer to the actual task if it is worth referring to. Do not restate it in full.',
    '- No questions, no offers of help, no emoji, no exclamation marks.',
    'Reply with the line alone.',
  ].join('\n');
}
