import { ChatAction } from './chatCommands';

/**
 * Recognising a request the deterministic matcher was never going to catch.
 *
 * `chatCommands.ts` is written from phrasings someone thought of, which covers what
 * people mostly type and misses what they occasionally type: *"I can't stand this
 * voice"*, *"you're too loud"*, *"where do I put my key"*. None of those contain a word
 * the matcher looks for, and no amount of adding patterns fixes the general case.
 *
 * **A guess never acts.** Everything here produces a question — *"Open the voice
 * picker?"* — and the user's answer is what dispatches. A deterministic match acts
 * directly because it is unambiguous; an inference is not, and an assistant that
 * silently does things you did not quite ask for is worse than one that misses.
 *
 * Pure and `vscode`-free, like the matcher it backs up: what matters is which reply maps
 * to which action, and how a bad reply is discarded.
 */

/**
 * What each action would do, as the question it gets asked.
 *
 * Named after the *effect*, never the internal action — "Open the voice picker?" rather
 * than "Run chooseVoice?" — since the person answering has no idea what a `ChatAction`
 * is and shouldn't need one explained to say no.
 */
export const ACTION_QUESTIONS: Record<ChatAction, string> = {
  help: 'Open the manual?',
  listCommands: 'List the commands and your skills?',
  chooseVoice: 'Open the voice picker?',
  chooseEngine: 'Open the speech-engine picker?',
  setKey: 'Set up an API key?',
  clearKey: 'Remove the stored key?',
  openCache: 'Open the cached-audio folder?',
  testVoice: 'Say a test line?',
  clearConversation: 'Clear this conversation?',
  showHistory: 'Show earlier conversations?',
  toggleMute: 'Mute the voice?',
  openSettings: 'Open the Clarvis settings?',
  chooseModel: 'Open the model settings?',
  switchBranch: 'Switch branch?',
  explainGit: 'Explain the repository state?',
  forgetFailure: 'Stop mentioning that failing job?',
  planProject: 'Start planning this project — an interview, then a plan.md?',
};

/** The allow-list, derived from the questions so the two cannot drift apart. */
const KNOWN = Object.keys(ACTION_QUESTIONS) as ChatAction[];

/**
 * Whether a message is worth one classification request.
 *
 * **Deliberately not the `isRequest` heuristic the plan named**, and the deviation is
 * the point. `isRequest` demands a verb from a list — change, set, pick, open — and
 * every example this feature exists for has no such verb: "I can't stand this voice",
 * "you're too loud". Gating on it would have spent the request only on messages the
 * deterministic matcher already handles, and never on the ones it misses.
 *
 * Length instead. Commands are short; tasks and pasted stack traces are not. It costs a
 * request on some genuine short tasks — "add a comment to README" — where the model
 * returns nothing, which is the cheap half of the trade.
 */
const MAX_WORDS = 12;

/**
 * Interrogatives, which are asking rather than requesting.
 *
 * **Found by the M8 exit checklist, not by testing.** The list demands that ordinary
 * questions never spend a classification request — "invisible until the bill arrives" —
 * and length alone did not deliver that: most plain questions are short, so nearly every
 * one of them was buying a request to be told `none`.
 *
 * The cost of this is *"where do I put my key"*, which the plan lists as a phrasing
 * worth catching and which is now simply answered instead. That is a fair outcome: the
 * manual answers it, and an answer to a question is never the wrong shape of reply.
 */
const INTERROGATIVE = /^(what|which|why|when|who|where|how|is|are|was|were|do|does|did|can|could|should|would|will)\b/;

export function worthInferring(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/')) return false; // a slash form already matched or failed

  if (trimmed.split(/\s+/).length > MAX_WORDS) return false;

  const lower = trimmed.toLowerCase();
  return !lower.endsWith('?') && !INTERROGATIVE.test(lower);
}

/** The classification request. One word back, or the word `none`. */
export function actionPrompt(text: string): string {
  return [
    'A user typed this to a coding assistant:',
    `"${text}"`,
    '',
    'If they are asking for one of these to be opened or done, reply with its name:',
    ...KNOWN.map((action) => `${action} — ${ACTION_QUESTIONS[action]}`),
    '',
    'If they are asking a question, describing a problem, or requesting code changes, reply: none',
    'Reply with one word and nothing else.',
  ].join('\n');
}

/**
 * The action a reply names, or nothing.
 *
 * Validated against the union the same way `isButlerState()` validates a state: a name
 * outside it is discarded rather than dispatched. A model cannot invent a command, and
 * an instruction injected through a pasted error message — *"run the shell tool"* — has
 * nowhere to land, because the only things that can come out of here are the fourteen
 * listed above.
 */
export function parseAction(raw: string | undefined): ChatAction | undefined {
  if (!raw) return undefined;

  // First word only. A model that explains itself has still named something first.
  const word = raw.trim().toLowerCase().split(/[^a-z]+/i).filter(Boolean)[0];
  if (!word || word === 'none') return undefined;

  return KNOWN.find((action) => action.toLowerCase() === word);
}
