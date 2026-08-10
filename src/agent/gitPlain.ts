/**
 * Git, explained to someone who has never needed to learn it.
 *
 * The audience (§6) is not a git expert, and most of git's own vocabulary describes
 * its *implementation* rather than the user's situation: "detached HEAD", "index",
 * "working tree", "unstaged". Someone with surface-level knowledge does not need those
 * words — they need to know what state they are in, what is at risk, and what to do
 * next.
 *
 * Two rules run through this file:
 *  - **Say the consequence, not the command.** "Your edits would be left behind" beats
 *    "checkout would overwrite local changes", and neither costs more words.
 *  - **Never make a beginner guess whether something is dangerous.** If work could be
 *    lost, that is the first thing said, in the same sentence as the offer.
 *
 * Pure, because the wording *is* the feature — and a wording test is worth more here
 * than a mock of the git API.
 */

export interface GitState {
  /** Undefined when the repository is in a detached state — see `detached`. */
  branch?: string;
  /** True when HEAD points at a commit rather than a branch. */
  detached: boolean;
  /** Files changed but not saved into git. */
  dirty: number;
  /** Commits made here that the remote has not got. */
  ahead: number;
  /** Commits on the remote that this branch has not got. */
  behind: number;
  /** True when this is one of Clarvis's own run branches. */
  onAgentBranch: boolean;
  /** Whether the project has a remote at all. */
  hasRemote: boolean;
}

/**
 * Where you are and what it means, in three short lines at most.
 *
 * Ordered by what would bite first: an unusual state, then unsaved work, then the
 * ordinary facts. A summary that opens with "you are on main" when HEAD is detached
 * has buried the only thing worth saying.
 */
export function explainState(state: GitState): string[] {
  const lines: string[] = [];

  if (state.detached) {
    lines.push(
      "You're not on a branch at the moment — you're looking at a specific old version of the project. " +
        'Anything you change here is easy to lose, so switch to a branch before doing real work.'
    );
  } else if (state.onAgentBranch) {
    lines.push(
      `You're on \`${state.branch}\`, which is a branch I made for a task. ` +
        'It exists so you can look at what I did and decide — keep it, merge it, or throw it away.'
    );
  } else if (state.branch) {
    lines.push(`You're on \`${state.branch}\`.`);
  }

  if (state.dirty > 0) {
    lines.push(
      `${state.dirty} file${state.dirty === 1 ? '' : 's'} changed since your last save point. ` +
        'They exist only on this machine until you commit them.'
    );
  }

  if (state.hasRemote && state.ahead > 0) {
    lines.push(
      `${state.ahead} save point${state.ahead === 1 ? '' : 's'} here that the shared copy doesn't have yet. ` +
        'Pushing sends them; nothing is lost either way.'
    );
  }

  if (state.hasRemote && state.behind > 0) {
    lines.push(
      `${state.behind} change${state.behind === 1 ? '' : 's'} from elsewhere that you don't have yet. ` +
        "Worth pulling before you start, or you'll be building on an old copy."
    );
  }

  if (lines.length === 1 && state.dirty === 0 && !state.detached) {
    lines.push('Nothing outstanding. Everything is saved.');
  }

  return lines;
}

export interface SwitchPlan {
  /** What will happen, said before it happens. */
  explanation: string;
  /** True when the user should be asked first. */
  needsConfirmation: boolean;
  /** The safest option, offered as the default. */
  saferFirst?: string;
}

/**
 * What switching branch will do to the work in progress.
 *
 * The single most confusing moment for a beginner: git carries uncommitted changes
 * across a checkout when it can, refuses when it can't, and explains neither. So the
 * explanation is given *before* the switch, in terms of the user's files rather than
 * git's rules.
 */
export function planSwitch(state: GitState, target: string): SwitchPlan {
  if (state.dirty === 0) {
    return { explanation: `Switching to \`${target}\`.`, needsConfirmation: false };
  }

  return {
    explanation:
      `You have ${state.dirty} unsaved change${state.dirty === 1 ? '' : 's'}. ` +
      `They'll come with you to \`${target}\` — they aren't tied to a branch until you save them into one. ` +
      "If that sounds wrong, save them here first and they'll stay put.",
    needsConfirmation: true,
    saferFirst: 'Save them here first',
  };
}

/**
 * Whether deleting a branch would lose anything, in words that say what is at stake.
 *
 * "Unmerged" is git's word for it and means nothing to a beginner. What matters is
 * that work exists in exactly one place and is about to stop existing.
 */
export function explainDelete(branch: string, uniqueCommits: number): string {
  if (uniqueCommits === 0) {
    return `\`${branch}\` has nothing on it that isn't already elsewhere. Deleting it loses nothing.`;
  }

  return (
    `\`${branch}\` holds ${uniqueCommits} save point${uniqueCommits === 1 ? '' : 's'} that exist nowhere else. ` +
    'Deleting it deletes that work, and I cannot get it back for you.'
  );
}

/**
 * The plain-language version of a failed checkout.
 *
 * git's message names files and rules; the user wants to know why they're stuck and
 * what to do. Almost always: something here would be trampled by something there.
 */
export function explainSwitchFailure(target: string): string {
  return (
    `I couldn't move you to \`${target}\`. Usually that means a file you've edited here also differs there, ` +
    'so git refuses rather than choosing for you. Saving your changes first is the fix.'
  );
}
