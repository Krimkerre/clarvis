/** The dev moments worth remarking on (§5). */
export type QuipTrigger =
  /** A branch appeared that the project's declared flow doesn't account for. */
  | 'newBranch'
  | 'buildSlow'
  | 'repeatFailure'
  | 'suiteWentGreen'
  | 'firstCommitAfterSilence'
  | 'bigDiff';

/**
 * `polite` lines are safe from the first minute of the first session.
 * `earned` lines are only unlocked once he's watched you struggle a bit (§2 rule 2) —
 * opening with contempt you haven't earned is how a character becomes a mute button.
 */
export type Tone = 'polite' | 'earned';

export interface Quip {
  id: string;
  trigger: QuipTrigger;
  tone: Tone;
  text: string;
}

/**
 * The bank. Written against §2's six comedic mechanics — deflate then help, name the
 * non-answer, understate the consequence, long-then-short rhythm, no explaining the
 * joke. Kept terse deliberately: the failure mode for this character is volume.
 *
 * Data only, no imports, so it can be read and edited without touching logic.
 */
export const QUIPS: Quip[] = [
  // ---- a build that took far too long -------------------------------------
  { id: 'slow-1', trigger: 'buildSlow', tone: 'polite', text: 'Nine minutes. I amused myself in your absence.' },
  { id: 'slow-2', trigger: 'buildSlow', tone: 'polite', text: 'Done. That build had time to develop opinions.' },
  { id: 'slow-3', trigger: 'buildSlow', tone: 'polite', text: "Finished. I've had shorter naps." },
  { id: 'slow-4', trigger: 'buildSlow', tone: 'earned', text: 'Built. Somewhere in there is a caching strategy nobody wrote.' },
  { id: 'slow-5', trigger: 'buildSlow', tone: 'earned', text: 'Complete. The heat death of the universe remains slightly further off.' },

  // ---- the same thing failing again ---------------------------------------
  { id: 'repeat-1', trigger: 'repeatFailure', tone: 'polite', text: 'Same failure again. Worth changing something before the next attempt.' },
  { id: 'repeat-2', trigger: 'repeatFailure', tone: 'polite', text: "That's the same error. It hasn't reconsidered." },
  { id: 'repeat-3', trigger: 'repeatFailure', tone: 'earned', text: "A bold strategy. Let's see how it plays out the fourth time." },
  { id: 'repeat-4', trigger: 'repeatFailure', tone: 'earned', text: 'Identical output. The computer is being remarkably consistent; the input less so.' },
  { id: 'repeat-5', trigger: 'repeatFailure', tone: 'earned', text: 'Still red. At this point it is less a bug and more a housemate.' },

  // ---- red suite goes green ------------------------------------------------
  { id: 'green-1', trigger: 'suiteWentGreen', tone: 'polite', text: 'Green. Well done, actually.' },
  { id: 'green-2', trigger: 'suiteWentGreen', tone: 'polite', text: 'All passing. I had my doubts; I keep those to myself.' },
  { id: 'green-3', trigger: 'suiteWentGreen', tone: 'earned', text: "Green at last. I'd frame it, but it'll be red again by Thursday." },
  { id: 'green-4', trigger: 'suiteWentGreen', tone: 'earned', text: 'Passing. Whatever you did, do try to remember it.' },

  // ---- first commit after a long silence -----------------------------------
  { id: 'commit-1', trigger: 'firstCommitAfterSilence', tone: 'polite', text: 'It lives.' },
  { id: 'commit-2', trigger: 'firstCommitAfterSilence', tone: 'polite', text: 'A commit. The repository was beginning to worry.' },
  { id: 'commit-3', trigger: 'firstCommitAfterSilence', tone: 'earned', text: 'A commit, finally. I had started drafting the eulogy.' },

  // ---- an enormous working tree --------------------------------------------
  { id: 'diff-1', trigger: 'bigDiff', tone: 'polite', text: "That's a substantial diff. Consider a commit before it becomes a lifestyle." },
  { id: 'diff-2', trigger: 'bigDiff', tone: 'earned', text: "Ambitious. I'll alert the reviewer's next of kin." },
  { id: 'diff-3', trigger: 'bigDiff', tone: 'earned', text: 'Two hundred files. This is no longer a change, it is a weather event.' },

  // A branch nobody told him about. The joke is always about the branch or about
  // himself — never about the user being disorganised, which is §2's line: the
  // situation is fair game, the person is not.
  { id: 'branch-1', trigger: 'newBranch', tone: 'polite', text: 'A new branch has appeared, unannounced.' },
  {
    id: 'branch-2',
    trigger: 'newBranch',
    tone: 'polite',
    text: "There's a branch here I've not been introduced to.",
  },
  {
    id: 'branch-3',
    trigger: 'newBranch',
    tone: 'polite',
    text: 'A branch materialised while I was looking the other way.',
  },
  {
    id: 'branch-4',
    trigger: 'newBranch',
    tone: 'earned',
    text: "Another branch. The plan says three. I'm keeping score, and the plan is losing.",
  },
  {
    id: 'branch-5',
    trigger: 'newBranch',
    tone: 'earned',
    text: 'A branch has wandered in without paperwork. I do so hate an undocumented arrival.',
  },
  {
    id: 'branch-6',
    trigger: 'newBranch',
    tone: 'earned',
    text: "Branches are appearing faster than I write them down. Partly my job, admittedly.",
  },
];
