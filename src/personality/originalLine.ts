import { character, ONLY_WHAT_YOU_WERE_GIVEN } from './character';

/**
 * A line written for the moment, rather than a written one rewritten.
 *
 * **Why `phrase()` was not enough.** `Voice.say()` rewrites a fallback, and only for
 * `report` and `aside` — a question comes back verbatim by design (§2.2: a warning or
 * a question was already plain and exact, and rewriting it cost stiffness). That is
 * right for "your build failed" and wrong for the line that opens plan mode, which is
 * the first thing a new user ever hears and sounded like a template every time
 * because it *was* one.
 *
 * So this asks for the line itself, from the situation, with no draft to improve —
 * the same shape `liveQuip.ts` uses for quips, which are written fresh for exactly
 * this reason. The written line remains the fallback; nothing here can fail loudly.
 */

/** Long enough to be a sentence with a joke in it, short enough to be an opener. */
export const MAX_OPENING_LENGTH = 180;

/**
 * The instruction for one original line.
 *
 * `situation` is the facts, and only the facts — `ONLY_WHAT_YOU_WERE_GIVEN` is here
 * because this runs where nothing else about the project is known, which is the exact
 * condition under which he invents a branch name and a failing test to be funny about.
 */
export function openingPrompt(situation: string, mustAsk: boolean): string {
  return [
    character(),
    '',
    `Situation: ${situation}`,
    '',
    'Write ONE opening line for that. Rules:',
    '- One or two short sentences. Under 180 characters.',
    mustAsk
      ? '- It must end by asking them, in your own words, whether they want to. A question they can answer yes or no.'
      : '- Not a question.',
    '- Dry, understated, faintly put-upon. Have a view about it — a line that could have come from any tool is a failed line.',
    '- No greeting, no emoji, no exclamation marks, no offer of further help.',
    '- Do not name commands or files that were not given to you in the situation.',
    ONLY_WHAT_YOU_WERE_GIVEN,
    'Reply with the line alone.',
  ].join('\n');
}

/**
 * Makes a model's opening usable, or rejects it.
 *
 * Rejection is cheap here — the written line is right there and was never wrong, only
 * predictable — so anything doubtful is thrown away rather than repaired. The one
 * rule that differs from `sanitiseQuip`: a question mark is required rather than
 * forbidden, since this line's whole job is to ask something.
 */
export function acceptOpening(raw: string | undefined, mustAsk: boolean): string | undefined {
  if (!raw) return undefined;

  let text = raw.trim();

  // Models like to preface. "Here's the line:" is not the line.
  text = text.replace(/^[^:\n]{0,40}:\s*/, (match) =>
    /clarvis|line|opening|remark|response/i.test(match) ? '' : match
  );

  // Only the first paragraph: a second one is invariably an explanation of the first.
  text = text.split('\n').find((part) => part.trim())?.trim() ?? '';
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

  if (!text) return undefined;
  if (text.length > MAX_OPENING_LENGTH) return undefined;
  if (mustAsk && !text.includes('?')) return undefined;
  if (/[\p{Extended_Pictographic}]/u.test(text)) return undefined;
  if (text.includes('!')) return undefined;

  return text;
}
