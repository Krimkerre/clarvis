/**
 * What happened, and what to do about it.
 *
 * An agent run ends with the user checked out on a branch they did not create,
 * holding work they have not read. "Done!" is not enough — the honest close is: here
 * is what changed, here are your options, each with its consequence. This module is
 * the *decision*, kept pure so the options and their warnings can be tested without a
 * repository.
 */

export interface RunSummary {
  /** The branch the run worked on. Absent when git wasn't available. */
  branch?: string;
  /**
   * The branch the user was actually on when the run started.
   *
   * The most likely merge target by a distance, and the one a guess gets wrong: work
   * started from a milestone branch belongs back on that milestone branch, not on the
   * trunk the repository happens to have.
   */
  origin?: string;
  /** The trunk, for repositories where that differs from where the run started. */
  base?: string;
  /**
   * An integration branch, when the repository has one.
   *
   * A repo with `testing` or `develop` has already decided that work lands somewhere
   * before it lands on the trunk. Offering only "merge into main" ignores that
   * decision and quietly routes agent work past the step the team put there.
   */
  integration?: string;
  /** Files the run itself touched. */
  files: string[];
  /** Every commit on the branch that isn't on the base. */
  commits: { hash: string; subject: string }[];
  /** Commits the run did not make — see `foreignCommits`. */
  foreign: { hash: string; subject: string }[];
  /** Changes still uncommitted in the working tree. */
  uncommitted: number;
}

export type ReviewAction =
  | 'diff'
  | 'merge'
  | 'merge-integration'
  | 'merge-origin'
  | 'return'
  | 'discard'
  | 'stay';

/**
 * Branch names that mean "work lands here before the trunk".
 *
 * Conventional rather than configurable: a project using something else can still
 * merge by hand, and guessing at an unconventional name would be worse than not
 * offering — an agent proposing a merge into the wrong branch is a bad suggestion
 * dressed as a workflow.
 */
const INTEGRATION_NAMES = ['testing', 'develop', 'development', 'staging', 'dev'];

/** The integration branch this repository uses, if it has one. */
export function integrationBranch(branches: string[], base?: string): string | undefined {
  return INTEGRATION_NAMES.find((name) => branches.includes(name) && name !== base);
}

export interface ReviewOption {
  action: ReviewAction;
  label: string;
  /** The consequence, stated plainly — an option list without them is a quiz. */
  detail: string;
  /** True when the action cannot be undone easily, so the caller confirms first. */
  destructive?: boolean;
}

/**
 * Commits on the branch that this run did not make.
 *
 * **This is the case that matters.** An agent branch is checked out in the user's own
 * working tree, so anything committed afterwards — by the user, by a tool, by another
 * session — lands on it too. Merging or deleting the branch then affects work nobody
 * associated with the agent.
 *
 * Measured against the run's own commit hashes rather than by author or message: a
 * model writes commit messages in the user's voice, and both commit as the same person.
 */
export function foreignCommits(
  all: { hash: string; subject: string }[],
  runHashes: string[]
): { hash: string; subject: string }[] {
  return all.filter((commit) => !runHashes.includes(commit.hash));
}

/**
 * The options to offer, in the order they should be read.
 *
 * Reviewing comes first because it is the only one that cannot go wrong, and the
 * dangerous option comes last — a list that opens with "throw it away" invites the
 * reflex click it exists to prevent.
 */
export function reviewOptions(summary: RunSummary): ReviewOption[] {
  if (!summary.branch) {
    // No branch means no isolation: the changes are loose in the working tree, and the
    // only meaningful offer is to look at them or undo the run.
    return [
      { action: 'diff', label: 'Show me what changed', detail: `${summary.files.length} file(s) touched` },
      {
        action: 'discard',
        label: 'Undo the whole run',
        detail: 'Restores every file to how it was before the run started.',
        destructive: true,
      },
    ];
  }

  const home = summary.origin ?? summary.base ?? 'your branch';
  const options: ReviewOption[] = [
    {
      action: 'diff',
      label: 'Show me what changed',
      detail: `${summary.commits.length} commit(s), ${summary.files.length} file(s). Nothing moves.`,
    },
    ...mergeTargets(summary),
    {
      action: 'return',
      label: `Go back to ${home}, keep the branch`,
      detail: `The work stays on \`${summary.branch}\` for later. Nothing is lost.`,
    },
    {
      action: 'stay',
      label: 'Stay on this branch',
      detail: 'Carry on working here. Anything you commit lands on the agent branch.',
    },
    {
      action: 'discard',
      label: 'Throw it away',
      detail: `Deletes \`${summary.branch}\` and everything on it, and returns you to ${home}.`,
      destructive: true,
    },
  ];

  return options;
}

/**
 * Where the work could go, most likely first.
 *
 * Three candidates, in the order a person would consider them:
 *  1. **where the run started** — a task begun from a milestone branch belongs back on
 *     that milestone branch, and a guess at the trunk gets this wrong every time
 *  2. **the integration branch**, when the repository has one it routes work through
 *  3. **the trunk**, said plainly as the step that skips the others
 *
 * Deduplicated, because a repository where all three are the same branch should offer
 * one option rather than the same option three times with different wording.
 */
export function mergeTargets(summary: RunSummary): ReviewOption[] {
  const seen = new Set<string>();
  const targets: ReviewOption[] = [];

  const add = (branch: string | undefined, action: ReviewAction, detail: string) => {
    if (!branch || branch === summary.branch || seen.has(branch)) return;
    seen.add(branch);
    targets.push({ action, label: `Merge into ${branch}`, detail });
  };

  add(summary.origin, 'merge-origin', 'Where this run started — usually where it belongs.');
  add(
    summary.integration,
    'merge-integration',
    summary.origin
      ? 'The shared integration branch, rather than back where you were.'
      : 'The usual route before anything reaches the trunk.'
  );
  add(
    summary.base,
    'merge',
    seen.size > 0 ? 'Straight onto the trunk, skipping the branches above.' : 'Brings the work onto the trunk.'
  );

  return targets;
}

/**
 * Warnings to show above the options.
 *
 * Each is a state where the obvious choice is wrong, and none of them are obvious from
 * the option list alone.
 */
export function reviewWarnings(summary: RunSummary): string[] {
  const warnings: string[] = [];

  if (summary.foreign.length > 0) {
    warnings.push(
      `${summary.foreign.length} commit(s) on this branch weren't made by the run — ` +
        `"${summary.foreign[0].subject.slice(0, 60)}". Merging or deleting takes them too.`
    );
  }

  if (summary.uncommitted > 0) {
    warnings.push(
      `${summary.uncommitted} uncommitted change(s) in the working tree. They follow you between branches and are not part of any option below.`
    );
  }

  if (summary.commits.length === 0 && summary.files.length > 0) {
    warnings.push(
      'The files changed but nothing was committed, so switching branches carries the changes with you rather than leaving them behind.'
    );
  }

  return warnings;
}

/** A one-line description of the run, for the top of the wizard. */
export function describeRun(summary: RunSummary): string {
  if (!summary.branch) {
    return `${summary.files.length} file(s) changed, no branch (git wasn't available).`;
  }

  const commits = `${summary.commits.length} commit${summary.commits.length === 1 ? '' : 's'}`;
  const files = `${summary.files.length} file${summary.files.length === 1 ? '' : 's'}`;

  return `\`${summary.branch}\` — ${commits}, ${files}, branched from ${summary.origin ?? summary.base ?? 'unknown'}.`;
}
