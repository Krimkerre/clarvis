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

/**
 * Long enough for two sentences with a joke in one of them, short enough to be an
 * opener. Raised twice on evidence: 180, then 240, both of which rejected real
 * lines that were fine. A model asked for two sentences writes two sentences, and
 * the cap is a backstop against a paragraph, not a style rule.
 */
export const MAX_OPENING_LENGTH = 320;

/**
 * How a question opens, when it forgot to close with a mark.
 *
 * Anchored to the *start* of the last sentence, past up to two leading fillers and
 * whatever punctuation they bring ("Right then — what are you building"). Two
 * narrowings, both from a test that caught them: matching anywhere in the sentence
 * turned "There is no plan in this project." into a question on its `is`, and
 * allowing *any* leading word did the same via "There". The filler list is closed
 * for exactly that reason.
 *
 * Found live: "…or I could walk you through what's actually supposed to happen here.
 * Would the second one help." — a perfectly good offer, rejected for ending in a
 * full stop. Repairing the punctuation changes no words, which is the only reason
 * this is repair rather than rejection.
 */
const INTERROGATIVE =
  /^\W*(?:(?:so|or|and|well|right|now|then|but|ok|okay|fine)[,\s—–-]+){0,2}(shall|would|want|should|do|does|did|can|could|are|will|how|what|why|which|who|ready)\b/i;

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
    '- One or two short sentences, and no more. Under 200 characters.',
    mustAsk
      ? '- It must end by asking them, in your own words, whether they want to — a question they can answer yes or no, ending in a question mark.'
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

  // **All of it, joined — not the first line.** The prompt asks for up to two
  // sentences and models routinely put the second on its own line, so keeping only
  // the first threw away the half with the question in it and the whole line was
  // then rejected for not asking anything. Found live: rejected every time.
  text = text
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ');
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

  if (!text) return undefined;
  if (text.length > MAX_OPENING_LENGTH) return undefined;
  if (mustAsk) {
    const asked = ensureQuestion(text);
    if (!asked) return undefined;
    text = asked;
  }
  if (/[\p{Extended_Pictographic}]/u.test(text)) return undefined;
  if (text.includes('!')) return undefined;

  return text;
}

/**
 * The line as a question, or `undefined` if it never was one.
 *
 * Only the final mark is touched — a line that asks nothing at all is still
 * rejected, because inventing the question would be putting words in his mouth.
 */
function ensureQuestion(text: string): string | undefined {
  if (text.includes('?')) return text;

  // **The last clause, not only the last sentence.** His most natural construction
  // puts the question at the end of a longer line — "…or we could write them down
  // once—shall we do that." — where there is no sentence break before the question
  // at all, so testing the sentence tested "We could spend the next month…" and
  // rejected every line of that shape. Found live, twice.
  const lastSentence = text.split(/(?<=[.!?])\s+/).pop() ?? text;
  const lastClause = lastSentence.split(/[,;—–-]+\s*/).pop() ?? lastSentence;

  if (!INTERROGATIVE.test(lastSentence) && !INTERROGATIVE.test(lastClause)) return undefined;

  return text.replace(/\.?$/, '?');
}
