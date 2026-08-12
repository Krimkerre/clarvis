import { TOPIC_BRIEF } from './interviewPrompt';
import { InterviewState, TopicId } from './interviewTopics';

/**
 * Whether an answer is specific enough to plan against, or needs one follow-up.
 *
 * Not every answer earns a second question — "no more than one round of doubt"
 * matches §4.9's own "challenged once, then honoured" rule elsewhere in this
 * project, and a topic that pushed back on every answer would be the interrogation
 * this interview has deliberately avoided since M9a. Same split as the rest of M9:
 * prompt and parser are pure and testable without a model.
 */

export type ChallengeResult = { fine: true } | { fine: false; followUp: string };

export function challengePrompt(topic: TopicId, answerText: string, state: InterviewState): string {
  const known = state.answers
    .filter((answer) => answer.text)
    .map((answer) => `${answer.topic}: ${answer.text}`)
    .join('\n');

  return [
    `Topic: ${TOPIC_BRIEF[topic]}`,
    '',
    `What is known so far:\n${known}`,
    '',
    `They just answered: "${answerText}"`,
    '',
    'Is this specific enough to plan against — no meaningful ambiguity, no unstated',
    'assumption, no risk worth flagging, and it does not contradict anything already',
    'established? Or is it vague, hand-wavy, or does it quietly hide a real risk or a',
    'contradiction?',
    '',
    'If it is genuinely fine as given, output exactly: FINE',
    'Otherwise output ONE follow-up question, nothing else — not "can you elaborate",',
    'a specific question that gets at the actual gap, risk, or contradiction.',
  ].join('\n');
}

/** Parses the model's `FINE` or its one follow-up question. */
export function parseChallengeResult(text: string): ChallengeResult {
  const trimmed = text.trim();
  if (/^FINE\.?$/i.test(trimmed)) return { fine: true };
  if (!trimmed) return { fine: true };
  return { fine: false, followUp: trimmed.split('\n')[0].trim() };
}
