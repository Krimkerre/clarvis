/**
 * Turning a task description into a branch name.
 *
 * Pure, because git's rules for a valid ref are fussier than they look and every one
 * of them fails at *commit* time rather than at branch-creation time — which would put
 * the failure several minutes into a run, after the agent has already edited files.
 */

/** Longer than this and the branch name stops being readable in a picker. */
const MAX_SLUG_LENGTH = 48;

/**
 * `clarvis/fix-the-failing-test`, from whatever the user actually typed.
 *
 * The prefix is not decoration: it is what makes the agent's branches identifiable at
 * a glance in `git branch`, and what lets a cleanup step know which ones are ours
 * rather than guessing from names.
 *
 * git forbids more than the obvious characters — a leading dot, `..`, `~^:?*[`, a
 * trailing `.lock`, consecutive or trailing slashes, and a trailing dot. Rather than
 * encoding each rule, everything outside a known-safe set is replaced, which is
 * stricter and cannot drift as git's rules change.
 */
export function branchNameFor(task: string, existing: string[] = []): string {
  const slug =
    task
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_SLUG_LENGTH)
      .replace(/-+$/, '') || 'task';

  const base = `clarvis/${slug}`;
  if (!existing.includes(base)) return base;

  // A second attempt at the same task is normal — the first one is often abandoned.
  // Reusing the name would either fail or, worse, resume someone else's branch.
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!existing.includes(candidate)) return candidate;
  }
}

/**
 * Whether a task can carry on where another engine left it (plan.md M15, C3; design §5.1, review B2 and N9).
 *
 * **Why it matters.** A switch between Codex and Clarvis's own engine, or a takeover, continues the *same* task.
 * Starting a new `clarvis/<task>` branch instead would leave the first engine's committed work on a branch the
 * second never sees — and the first engine's uncommitted leftovers would be held back as the owner's own work.
 * So the destination checks out the existing branch at the commit the source saved.
 *
 * **Refused, never guessed**, when the saved branch is missing, or its tip is neither the saved commit nor a
 * descendant of it: someone moved the branch away from the saved work, and carrying on there would build on
 * something else. A descendant is fine — the owner may have added a commit by hand.
 *
 * `headIsAncestor` is whether `headCommit` is an ancestor of `tip`, which the caller asks git.
 */
/** What a run needs to carry a task on on its branch (`AgentBranch.continueOn`). */
export interface BranchContinuation {
  branch: string;
  /** The commit the other engine saved: the branch's tip must be it or a descendant of it. */
  headCommit: string;
  /** Files the owner had in flight before the task started: never committed as the task's. */
  theirs: string[];
  /** A takeover: the old holder's uncommitted edits are committed first, with this message. */
  leftoversMessage?: string;
  /**
   * The branch the work counts as started from, when the caller knows it: a **Build on** names the branch its question
   * offered to start fresh from (plan.md M15). Used when it exists and isn't a `clarvis/*` branch; otherwise the
   * remembered base is. It is what the landing question offers to merge into, and it is never written as the remembered
   * base.
   */
  base?: string;
}

/**
 * Why a **Start fresh** can't go ahead, or undefined when it can (plan.md M15, "Build on Clarvis's own earlier work").
 *
 * **Start fresh means fresh.** When a new branch can't be made at the starting branch, `AgentBranch.begin` falls back to
 * starting where the checkout is. From a `clarvis/*` branch that stacks the new task on that run's work. That is the
 * history found live as eight `clarvis/*` branches in a straight line (`RunSession.close`), and after the owner chose to
 * start fresh it would build on the very work they turned down. So it is refused instead, and nothing is done.
 */
/**
 * The branch a continued task counts as started from (`AgentBranch.continueOn`): what undo returns to, and what the landing
 * question offers to merge into.
 *
 * **The base a Build on names**, when it is a real branch here and not a `clarvis/*` one (plan.md M15): the branch its
 * question offered to start fresh from. Otherwise, as before, the remembered base, else main, master or develop. The
 * remembered base is kept per editor, so without the named one the other editor would fall back to a guess, and a
 * project whose trunk is none of those three would get no landing question at all.
 */
export function continuationBase(named: string | undefined, existing: readonly string[], remembered: string | undefined): string | undefined {
  if (named && existing.includes(named) && !isAgentBranch(named)) return named;
  return startingBase(undefined, false, remembered, existing);
}

export function freshStartRefusal(fresh: boolean, head: string | undefined, base: string | undefined): string | undefined {
  if (!fresh || !head || !isAgentBranch(head)) return undefined;
  const from = base ? `from \`${base}\`` : 'from the starting branch';
  return `I couldn't start fresh ${from}, and starting on \`${head}\` instead would build on that work, which you chose not to. Nothing was done. If something in the folder needs committing or putting aside, doing that lets a fresh start work.`;
}

export type ContinuationDecision =
  | { kind: 'continue'; branch: string }
  | { kind: 'refuse'; reason: 'nothing_saved' | 'missing' | 'moved_away'; advice: string };

export function continuationDecision(
  branch: string | undefined,
  existing: readonly string[],
  tip: string | undefined,
  headCommit: string | undefined,
  headIsAncestor: boolean
): ContinuationDecision {
  if (!branch || !headCommit) {
    return { kind: 'refuse', reason: 'nothing_saved', advice: "There's no saved branch for this task, so it can't carry on where it stopped. Nothing was changed." };
  }
  if (!existing.includes(branch) || !tip) {
    return { kind: 'refuse', reason: 'missing', advice: `The task's branch \`${branch}\` isn't in this repository any more, so nothing was continued.` };
  }
  if (tip !== headCommit && !headIsAncestor) {
    return {
      kind: 'refuse',
      reason: 'moved_away',
      advice: `\`${branch}\` no longer contains the saved work (commit ${headCommit.slice(0, 7)}), so nothing was continued. Look at the branch, then switch again.`,
    };
  }
  return { kind: 'continue', branch };
}

/** Whether a branch belongs to Clarvis, for cleanup and for the undo path. */
export function isAgentBranch(name: string): boolean {
  return name.startsWith('clarvis/');
}

/**
 * Whether HEAD's current name is a real place to come back to (F10's second edge).
 *
 * **An unborn HEAD names a branch that has never had a commit.** `git init` points
 * HEAD at `refs/heads/master` (or whatever `init.defaultBranch` says) before a single
 * commit exists, so `head` reads as `"master"` on a repository where `master` has
 * never really existed. Treated as an ordinary base, that produced an offer to "fold
 * it into `master` and put you back there" naming a place nothing could be folded
 * into or returned to — untested what accepting it would even do.
 */
export function isRealBase(head: string, unborn: boolean): boolean {
  return !unborn && !isAgentBranch(head);
}

/**
 * The branch a new task's `clarvis/<task>` branch starts from: the one `AgentBranch.begin` branches from.
 *
 * **HEAD, when it is a real base**; otherwise the base remembered from an earlier run, when that branch still exists;
 * otherwise whichever of `main`, `master` and `develop` exists. Never a literal `main`: a repository `git init` made
 * with `master` starts from `master`.
 *
 * Shared, not copied, because two places have to agree on it: `AgentBranch.begin` makes the branch here, and the
 * question before a Codex task names this branch in **Start fresh from …** (`codexLeftWork.ts`). A button naming one
 * branch while the task starts from another is the mistake a copy of this rule would eventually make.
 */
export function startingBase(head: string | undefined, unborn: boolean, remembered: string | undefined, existing: readonly string[]): string | undefined {
  if (head && isRealBase(head, unborn)) return head;
  if (remembered && existing.includes(remembered)) return remembered;
  return ['main', 'master', 'develop'].find((name) => existing.includes(name));
}

/**
 * What is wrong with git here, and what would fix it.
 *
 * §4.6 requires the *cause-specific* remedy rather than a generic "git is
 * unavailable": `git init` and "install git" are entirely different problems, and a
 * user told the wrong one goes looking in the wrong place.
 */
export type GitProblem = 'no-extension' | 'no-repository' | 'no-binary' | 'ok';

export interface GitAdvice {
  problem: GitProblem;
  message: string;
  /** The offer to make, if any — the label of the action button. */
  action?: string;
}

/**
 * Where to get git, per platform.
 *
 * Named commands rather than "install git": the audience (§6) may never have installed a
 * developer tool from a terminal, and "install git" is only advice if you already know
 * how. No action button — this is the one case Clarvis genuinely cannot do for them, and
 * a button that opens something unhelpful is worse than a sentence that is honest.
 */
export function gitInstallHint(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'On a Mac, `xcode-select --install` in Terminal is the shortest route.';
  if (platform === 'win32') return 'On Windows, git-scm.com has the installer.';
  return 'On Linux, your package manager has it — `apt install git` or `dnf install git`.';
}

export function adviseOnGit(problem: GitProblem, platform: NodeJS.Platform = process.platform): GitAdvice {
  // **Checked before "not a repository".** Without the binary the extension reports no
  // repositories at all, which looks identical to an ordinary folder — so Clarvis used
  // to offer to run `git init`, a button that could only fail. That is the exact thing
  // the M8 checklist says not to do.
  if (problem === 'no-binary') {
    return {
      problem,
      message: `Git isn't installed on this machine, so there is nothing for me to branch with. ${gitInstallHint(
        platform
      )} Until then I'll snapshot files before I change them, and the run can still be undone.`,
    };
  }

  if (problem === 'no-repository') {
    return {
      problem,
      message:
        "This folder isn't a git repository, so I can't work on a branch of my own. I can still snapshot files and undo the run — but without git, reviewing what I changed is harder than it should be.",
      action: 'Run git init',
    };
  }

  if (problem === 'no-extension') {
    return {
      problem,
      message:
        "VS Code's Git extension is disabled or missing, so I can't create a branch to work on. Enabling it in the Extensions view gets me a branch; without it I'll snapshot files instead.",
      action: 'Show me the extension',
    };
  }

  return { problem, message: 'Git is available.' };
}

/**
 * The sentence for a run built on top of another run.
 *
 * **Does not claim a specific cause.** The first version asserted "you have unsaved
 * changes to a file that differs between the two" unconditionally — true for the dirty-
 * tree case this was written for, and flatly wrong the day a fresh `git init` had never
 * had a first commit: the real reason was an unborn base ref, not a file conflict, and
 * the message stated the wrong one as fact. It says what is actually known — the switch
 * did not work — and ends with the remedy rather than a diagnosis nobody verified.
 */
export function stackedAdvice(base: string | undefined, stacked: string): string {
  // **Not `your branch` in backticks.** The fallback was written as a stand-in for a
  // branch name and reads as one: "I couldn't start cleanly from `your branch`" was
  // shown live, and quoting a phrase that is not a branch name makes it look like one
  // that is. When the name is unknown, the sentence says so instead of quoting a
  // placeholder.
  const from = base ? `from \`${base}\`` : 'from where you were';

  return (
    `I couldn't start cleanly ${from}, so this run sits on top of ` +
    `\`${stacked}\` and carries that run's changes as well as its own. If something there needs ` +
    `committing or stashing, doing that will let the next run start clean.`
  );
}
