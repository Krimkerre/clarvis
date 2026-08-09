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

/** Whether a branch belongs to Clarvis, for cleanup and for the undo path. */
export function isAgentBranch(name: string): boolean {
  return name.startsWith('clarvis/');
}

/**
 * What is wrong with git here, and what would fix it.
 *
 * §4.6 requires the *cause-specific* remedy rather than a generic "git is
 * unavailable": `git init` and "install git" are entirely different problems, and a
 * user told the wrong one goes looking in the wrong place.
 */
export type GitProblem = 'no-extension' | 'no-repository' | 'ok';

export interface GitAdvice {
  problem: GitProblem;
  message: string;
  /** The offer to make, if any — the label of the action button. */
  action?: string;
}

export function adviseOnGit(problem: GitProblem): GitAdvice {
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
