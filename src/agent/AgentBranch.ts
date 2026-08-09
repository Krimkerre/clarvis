import * as vscode from 'vscode';
import { branchNameFor, adviseOnGit, GitProblem } from './branchNames';

/**
 * Keeping an agent run off the user's branch.
 *
 * The safety story is not only "it asks before dangerous things" — it is that a whole
 * run can be thrown away without touching what the user was doing. A branch does that
 * far better than a pile of file copies: the work stays reviewable as a diff, and
 * discarding it is one command.
 *
 * Git is **probed, never assumed** (§4.0). A folder that is not a repository, or a host
 * with the Git extension disabled, is an ordinary state — so the run continues on
 * checkpoints alone rather than refusing to start.
 */
export class AgentBranch {
  /** The branch the user was on, so it can be restored. */
  private previousBranch: string | undefined;
  private created: string | undefined;

  constructor(private readonly log: (message: string) => void) {}

  /** The branch this run is on, if it managed to make one. */
  get current(): string | undefined {
    return this.created;
  }

  /**
   * Creates and switches to `clarvis/<task>`, or explains why it couldn't.
   *
   * Returns whether isolation is in force, because the caller must tell the user which
   * world they are in — an agent editing your working branch is a different proposition
   * from one editing its own, and quietly doing the former would be a betrayal.
   */
  async begin(task: string): Promise<{ isolated: boolean; branch?: string; advice?: string }> {
    const repository = this.repository();

    if (!repository) {
      const problem: GitProblem = gitExtension() ? 'no-repository' : 'no-extension';
      const advice = adviseOnGit(problem);
      this.log(`branch: not isolating — ${problem}`);
      return { isolated: false, advice: advice.message };
    }

    const existing: string[] = (await repository.getBranches({ remote: false })).map(
      (branch: { name?: string }) => branch.name ?? ''
    );

    const name = branchNameFor(task, existing);
    this.previousBranch = repository.state.HEAD?.name;

    try {
      await repository.createBranch(name, true);
      this.created = name;
      this.log(`branch: working on ${name} (was ${this.previousBranch ?? 'detached'})`);
      return { isolated: true, branch: name };
    } catch (error) {
      // Dirty tree, detached HEAD, a hook refusing the checkout. None of these are
      // worth failing the run over — checkpoints still cover undo.
      this.log(`branch: could not create ${name} (${String(error)})`);
      return {
        isolated: false,
        advice: "I couldn't create a branch to work on, so I'll snapshot files instead and you can undo the run.",
      };
    }
  }

  /**
   * Commits **only the files this run touched**, onto Clarvis's own branch.
   *
   * Never `git add -A` (§4.6). The user's unrelated work-in-progress is theirs, and
   * sweeping it into an agent commit is how someone loses track of what they changed
   * versus what a machine did.
   */
  async commit(message: string, files: string[]): Promise<boolean> {
    const repository = this.repository();
    if (!repository || !this.created || files.length === 0) return false;

    try {
      await repository.add(files);
      await repository.commit(message, { all: false });
      this.log(`branch: committed ${files.length} file(s) — ${message}`);
      return true;
    } catch (error) {
      this.log(`branch: commit failed (${String(error)})`);
      return false;
    }
  }

  /**
   * Puts the user back on the branch they started on.
   *
   * The agent's branch is **left in place**, not deleted: it holds the work, and
   * deleting it as part of "undo" would discard the very thing someone might want to
   * look at before deciding. Removing it is a separate, deliberate act.
   */
  async restore(): Promise<void> {
    const repository = this.repository();
    if (!repository || !this.previousBranch) return;

    try {
      await repository.checkout(this.previousBranch);
      this.log(`branch: back on ${this.previousBranch}; ${this.created ?? 'the run branch'} kept`);
    } catch (error) {
      this.log(`branch: could not return to ${this.previousBranch} (${String(error)})`);
    }
  }

  private repository(): GitRepository | undefined {
    const api = gitExtension()?.exports?.getAPI?.(1);
    return api?.repositories?.[0];
  }
}

function gitExtension(): vscode.Extension<GitExports> | undefined {
  const extension = vscode.extensions.getExtension<GitExports>('vscode.git');
  return extension?.isActive ? extension : undefined;
}

/** The slice of the Git extension's API this file uses. */
interface GitExports {
  getAPI(version: 1): { repositories: GitRepository[] };
}

interface GitRepository {
  state: { HEAD?: { name?: string } };
  getBranches(query: { remote: boolean }): Promise<{ name?: string }[]>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  checkout(name: string): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string, options?: { all: boolean }): Promise<void>;
}
