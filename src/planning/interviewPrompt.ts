import { characterWith, ONLY_WHAT_YOU_WERE_GIVEN } from '../personality/character';
import { InterviewState, TopicId, knownFacts } from './interviewTopics';

/**
 * Turning a topic into an actual question, in his voice.
 *
 * The state machine (`interviewTopics.ts`) decides *what* to ask about and *when*;
 * this decides how to ask it. Kept separate for the same reason `character.ts` is
 * separate from everywhere it's used — the topic logic is pure and needs no model to
 * test, the phrasing needs one and can't be tested the same way.
 */

/** What each topic is actually trying to establish, for the model to ask about. */
export const TOPIC_BRIEF: Record<TopicId, string> = {
  'what-it-does': 'What it does, concretely — the one-sentence version, then the first real use case.',
  'who-and-where':
    "Who runs it, and where — platform, runtime, how it reaches whoever uses it. Often the single most plan-shaping answer. Don't ask about programming language here — that is a separate question, later.",
  scope: 'Scope boundaries — including what it should explicitly *not* do. Non-goals matter as much as goals and nobody volunteers them unasked.',
  data: 'What it reads, writes, stores, or sends. This drives every safety finding later, so be concrete rather than accepting a vague answer.',
  'definition-of-done': "What has to be true for v1 to be finished — not a wishlist, the actual line.",
  language: 'A shortlist of 2-4 languages that fit what has been described so far, each with one real advantage and one real cost. Never a list where every option looks good — that is a failed shortlist.',
  linter:
    'Whether they want a linter. State the trade in one sentence: it flags likely mistakes and keeps formatting consistent, at the cost of mild overhead on a throwaway script.',
  'comment-style':
    'How chatty the code should be. Two options, both legitimate: comments on most things explaining what and why — good for coming back later, or for someone still learning — or lean comments where the code explains itself and a comment marks only the surprises, which is what most professional codebases do. Present both as real choices; neither is the right answer.',
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
  // **Language needs a different shape entirely, not one more "ask a question" topic.**
  // Found live: given the generic template, the model asked a Windows-vs-macOS
  // scoping question instead of a shortlist, and "preferrably multi-platform" — an OS
  // constraint, not a language — was recorded under `language`, with the interview
  // reporting zero open questions. It looked finished. No language had actually been
  // chosen. The instruction to "ask ONE question" is exactly what steered it there:
  // §4.9 wants a menu, not a question, and a generic template cannot say that.
  if (topic === 'language') return languageShortlistPrompt(state);

  const known = knownFacts(state);

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
 * The language shortlist itself (§4.9), not a question that leads up to one.
 *
 * Mirrors the plan's own worked example closely on purpose — a vague instruction to
 * "suggest some languages" is exactly what produced a scoping question instead of a
 * menu the first time this ran. Every rule here maps to a specific §4.9 sentence:
 * options must come from what was actually said, every option needs a real cost, and
 * "you pick" has to be honoured as a real answer, not treated as a non-answer.
 */
function languageShortlistPrompt(state: InterviewState): string {
  const known = knownFacts(state);

  return [
    'Propose a shortlist of 2 to 4 programming languages for this project, based only',
    'on what is described below — not a generic list, one that follows from what this',
    'project actually is.',
    '',
    `What is known so far:\n${known}`,
    '',
    'For each language: its name, one real advantage for *this* project, and one real',
    'cost. An option with no honest downside is not a real option — leave it out rather',
    'than pad the list with one.',
    'Do not ask a preliminary question first (platform, OS, anything else) — answer with',
    'the shortlist itself, using what is already known above.',
    '',
    'Output ONLY the options, one per line, in exactly this format and nothing else —',
    'no intro, no closing line, no numbering, no markdown:',
    'Name | advantage | cost',
  ].join('\n');
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
  'comment-style':
    'How chatty should the code be? Comments on most things, explaining what and why — or lean comments, where the code explains itself and a comment marks only the surprises. Both are defensible.',
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

/**
 * Makes sure a remark about a **delegated** choice actually names what was chosen.
 *
 * **The defect this exists to catch, found by using the product on 19 Aug (F1).**
 * Answering the language question with "you pick" resolves to a real language, and the
 * only thing that reached the chat was the dry remark about the trade — which alludes
 * without naming: *"You've chosen the language that will run anywhere and build nowhere,
 * which is to say you've chosen to debug this in the browser."* That was JavaScript, and
 * the user found out by reading the log. The project became a browser page.
 *
 * Delegating a decision is an invitation to make it, not to hide it. When the user picked
 * the language themselves they already know it, so this applies only to the delegated
 * path.
 *
 * The added clause is `remarkOnLanguage`'s own no-model fallback, reused verbatim rather
 * than inventing a second phrasing at a call site (§2.2).
 */
export function ensureNamesChoice(line: string, choice: string): string {
  const trimmed = line.trim();
  const wanted = choice.trim();
  if (!wanted) return trimmed;
  return mentions(trimmed, wanted) ? trimmed : `${wanted} it is.${trimmed ? ` ${trimmed}` : ''}`;
}

/**
 * Whether `text` names `choice` as a word.
 *
 * A word boundary is only asserted at an end that is actually a word character, because
 * `\bC\+\+\b` can never match: `+` is not a word character, so the trailing boundary
 * has nothing to sit against. `C++`, `F#` and `C#` are all real answers to the language
 * question, and treating them as never-mentioned would mean announcing the choice twice
 * rather than once.
 */
function mentions(text: string, choice: string): boolean {
  const escaped = choice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = /^\w/.test(choice) ? '\\b' : '';
  const close = /\w$/.test(choice) ? '\\b' : '';
  return new RegExp(`${open}${escaped}${close}`, 'i').test(text);
}
