import { TOPIC_BRIEF } from './interviewPrompt';
import { InterviewState, TopicId, knownFacts } from './interviewTopics';

/**
 * Whether an answer is **unusable** as it stands, or can be planned against.
 *
 * Not every answer earns a second question — "no more than one round of doubt"
 * matches §4.9's own "challenged once, then honoured" rule elsewhere in this
 * project, and a topic that pushed back on every answer would be the interrogation
 * this interview has deliberately avoided since M9a. Same split as the rest of M9:
 * prompt and parser are pure and testable without a model.
 *
 * **Narrowed 19 Aug — M9h part 4.** Walking the runbook found this firing on five of
 * seven topics against ordinary answers. One pushback re-asked its own question a second
 * after it was answered; another asked what "runs" meant when the seed already said "a
 * script that prints a compliment each time you run it"; a third invented a missing-file
 * requirement for a thirty-line script, and *that* invention created the contradiction
 * which suppressed `NO-PLAN-NEEDED` (F4, F6). The user's verdict was the right one: nag
 * machines get discarded quickly.
 *
 * Two things were wrong, one in each half.
 *
 * The prompt asked whether the answer was *specific enough to plan against — no meaningful
 * ambiguity, no unstated assumption, no risk worth flagging*. Almost no short human answer
 * clears that bar, so the honest reply was nearly always a follow-up. The bar is now
 * whether the answer is usable at all.
 *
 * And the parser failed toward nagging: anything that was not literally `FINE` became a
 * question to ask. A model replying "Fine, that's specific enough" was a pushback. It now
 * fails toward silence — see `parseChallengeResult`.
 */

export type ChallengeResult = { fine: true } | { fine: false; followUp: string };

export function challengePrompt(topic: TopicId, answerText: string, state: InterviewState): string {
  const known = knownFacts(state);

  return [
    `Topic: ${TOPIC_BRIEF[topic]}`,
    '',
    `What is known so far:\n${known}`,
    '',
    `They just answered: "${answerText}"`,
    '',
    'Challenge this ONLY if it is unusable as it stands — it says nothing you could',
    'plan against at all, or it contradicts something already established above.',
    '',
    'Anything you can reasonably act on is FINE, even when it is terse, informal, or',
    'leaves detail to be settled later. Detail that can be decided while building is',
    'not a gap. Do not ask for precision the work does not need, do not ask about a',
    'subject this topic is not about, and never re-ask something already answered',
    'above. When in doubt, FINE.',
    '',
    'If it is usable, output exactly: FINE',
    'Otherwise output ONE follow-up question about THIS topic, nothing else — not',
    '"can you elaborate", a specific question that gets at what makes the answer',
    'impossible to plan against.',
  ].join('\n');
}

/**
 * Parses the model's `FINE` or its one follow-up question.
 *
 * **Fails toward silence, deliberately (M9h part 4).** This used to accept only the exact
 * string `FINE` and treat everything else as a question to ask, so "Fine, that's specific
 * enough" — a perfectly ordinary way to say yes — became a pushback. Every parse failure
 * cost the user an interruption.
 *
 * The reverse costs nothing: a challenge that should have fired and did not leaves an
 * answer as the user wrote it, which is where it started. So a reply is only treated as a
 * follow-up when it is unmistakably one — an actual question.
 */
export function parseChallengeResult(text: string): ChallengeResult {
  const first = text.trim().split('\n')[0].trim();
  if (!first) return { fine: true };
  if (/^fine\b/i.test(first)) return { fine: true };
  if (!first.endsWith('?')) return { fine: true };
  return { fine: false, followUp: first };
}
