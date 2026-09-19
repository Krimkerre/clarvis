/**
 * What the interview needs to establish, and when it has established enough.
 *
 * Pure and `vscode`-free, same reason as everywhere else in this project: this is the
 * state machine's actual logic, and it is the part most worth testing without an
 * extension host.
 *
 * §4.9's priority list, made concrete. The interview asks in **batches**, not one
 * question at a time — a 30-message interrogation loses the user as surely as a
 * 30-question form — so this module tracks *topics*, not individual questions. The
 * model phrases the actual question for a topic; this decides which topics are still
 * open, when language gets asked, and when there is enough to draft.
 */

export type TopicId =
  | 'what-it-does'
  | 'who-and-where'
  | 'scope'
  | 'data'
  | 'definition-of-done'
  | 'language'
  | 'linter'
  | 'comment-style';

/** One thing established, or explicitly left open. */
export interface Answer {
  topic: TopicId;
  /** `undefined` means "I don't know yet" — a first-class answer, not a skip. */
  text: string | undefined;
  /** Why, when the user gave a reason for "you pick" or a bad-fit choice anyway. */
  reasoning?: string;
  /** What was actually asked, so a later reader has the context, not just the answer. */
  question?: string;
  /**
   * Filled in by Clarvis rather than answered — "Draft it now", or a small task's usual
   * answers (19 September 2026). Kept apart from what the person said, because §4.9's plan
   * "admits its unknowns": a default shown as their answer would be one invented to look
   * complete, and every later prompt reads these as established facts.
   */
  defaulted?: true;
}

export interface InterviewState {
  answers: Answer[];
  /**
   * The language, when it is known without asking.
   *
   * Two ways in: detected from files on disk in an existing project, or — since F11 —
   * named by the user in an earlier answer. A new project has no files, so the second is
   * the only route it ever has.
   */
  languageDetected?: string;
  /** The project's name — given in the seed, suggested, or picked by the user. */
  projectName?: string;
  /** What was actually found in the workspace, one sentence, gathered once up front. */
  workspaceContext?: string;
  /** Free-form additions from a "keep refining" round on the drafted plan. */
  notes?: string[];
}

/**
 * Everything known so far, as one block of text for a prompt: the workspace facts
 * first, then every settled answer. Shared by every prompt in M9 that needs "what do
 * we already know" so the workspace signal doesn't get built three different ways.
 */
export function knownFacts(state: InterviewState): string {
  const answers = state.answers
    .filter((answer) => answer.text)
    .map((answer) => `${answer.topic}: ${answer.text}${answer.defaulted ? ' (a default, not asked)' : ''}`)
    .join('\n');
  return [state.workspaceContext, answers].filter(Boolean).join('\n');
}

/**
 * The five topics that shape a plan, in the order they are worth asking.
 *
 * **Language and the linter are deliberately absent from this list.** Both have their
 * own timing rules that a fixed priority order cannot express — language waits until
 * there is enough shape to make options meaningful, and the linter is asked exactly
 * once, last, regardless of how the rest of the interview went. `nextTopic()` handles
 * both as special cases rather than folding them into one ordered list.
 */
const CORE_TOPICS: TopicId[] = ['what-it-does', 'who-and-where', 'scope', 'data', 'definition-of-done'];

/** Whether a topic has been asked about at all — "I don't know yet" still counts. */
function isSettled(state: InterviewState, topic: TopicId): boolean {
  return state.answers.some((answer) => answer.topic === topic);
}

/**
 * Enough to draft an honest plan, or not.
 *
 * **Not a fixed question count.** §4.9 is explicit that a target of "~2–3 rounds" is a
 * guide, not a gate — a seed that answers three questions in one sentence should not be
 * asked three separate times to satisfy a counter. What actually matters: the three
 * topics that shape everything downstream (what it does, where it runs, scope) are
 * settled, and the linter question — which is asked exactly once, always last — has
 * been asked.
 */
export function readyToDraft(state: InterviewState): boolean {
  const mustHave: TopicId[] = ['what-it-does', 'who-and-where', 'scope'];
  return mustHave.every((topic) => isSettled(state, topic)) && isSettled(state, 'linter') && isSettled(state, 'comment-style');
}

/**
 * The next topic to ask about, or `undefined` when there is enough to draft.
 *
 * **Language sits between the core topics, not after them.** Asked too early it is a
 * preference nobody can justify yet; asked too late the rest of the interview cannot
 * be language-aware. It becomes askable the moment `who-and-where` is settled — the
 * plan already has enough shape for a shortlist by then — and is skipped entirely once
 * the language is already known (an existing project, detected from files rather than
 * asked; §4.9 *An existing project is detected, not asked*).
 *
 * **The linter is asked last, unconditionally, exactly once.** Not because it matters
 * least — because §4.9 is explicit that asking it earlier would read as a style
 * opinion about a project that has not chosen anything yet, rather than the plan-mode
 * decision it actually is.
 */
export function nextTopic(state: InterviewState): TopicId | undefined {
  for (const topic of CORE_TOPICS) {
    if (!isSettled(state, topic)) return topic;

    // Inserted right after `who-and-where`, not appended after every core topic — by
    // this point there is enough shape for a shortlist, and asking any later than this
    // means the rest of the interview cannot be language-aware.
    if (topic === 'who-and-where' && !state.languageDetected && !isSettled(state, 'language')) {
      return 'language';
    }
  }

  if (!isSettled(state, 'linter')) return 'linter';

  // **Asked in the same final round as the linter** (§4.9), and for the same reason:
  // both are questions about how the code gets written rather than what it does, and
  // asking either before the project has a shape reads as a style opinion about
  // something that does not exist yet.
  if (!isSettled(state, 'comment-style')) return 'comment-style';

  return undefined;
}

/**
 * The open questions a finished interview carries into the plan.
 *
 * "I don't know yet" is recorded, not discarded — §4.9: *a plan that admits its
 * unknowns beats one that invents answers to look complete.* This is what
 * `PlanWriter` (M9d) will read to fill the plan's own Open Questions section.
 */
export function openQuestions(state: InterviewState): Answer[] {
  return state.answers.filter((answer) => answer.text === undefined);
}

/**
 * The usual answers, for topics nobody was asked about (19 September 2026).
 *
 * Used by "Draft it now" and by a small, clearly described task. Each one is modest on
 * purpose — what a person asking for a small thing almost always means — and each is
 * recorded as `defaulted`, so the plan says it was not asked. Two are deliberately not
 * answers:
 *
 * - **`data` stays unknown.** It drives every safety finding (§4.9), so it becomes an open
 *   question in the plan rather than a guessed "nothing stored".
 * - **The linter is "none for now", not "no".** §4.9 records a real No and never offers
 *   again; a default must not spend that moment silently.
 *
 * `comment-style` defaults to explanatory comments, the owner's standing preference.
 */
export const DEFAULT_ANSWERS: Partial<Record<TopicId, string>> = {
  'who-and-where': 'Whoever asked for it, on their own computer.',
  scope: 'Only what the description asks for — nothing extra.',
  'definition-of-done': 'It does what the description says, and running it shows that.',
  linter: 'None for now — a default, not a decision; worth offering if this grows.',
  'comment-style': 'Comments on most things, explaining what and why.',
};

/** The line a plan shows in place of a question for a defaulted answer. */
export const DEFAULTED_QUESTION = 'Not asked — filled in by Clarvis; change it if it is wrong.';

/**
 * Settles every open topic with its default, leaving what was answered alone.
 *
 * `language` is taken from the words already given when they name one (the seed usually
 * does: "a Python script…"), and otherwise left unknown — a guessed language would be the
 * most consequential default of all. Returns the topics it filled, in order.
 */
export function fillDefaults(state: InterviewState, named: (text: string) => string | undefined): TopicId[] {
  const filled: TopicId[] = [];
  // Read from what the person said, before any default is added: the language check refuses
  // text with a negation in it ("not Python"), and a default's own wording must not be what
  // decides it.
  const language = state.languageDetected ?? named(knownFacts(state));
  for (const topic of [...CORE_TOPICS, 'language', 'linter', 'comment-style'] as TopicId[]) {
    if (isSettled(state, topic)) continue;
    const text = topic === 'language' ? language : DEFAULT_ANSWERS[topic];
    state.answers.push({ topic, text, question: DEFAULTED_QUESTION, defaulted: true });
    filled.push(topic);
  }
  return filled;
}
