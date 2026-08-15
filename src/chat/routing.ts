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
 *
 * **This list keeps being wrong, and always in the same direction.** `make` and `build`
 * were missing at first, so "make a new branch called testing3" was answered rather
 * than done. Then `edit` and `change` were missing, so "edit the comment in plan.md"
 * was answered by a read-only path explaining that it cannot edit things — which reads
 * as a refusal rather than a misunderstanding.
 *
 * A hand-written list of verbs will always be missing the one someone just used, which
 * is why `isEscalation` exists: saying "do it" after a wrong answer is the recovery,
 * and it costs the user four characters instead of a rephrase.
 */
const WORK_VERBS =
  /\b(fix|add|remove|delete|rename|refactor|implement|create|make|build|generate|scaffold|set ?up|initiali[sz]e|write|rewrite|edit|change|adjust|tweak|correct|update|append|insert|migrate|convert|extract|inline|split|merge|upgrade|bump|install|wire|hook up|clean up|tidy|format|sort|replace|revert|undo|move|copy|commit|branch off)\b/;

/** Phrasings that are a request for work even without an imperative verb. */
const WORK_PHRASES = [
  /\bmake (it|this|the|them|that)\b/,
  /\b(can|could) you (fix|add|change|update|write|implement|create|refactor|rename)\b/,
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

  // **A polite request is a request, question mark and all.** "Can you fix my code?"
  // used to hit the trailing-? rule below and read as an answer — found live: it
  // produced a list of what was wrong and a note that he could not write files in Chat
  // mode, when the whole point of asking was to have it fixed. `WORK_PHRASES` already
  // recognised "can you fix" as work; it just never ran, because the question mark
  // returned first. Checked before the blanket rule, since this is the one shape of
  // question that is unambiguously a job wearing a question mark as a courtesy.
  if (WORK_PHRASES.some((phrase) => phrase.test(message))) {
    return { route: 'agent', because: 'That reads as a job, so I picked up the tools.' };
  }

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

  if (WORK_VERBS.test(message)) {
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
  return ESCALATION.test(text.trim().toLowerCase());
}

/**
 * "Do it" after an answer, meaning *that thing you just described*.
 *
 * The recovery for a routing miss. A verb list will always lack the word someone just
 * used, and rather than making them rephrase, the previous message is re-run as a job.
 * Short and unambiguous phrases only — "yes" alone is too common in ordinary
 * conversation to hand to an agent.
 */
const ESCALATION = /^(go on(\s+then)?|go ahead|do it|just do it|yes please do|please do|make it so|fix it|sort it out|carry on)\b/;

export function isDoItNow(text: string): boolean {
  return ESCALATION.test(text.trim().toLowerCase());
}

/**
 * Whether the keyword router reached "answer" by *default* rather than by evidence.
 *
 * The distinction that decides whether asking a model is worth a request:
 *  - "why did the build fail?" is a question by every signal there is — a leading
 *    question word, a question mark. Nothing to classify.
 *  - "edit the comment in plan.md to X" matched no verb the list happens to contain,
 *    and no question signal either. It fell through, and falling through is not
 *    evidence of anything.
 *
 * Only the second case is worth spending a request on, which keeps the cost near zero
 * for ordinary conversation.
 */
export function needsClassification(text: string): boolean {
  const message = text.trim().toLowerCase();

  if (message.length === 0) return false;
  if (message.endsWith('?')) return false;
  if (QUESTION_OPENERS.test(message)) return false;
  if (HYPOTHETICAL.test(message)) return false;

  // A verb matched, so the router had a reason. Only the fall-through case is unclear.
  if (WORK_VERBS.test(message) || WORK_PHRASES.some((phrase) => phrase.test(message))) return false;

  // Very short fragments are conversation, not instructions: "hmm", "ok", "thanks".
  return message.split(/\s+/).length >= 3;
}

/**
 * Reads a classifier's reply, strictly.
 *
 * One word expected. Anything else — a sentence, an explanation, an apology — is
 * treated as no answer at all, and the deterministic route stands. A classifier that
 * cannot follow a one-word instruction is not one to trust with "should I edit their
 * files".
 */
export function parseIntent(raw: string | undefined): Route | undefined {
  if (!raw) return undefined;

  const word = raw.trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (word === 'WORK') return 'agent';
  if (word === 'QUESTION') return 'answer';
  return undefined;
}

/** The classifier's instruction. Deliberately tiny: it is one decision, not a chat. */
export function intentPrompt(text: string): string {
  return [
    'Decide whether this message asks for a change to be made to the code, or asks a question about it.',
    '',
    `Message: ${text}`,
    '',
    'Answer with exactly one word: WORK if it asks for something to be changed, created, deleted or run.',
    'QUESTION if it asks for information, an explanation, or an opinion.',
    'If it could be either, answer QUESTION.',
  ].join('\n');
}
