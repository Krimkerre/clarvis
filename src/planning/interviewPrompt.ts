import { characterWith, ONLY_WHAT_YOU_WERE_GIVEN } from '../personality/character';
import { InterviewState, TopicId } from './interviewTopics';

/**
 * Turning a topic into an actual question, in his voice.
 *
 * The state machine (`interviewTopics.ts`) decides *what* to ask about and *when*;
 * this decides how to ask it. Kept separate for the same reason `character.ts` is
 * separate from everywhere it's used — the topic logic is pure and needs no model to
 * test, the phrasing needs one and can't be tested the same way.
 */

/** What each topic is actually trying to establish, for the model to ask about. */
const TOPIC_BRIEF: Record<TopicId, string> = {
  'what-it-does': 'What it does, concretely — the one-sentence version, then the first real use case.',
  'who-and-where':
    "Who runs it, and where — platform, runtime, how it reaches whoever uses it. Often the single most plan-shaping answer. Don't ask about programming language here — that is a separate question, later.",
  scope: 'Scope boundaries — including what it should explicitly *not* do. Non-goals matter as much as goals and nobody volunteers them unasked.',
  data: 'What it reads, writes, stores, or sends. This drives every safety finding later, so be concrete rather than accepting a vague answer.',
  'definition-of-done': "What has to be true for v1 to be finished — not a wishlist, the actual line.",
  language: 'A shortlist of 2-4 languages that fit what has been described so far, each with one real advantage and one real cost. Never a list where every option looks good — that is a failed shortlist.',
  linter:
    'Whether they want a linter. State the trade in one sentence: it flags likely mistakes and keeps formatting consistent, at the cost of mild overhead on a throwaway script.',
};

/**
 * The instruction for one round.
 *
 * **One topic, one question, in a batch with whatever else this round covers** — the
 * caller decides batch size; this only phrases a single topic. §4.9: "batches, not one
 * at a time" is about how many *rounds* the interview takes, not about cramming every
 * topic into one wall of text — a round that asked five things at once would be just
 * as tiring as five separate messages.
 */
export function interviewQuestionPrompt(topic: TopicId, state: InterviewState): string {
  const known = state.answers
    .filter((answer) => answer.text)
    .map((answer) => `${answer.topic}: ${answer.text}`)
    .join('\n');

  return [
    'You are interviewing someone about a project they want built, to turn a rough idea',
    'into a written plan. Ask ONE question about the topic below.',
    '',
    `Topic: ${TOPIC_BRIEF[topic]}`,
    '',
    known ? `Already established:\n${known}` : "Nothing established yet — this is the opening question.",
    '',
    'Make the question specific to what you already know, not generic. "I don\'t know',
    'yet" must read as a perfectly reasonable answer, not one you are steering them away',
    'from.',
    'One or two sentences. No preamble, no numbering, no explanation of why you are',
    'asking.',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The written question for each topic, when no model is configured or one is slow.
 *
 * Same division as everywhere else in this project: local state (here, the topic
 * itself) is always answerable; the model is what makes the phrasing sound like him
 * and fit what's already been said. A plain question is never wrong, only generic.
 */
export const FALLBACK_QUESTION: Record<TopicId, string> = {
  'what-it-does': "What does it do? One sentence is plenty to start.",
  'who-and-where': 'Who runs this, and where — a phone, a server, a terminal, a browser?',
  scope: "What should it explicitly not do? What's out of scope for a first version.",
  data: 'What does it read, write, store, or send anywhere?',
  'definition-of-done': "What has to be true for you to call the first version done?",
  language: 'Any preference on language, or would you like me to suggest one once I know more?',
  linter: "Want a linter set up? It flags likely mistakes and keeps formatting consistent, at the cost of a little overhead on a throwaway script.",
};

/**
 * The brief for the whole interview, shared across every round.
 *
 * The rules that must hold regardless of which topic is being asked about right now —
 * batching, honesty about unknowns, never inventing scope the user did not give.
 */
export function interviewSystemPrompt(): string {
  return characterWith(
    'You are running a project-planning interview (§4.9). The goal is a plan the user',
    'can sign off on, not a form filled in as fast as possible.',
    '"I don\'t know yet" is a first-class, welcome answer — it becomes a recorded open',
    'question, never a blocker and never something to talk someone out of.',
    'Never invent a fact about their project. If they have not told you something, you',
    'do not know it.',
    ONLY_WHAT_YOU_WERE_GIVEN
  );
}
