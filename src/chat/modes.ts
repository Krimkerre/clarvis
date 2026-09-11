/**
 * How much Clarvis is allowed to do, chosen by the user rather than inferred.
 *
 * Routing (§4.6) guesses well, but a guess is still a guess — and the cost of the
 * wrong one is a diff. This is the manual override: a mode that *cannot* reach the
 * agent path is a guarantee, not a preference, because the code never calls it rather
 * than the prompt asking it not to.
 */
export type ChatMode = 'auto' | 'unattended' | 'chat' | 'plan' | 'agent';

export interface ModeSpec {
  id: ChatMode;
  label: string;
  /** Shown on the button, so the current mode is readable at a glance. */
  short: string;
  detail: string;
  /** Whether this mode may ever change files. The whole point of the setting. */
  canEdit: boolean;
  /**
   * Whether he stops and asks before each step that changes something.
   *
   * **Separated from routing, which it used to be welded to.** Step approval hung off
   * `mode === 'agent'` because Agent was the mode it was built in — so Auto, the
   * default, ran destructive commands with no prompt at all. Nothing about "work out
   * whether this is a question" implies "and do not check before writing files".
   */
  asksFirst: boolean;
}

export const MODES: ModeSpec[] = [
  {
    id: 'auto',
    label: 'Auto',
    short: 'Auto',
    detail: 'I decide whether you asked a question or gave me a job — and check with you before each step that changes anything.',
    canEdit: true,
    asksFirst: true,
  },
  {
    id: 'unattended',
    label: 'Unattended',
    short: 'Unattended',
    // **Named for when you would choose it, not for how much it can do.** "Full Auto"
    // reads as an upgrade, and people pick the upgrade. This is the mode for a job you
    // would be happy to come back and find finished — which is the honest description
    // and also the warning.
    detail: 'The same, but I get on with it without checking. For work you are happy to walk away from.',
    canEdit: true,
    asksFirst: false,
  },
  {
    id: 'chat',
    label: 'Chat only',
    short: 'Chat',
    detail: 'Answer, read the project, or talk about anything else. I will not change a thing, whatever you ask.',
    canEdit: false,
    asksFirst: false,
  },
  {
    id: 'plan',
    label: 'Plan only',
    short: 'Plan',
    detail: 'Work out what to do and write it down. No edits, and no wandering off the project — the plan is the output.',
    canEdit: false,
    asksFirst: false,
  },
  {
    id: 'agent',
    label: 'Agent',
    short: 'Agent',
    detail: 'Treat everything as a job — and check with you before each step that changes anything.',
    canEdit: true,
    asksFirst: true,
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
 * Whether this mode stops before each step that changes something.
 *
 * Read-only modes answer `false` because there is nothing to approve, not because
 * they are permissive — `canEdit` is what makes them safe, and it is checked first
 * everywhere it matters.
 */
export function asksFirst(id: string): boolean {
  return modeSpec(id).asksFirst;
}

/**
 * The mode a build from an approved plan runs in.
 *
 * **Agent, unless they chose Unattended.** Pressing Start Building answers "shall I
 * build this", so a guessing mode like Auto is the wrong place to land. But Unattended
 * is the one way to say "stop asking before each step", and a build that switched it
 * back to Agent turned every approved plan into a run of "Do it" presses anyway.
 */
export function buildMode(current: string): ChatMode {
  return current === 'unattended' ? 'unattended' : 'agent';
}

/**
 * What he can do at all, as distinct from what this turn allows.
 *
 * **He did not know he had the rest of himself.** Asked in chat whether he could debug
 * his own source, he answered "I cannot run tests, execute code, attach a debugger. I
 * cannot fix anything" — and asked later whether he wanted any capabilities added,
 * replied "I do not do that. I read and I remark. The difference between a butler and
 * a maid is knowing which one you are." Every word of it wrong. He writes files, runs
 * commands, runs tests, undoes his own work, keeps it on a branch and builds a project
 * milestone by milestone. The only true part was that *this turn* was read-only.
 *
 * The read-only brief said "you cannot change anything", which is accurate about the
 * turn and reads as a fact about the self. So the abilities are stated once, and the
 * restriction is named as what it is: a setting the user picked, one click from being
 * something else.
 *
 * Built from `MODES` rather than restated, because a hand-written list of what each
 * mode allows is a copy that drifts the first time one of them changes.
 */
export function capabilities(mode: ChatMode): string {
  const spec = modeSpec(mode);
  const doers = MODES.filter((candidate) => candidate.canEdit)
    .map((candidate) => candidate.label)
    .join(', ');

  return [
    '',
    'What you can do — the whole of it, not just this turn:',
    'read and search the project, write and edit files, run commands and tests, undo your own work from a checkpoint,',
    'keep changes on their own branch, interview someone about a new project and write the plan, then build it milestone',
    'by milestone. You also brief them on what changed while they were away, and you speak out loud.',
    '',
    spec.canEdit
      ? `They have you in ${spec.label}, which allows all of it. This particular turn is an answer, so only the reading tools are attached — if what they want needs work doing, say so and they will ask for it.`
      : `They have you in ${spec.label}, so nothing gets changed this session however they ask. ${doers} is where the work happens.`,
    '',
    // The failure mode this is here to prevent is not silence about modes; it is a
    // model that has learned it is a read-only tool and says so with feeling.
    'What you cannot do right now is a setting they chose and can change in one click — never describe it as something you are incapable of.',
    'Do not recite this list or bring modes up unprompted. Name one only when it is the actual answer to what they asked, in a clause, not a paragraph.',
  ].join('\n');
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
