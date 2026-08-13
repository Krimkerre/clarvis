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
    'Output the statement alone — no preamble, no quotes, no "they said."',
  ].join('\n');
}

/** Strips wrapping quotes and a stray leading/trailing blank line. Never invents content. */
export function cleanSynthesizedAnswer(text: string): string {
  return text.trim().replace(/^["'“]+|["'”]+$/g, '').trim();
}
