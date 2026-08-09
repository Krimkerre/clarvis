/**
 * Deciding what a message actually wants.
 *
 * Three destinations: answer it from what Clarvis already watched (free), ask a model
 * (costs tokens), or run the agent (costs tokens *and* changes files).
 *
 * **Ambiguity resolves toward answering** (§4.6). The two mistakes are not equal: a
 * question wrongly sent to the agent starts editing a codebase nobody asked it to
 * touch, while a job wrongly answered produces a paragraph and the user says "no, do
 * it". One is an apology, the other is a diff.
 */
export type Route = 'answer' | 'agent';

export interface RouteDecision {
  route: Route;
  /** Shown before the run starts, so the choice is visible rather than inferred. */
  because: string;
}

/**
 * Verbs that describe changing the project.
 *
 * Deliberately about *the codebase*, not about Clarvis: "change the voice" is a
 * setting, handled by `chatCommands.ts` long before this runs.
 */
const WORK_VERBS =
  /\b(fix|add|remove|delete|rename|refactor|implement|create|write|update|migrate|convert|extract|inline|split|merge|upgrade|bump|install|wire|hook up|clean up|tidy|format|sort|replace)\b/;

/** Phrasings that are a request for work even without an imperative verb. */
const WORK_PHRASES = [
  /\bmake (it|this|the|them|that)\b/,
  /\bcan you (fix|add|change|update|write|implement|create|refactor|rename)\b/,
  /\bget (it|this|the tests?) (working|passing|green)\b/,
  /\bsort (it|this) out\b/,
  /\bdo it\b/,
  /\bgo on then\b/,
  /\bcarry on\b/,
];

/**
 * Questions, which stay questions even when they contain a work verb.
 *
 * "How do I fix this?" asks for an explanation; "fix this" asks for a fix. The
 * difference is the leading question word, and missing it is the single most likely
 * way this router starts editing files during a conversation.
 */
const QUESTION_OPENERS =
  /^(what|which|why|when|who|where|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|any|tell me|explain|show me)\b/;

/**
 * Asking about a plan is not asking for the work.
 *
 * Both word orders matter — "should we rename this" and "we should rename this" are
 * the same thought, and only the first was caught until a test found the second. So is
 * hedging: "maybe add tests" is a musing, and treating it as an instruction is how an
 * agent starts work off the back of someone thinking aloud.
 */
const HYPOTHETICAL =
  /\b(would|should|could|might) (i|we|you)\b|\b(i|we|you) (would|should|could|might)\b|\bwhat if\b|\bthinking (of|about)\b|\bplan(ning)? to\b|\b(maybe|perhaps|probably|possibly)\b/;

export function routeFor(text: string): RouteDecision {
  const message = text.trim().toLowerCase();

  // A question mark is the clearest signal a person can give, and people mean it.
  if (message.endsWith('?')) {
    return { route: 'answer', because: 'That reads as a question, so I answered rather than started work.' };
  }

  if (HYPOTHETICAL.test(message)) {
    return { route: 'answer', because: "That sounds like thinking out loud, so I've answered rather than acted." };
  }

  // "Explain how to fix the test" contains a work verb and wants prose.
  if (QUESTION_OPENERS.test(message)) {
    return { route: 'answer', because: 'That reads as a question, so I answered rather than started work.' };
  }

  if (WORK_VERBS.test(message) || WORK_PHRASES.some((phrase) => phrase.test(message))) {
    return { route: 'agent', because: 'That reads as a job, so I picked up the tools.' };
  }

  return { route: 'answer', because: 'I answered rather than assuming you wanted work done.' };
}

/**
 * Whether a reply to something Clarvis said unprompted counts as a request.
 *
 * §4.6: a pattern hit or a quip is an observation, and rule 3 keeps Clarvis from
 * acting on its own. **Replying to it is what makes it a request** — so "go on then"
 * after "you've hit this error three times" is an instruction, while the same words
 * with no preceding remark are not.
 */
export function isEscalation(text: string, hadUnsolicitedSurface: boolean): boolean {
  if (!hadUnsolicitedSurface) return false;

  return /\b(go on|go ahead|do it|yes please|fix it|sort it|please do|carry on)\b/.test(
    text.trim().toLowerCase()
  );
}
