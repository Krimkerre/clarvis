/**
 * How much Clarvis is allowed to do, chosen by the user rather than inferred.
 *
 * Routing (§4.6) guesses well, but a guess is still a guess — and the cost of the
 * wrong one is a diff. This is the manual override: a mode that *cannot* reach the
 * agent path is a guarantee, not a preference, because the code never calls it rather
 * than the prompt asking it not to.
 */
export type ChatMode = 'auto' | 'chat' | 'plan' | 'agent';

export interface ModeSpec {
  id: ChatMode;
  label: string;
  /** Shown on the button, so the current mode is readable at a glance. */
  short: string;
  detail: string;
  /** Whether this mode may ever change files. The whole point of the setting. */
  canEdit: boolean;
}

export const MODES: ModeSpec[] = [
  {
    id: 'auto',
    label: 'Auto',
    short: 'Auto',
    detail: 'I decide: questions get answered, jobs get done, and I get on with it without asking at each step.',
    canEdit: true,
  },
  {
    id: 'chat',
    label: 'Chat only',
    short: 'Chat',
    detail: 'Answer, read the project, or talk about anything else. I will not change a thing, whatever you ask.',
    canEdit: false,
  },
  {
    id: 'plan',
    label: 'Plan only',
    short: 'Plan',
    detail: 'Work out what to do and write it down. No edits, and no wandering off the project — the plan is the output.',
    canEdit: false,
  },
  {
    id: 'agent',
    label: 'Agent',
    short: 'Agent',
    detail: 'Treat everything as a job — and check with you before each step that changes anything.',
    canEdit: true,
  },
];

export function modeSpec(id: string): ModeSpec {
  return MODES.find((mode) => mode.id === id) ?? MODES[0];
}

/** Whether a mode is allowed to run the agent at all. */
export function canEdit(id: string): boolean {
  return modeSpec(id).canEdit;
}

/**
 * The instruction added when planning.
 *
 * Plan mode is the §0 discipline turned outward: say what you would do, in enough
 * detail to be argued with, and stop. It is not "ask permission then act" — there is
 * no acting available, which is what makes it restful to use.
 */
export const PLAN_ADDENDUM =
  ' The user has put you in plan mode. Work out what would need to change and describe it: which files, what edits, in what order, and what could go wrong. Do not ask to proceed — you cannot, and offering would be theatre. End with the smallest first step.' +
  // **The one mode that stays on the subject.** Chat mode was deliberately loosened
  // to hold an ordinary conversation, which is right for chat and wrong here: plan
  // mode is a working session with an output, and a digression into how closures work
  // in the middle of one is the thing that loses the thread. Said plainly rather than
  // enforced in code — this is about attention, not permission, and there is nothing
  // to prevent.
  ' Stay on this project. Unlike ordinary chat, this is a working session with a plan at the end of it: if they ask about something unrelated, answer in a sentence and bring it back to what you are both here to work out.';
