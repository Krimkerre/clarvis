import * as vscode from 'vscode';
import { branchNameFor, adviseOnGit, GitProblem, isAgentBranch } from './branchNames';

/** The branch runs start from, remembered so a second run does not stack on the first. */
const BASE_BRANCH_KEY = 'clarvis.agent.baseBranch';

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

  constructor(
    private readonly log: (message: string) => void,
    /** Where the base branch is remembered between runs. */
    private readonly memento?: { get(key: string): string | undefined; update(key: string, value: string): Thenable<void> }
  ) {}

  /** The branch this run is on, if it managed to make one. */
  get current(): string | undefined {
    return this.created;
  }

  /** The branch the user was on before the run, for telling them where they are now. */
  get previous(): string | undefined {
    return this.previousBranch;
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

    const head = repository.state.HEAD?.name;

    // **Branch from the user's branch, not from the last run's.** A finished run leaves
    // the editor on `clarvis/<task>`, so a second task would otherwise branch off the
    // first — stacking unrelated work and making a bad first run poison the second.
    // Observed in a live session: run two branched off run one.
    const base = head && !isAgentBranch(head) ? head : this.rememberedBase(existing);
    if (base && head && base !== head) {
      try {
        await repository.checkout(base);
        this.log(`branch: returned to ${base} before starting a new run`);
      } catch (error) {
        // A dirty tree can block the checkout. Better to branch from here than to
        // refuse the run outright.
        this.log(`branch: could not return to ${base} (${String(error)}), branching from ${head}`);
      }
    }

    if (base && !isAgentBranch(base)) await this.memento?.update(BASE_BRANCH_KEY, base);

    const name = branchNameFor(task, existing);
    this.previousBranch = base ?? head;

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
  async commit(message: string, files: string[]): Promise<string | undefined> {
    const repository = this.repository();
    if (!repository || !this.created || files.length === 0) return undefined;

    try {
      await repository.add(files);
      await repository.commit(message, { all: false });

      // The hash is what lets a later review tell this run's commits from the user's
      // own — author and message are both written in the same voice.
      const hash = repository.state.HEAD?.commit;
      this.log(`branch: committed ${files.length} file(s) — ${message}`);
      return hash;
    } catch (error) {
      this.log(`branch: commit failed (${String(error)})`);
      return undefined;
    }
  }

  /**
   * Removes the run's branch when it holds nothing.
   *
   * A task like "make a branch called testing3" changes no files and makes no commits
   * — the work happened elsewhere — so the isolation branch is left behind as clutter
   * nobody asked for, and the review wizard then offers five options about an empty
   * branch.
   *
   * **Emptiness is verified against git, not assumed from our own bookkeeping.** A run
   * can commit through `runCommand` without going through `commit()` above, and
   * deleting a branch because we did not notice work happening would be the worst
   * possible bug in this file. Returns whether it actually removed anything.
   */
  async discardIfEmpty(): Promise<boolean> {
    const repository = this.repository();
    if (!repository || !this.created || !this.previousBranch) return false;

    try {
      const commits = await repository.log({ range: `${this.previousBranch}..${this.created}` });
      if (commits.length > 0) return false;

      // **The run may have moved on purpose.** "Change to the milestone branch" ends
      // with the user somewhere else by request — and tidying up by returning them to
      // where they started silently undoes the thing they asked for. Seen live.
      const head = repository.state.HEAD?.name;
      if (head !== this.created) {
        await repository.deleteBranch(this.created, false);
        this.log(`branch: removed ${this.created}; left you on ${head ?? 'where the run put you'}`);
        this.created = undefined;
        return true;
      }

      await repository.checkout(this.previousBranch);
      await repository.deleteBranch(this.created, false);
      this.log(`branch: removed ${this.created}, it held nothing`);

      this.created = undefined;
      return true;
    } catch (error) {
      // A failure here costs a stray branch, which is exactly what it was cleaning up.
      this.log(`branch: could not remove the empty branch (${String(error)})`);
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

  /**
   * The branch to start from when HEAD is already one of ours.
   *
   * Falls back to whatever looks like a main branch rather than guessing wrong: being
   * on an agent branch with nothing remembered is a rare state, and branching from a
   * plausible base beats branching from the previous task's work.
   */
  private rememberedBase(existing: string[]): string | undefined {
    const remembered = this.memento?.get(BASE_BRANCH_KEY);
    if (remembered && existing.includes(remembered)) return remembered;

    return ['main', 'master', 'develop'].find((name) => existing.includes(name));
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
  state: { HEAD?: { name?: string; commit?: string } };
  getBranches(query: { remote: boolean }): Promise<{ name?: string }[]>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  checkout(name: string): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string, options?: { all: boolean }): Promise<void>;
  log(options: { range: string }): Promise<unknown[]>;
  deleteBranch(name: string, force: boolean): Promise<void>;
}
