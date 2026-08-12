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
  | 'linter';

/** One thing established, or explicitly left open. */
export interface Answer {
  topic: TopicId;
  /** `undefined` means "I don't know yet" — a first-class answer, not a skip. */
  text: string | undefined;
  /** Why, when the user gave a reason for "you pick" or a bad-fit choice anyway. */
  reasoning?: string;
}

export interface InterviewState {
  answers: Answer[];
  /** Whether the model detected the language from files on disk rather than asking. */
  languageDetected?: string;
  /** The project's name — given in the seed, suggested, or picked by the user. */
  projectName?: string;
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
  return mustHave.every((topic) => isSettled(state, topic)) && isSettled(state, 'linter');
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
