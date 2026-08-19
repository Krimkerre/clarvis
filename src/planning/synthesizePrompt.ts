import { TOPIC_BRIEF } from './interviewPrompt';
import { TopicId } from './interviewTopics';

/**
 * Combining an answer and its one follow-up into a single coherent statement.
 *
 * Found live: gluing the follow-up onto the original answer as
 * `"${original}\n\nFollow-up — ${question}\n${answer}"` produced exactly the
 * copy-pasted transcript look the plan is supposed to read cleaner than — labels and
 * all, right there in `plan.md`. This rewrites the pair as prose instead, using only
 * what was actually said — same discipline as everywhere else in this project, only
 * applied to merging two answers rather than to not inventing new ones.
 */
export function synthesizeAnswerPrompt(
  topic: TopicId,
  original: string,
  followUpQuestion: string,
  followUpAnswer: string
): string {
  return [
    `Topic: ${TOPIC_BRIEF[topic]}`,
    '',
    `They first said: "${original}"`,
    `Asked to clarify — "${followUpQuestion}" — they said: "${followUpAnswer}"`,
    '',
    'Rewrite this as ONE coherent statement combining both answers — plain prose, not',
    'a transcript, not a Q&A. Use only what was actually said above; do not add,',
    'infer, or invent any detail neither answer contains. If the two answers cover',
    'different aspects, just state both plainly in one or two sentences.',
    '',
    'Write it as a statement about the project, not about the person who answered:',
    '"The tool runs locally", never "They want it to run locally". It is going into a',
    'plan document, where a sentence about what someone wants reads as hearsay.',
    'The first answer is already settled. Keep what it establishes, whatever the',
    'follow-up turned out to be about. If the follow-up wandered onto a different',
    'subject, state both — never drop the first to describe the second.',
    'Only if the FOLLOW-UP left its own question hanging may you say that part',
    'remains open, and never about anything the first answer already settled.',
    '',
    'Output the statement alone — no preamble, no quotes, no "they said."',
  ].join('\n');
}

/** Strips wrapping quotes and a stray leading/trailing blank line. Never invents content. */
export function cleanSynthesizedAnswer(text: string): string {
  return text.trim().replace(/^["'“]+|["'”]+$/g, '').trim();
}

/**
 * Whether a synthesis threw away the answer it was supposed to preserve.
 *
 * **The defect this exists to catch, found by using the product on 19 Aug (F2).** The
 * comment-style question was answered "no comments needed". The follow-up wandered onto
 * an unrelated subject — what happens when a data file is missing — and the synthesis
 * came back as *"The script handles a missing compliments file with a clean exit. The
 * approach to comments remains open."* The settled answer was gone, replaced by a claim
 * that it had never been given.
 *
 * The model was obeying the prompt, which used to license saying what "remains open"
 * whenever a follow-up did not settle the question. That clause is now narrowed — but a
 * prompt is a hypothesis until someone reads the output, and this project has shipped
 * three personality fixes that passed tests asserting on prompt text and failed live. So
 * the prompt change is the intent, and this is the part that actually holds: a synthesis
 * declaring the topic unsettled, when the user did settle it, is discarded in favour of
 * the plain concatenation. Inelegant beats lost.
 */
const DECLARES_UNSETTLED =
  /\b(remains?|still|is|are|leaves?|left)\s+(open|unsettled|undecided|unclear|unspecified|to be (decided|determined))\b|\b(not|never)\s+(yet\s+)?(been\s+)?(settled|decided|determined|specified|chosen)\b|\bhas not been (settled|decided|determined|specified|chosen)\b/i;

export function discardsOriginalAnswer(original: string, synthesized: string): boolean {
  if (!original.trim() || !synthesized.trim()) return false;
  return DECLARES_UNSETTLED.test(synthesized);
}
