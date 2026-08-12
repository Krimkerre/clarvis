import * as vscode from 'vscode';
import { join } from 'path';
import { branchNameFor, adviseOnGit, GitProblem, isAgentBranch } from './branchNames';
import { CommitPlan, planCommit } from './dirtyAtStart';
import { hasGitBinary } from './gitBinary';

/** What `begin()` managed, and what the user needs told about it. */
export interface Isolation {
  isolated: boolean;
  branch?: string;
  /** Said before any work happens, when the arrangement is not the usual one. */
  advice?: string;
}

/**
 * The sentence for a run built on top of another run.
 *
 * Ends with the remedy rather than the diagnosis: the situation is recoverable in one
 * command, and a warning that does not say how to stop recurring is just a complaint.
 */
function stackedAdvice(base: string | undefined, stacked: string): string {
  return (
    `I couldn't start from \`${base ?? 'your branch'}\`: you have unsaved changes to a file that ` +
    `differs between the two, and switching would have overwritten them. So this run sits on top of ` +
    `\`${stacked}\` and carries that run's changes as well as its own. Commit or stash those changes ` +
    `and the next run will start clean.`
  );
}

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

  /**
   * Files the user was already editing when the run began.
   *
   * Captured at `begin()` because that is the only moment the distinction exists: once
   * the run starts editing, a modified file looks the same whoever modified it.
   */
  private theirsAtStart: string[] = [];

  /** What the last commit deliberately left alone, for the closing line. */
  private lastHeldBack: string[] = [];

  get heldBack(): string[] {
    return this.lastHeldBack;
  }

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
  async begin(task: string): Promise<Isolation> {
    const repository = this.repository();

    if (!repository) {
      const problem = await diagnoseGit();
      this.log(`branch: not isolating — ${problem}`);
      return { isolated: false, advice: adviseOnGit(problem).message };
    }

    const existing: string[] = (await repository.getBranches({ remote: false })).map(
      (branch: { name?: string }) => branch.name ?? ''
    );

    const head = repository.state.HEAD?.name;
    const base = await this.baseFor(head, existing);
    this.noteTheirWork(repository);

    const name = branchNameFor(task, existing);

    // First choice: start at the base, whatever we are standing on now.
    if (base && head && base !== head && (await this.startAt(repository, name, base, base))) {
      return { isolated: true, branch: name };
    }

    // Second: start here. Fine from an ordinary branch, and a stacked run from an
    // agent branch — which is worth a sentence, because it changes what merging means.
    if (await this.startAt(repository, name, undefined, head)) {
      const stacked = head && isAgentBranch(head) ? head : undefined;
      return { isolated: true, branch: name, advice: stacked && stackedAdvice(base, stacked) };
    }

    // Neither worked: a detached HEAD, or a hook refusing the checkout. Not worth
    // failing the run over — checkpoints still cover undo.
    return {
      isolated: false,
      advice: "I couldn't create a branch to work on, so I'll snapshot files instead and you can undo the run.",
    };
  }

  /**
   * Where a run should start from.
   *
   * **The user's branch, not the last run's.** A finished run leaves the editor on
   * `clarvis/<task>`, so a second task would otherwise branch off the first — stacking
   * unrelated work and letting a bad first run poison the second. Observed live: run two
   * branched off run one.
   */
  private async baseFor(head: string | undefined, existing: string[]): Promise<string | undefined> {
    const base = head && !isAgentBranch(head) ? head : this.rememberedBase(existing);
    if (base && !isAgentBranch(base)) await this.memento?.update(BASE_BRANCH_KEY, base);
    return base;
  }

  /** Whatever the user had in flight. Recorded even when isolation fails — especially then. */
  private noteTheirWork(repository: GitRepository): void {
    this.theirsAtStart = workingTreePaths(repository);
    if (this.theirsAtStart.length > 0) {
      // "already modified" was wrong: the list includes untracked files, which the user
      // created rather than edited. Both are theirs and both are held back — the wording
      // was the only thing claiming otherwise.
      this.log(`branch: ${this.theirsAtStart.length} file(s) already in flight — those stay the user's`);
    }
  }

  /**
   * Creates the branch and switches to it, reporting whether it worked.
   *
   * **Created *at* a ref rather than checked out and then branched.** The first version
   * switched to `master` first, and a dirty working tree fails that switch — at which
   * point it branched from wherever it happened to be, which was the previous run's
   * branch. `createBranch(name, checkout, ref)` needs no intermediate switch, so the
   * ordinary dirty-tree case starts from the right place instead of the nearest one.
   *
   * `false` rather than a throw: both callers treat failure as "try the next option",
   * and the last one turns it into an honest refusal.
   */
  private async startAt(
    repository: GitRepository,
    name: string,
    ref: string | undefined,
    /**
     * Where the user was, passed in rather than read back afterwards.
     *
     * Read from `HEAD` after the call it would be the branch just created, since the
     * switch has already happened — so undo would offer to return you to the very branch
     * you were undoing. Caught by re-reading this refactor, not by a test.
     */
    previous: string | undefined
  ): Promise<boolean> {
    try {
      await repository.createBranch(name, true, ref);
      this.created = name;
      this.previousBranch = previous;
      this.log(`branch: working on ${name}, started from ${previous ?? 'detached'}`);
      return true;
    } catch (error) {
      this.log(`branch: could not start from ${ref ?? 'here'} (${String(error)})`);
      return false;
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

    // Files the user was already editing are theirs, whatever this run did to them.
    const plan: CommitPlan = planCommit(files, this.theirsAtStart);
    this.lastHeldBack = plan.heldBack;

    if (plan.heldBack.length > 0) {
      this.log(`branch: not committing ${plan.heldBack.join(', ')} — modified before the run started`);
    }
    if (plan.commit.length === 0) {
      this.log('branch: nothing to commit that was not already the user\'s');
      return undefined;
    }

    const root = repository.rootUri?.fsPath;

    try {
      await repository.add(root ? plan.commit.map((file) => join(root, file)) : plan.commit);
      await repository.commit(message, { all: false });

      // The hash is what lets a later review tell this run's commits from the user's
      // own — author and message are both written in the same voice.
      const hash = repository.state.HEAD?.commit;
      this.log(`branch: committed ${plan.commit.length} file(s) — ${message}`);
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

/**
 * Why there is no repository to work in, once one is confirmed absent.
 *
 * Three causes that look the same through the API and need three different sentences:
 * the extension is off, git is not installed, or this is simply not a repository. The
 * binary is only checked once the first two are ruled out — it costs a process spawn
 * and is the least likely of them.
 */
async function diagnoseGit(): Promise<GitProblem> {
  if (!gitExtension()) return 'no-extension';
  return (await hasGitBinary()) ? 'no-repository' : 'no-binary';
}

/**
 * Whether a run could isolate on a branch right now, probed fresh (§4.0).
 *
 * Exported so the offer to fix it can run *before* a task starts — asking "shall I run
 * `git init`?" only after the run has already failed to isolate is a worse experience
 * than asking up front, and it is also how the offer went missing entirely: nothing
 * outside `begin()` ever looked.
 */
export async function probeGitProblem(): Promise<GitProblem | undefined> {
  const api = gitExtension()?.exports?.getAPI?.(1);
  if ((api?.repositories?.length ?? 0) > 0) return undefined;

  return diagnoseGit();
}

/** The slice of the Git extension's API this file uses. */
interface GitExports {
  getAPI(version: 1): { repositories: GitRepository[] };
}

interface GitRepository {
  state: {
    HEAD?: { name?: string; commit?: string };
    /** Modified-but-uncommitted files, as the Git extension reports them. */
    workingTreeChanges?: { uri: { fsPath: string } }[];
    indexChanges?: { uri: { fsPath: string } }[];
    /** Present only on newer versions; older ones fold these into the working tree. */
    untrackedChanges?: { uri: { fsPath: string } }[];
  };
  rootUri?: { fsPath: string };
  getBranches(query: { remote: boolean }): Promise<{ name?: string }[]>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  checkout(name: string): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string, options?: { all: boolean }): Promise<void>;
  log(options: { range: string }): Promise<unknown[]>;
  deleteBranch(name: string, force: boolean): Promise<void>;
}

/**
 * What the user already had in flight, as workspace-relative paths.
 *
 * Every list, because a staged change is as much theirs as an unstaged one, and a file
 * git has never seen is theirs too — `git commit` would take the first along without
 * being asked, and the run has no business committing the others either.
 *
 * Relative rather than absolute so it compares directly against the paths the run
 * records, which `canonicalRelative` has already normalised for case.
 */
function workingTreePaths(repository: GitRepository): string[] {
  const root = repository.rootUri?.fsPath;
  // All three lists. Newer Git-extension versions report untracked files in their own
  // array rather than inside `workingTreeChanges`, and missing them would mean a run
  // could commit a file the user had just created.
  const changes = [
    ...(repository.state.workingTreeChanges ?? []),
    ...(repository.state.indexChanges ?? []),
    ...(repository.state.untrackedChanges ?? []),
  ];

  return changes.map((change) =>
    root ? vscode.workspace.asRelativePath(change.uri.fsPath, false) : change.uri.fsPath
  );
}

/**
 * Puts the editor back on a branch, for undo.
 *
 * A free function rather than a method: undo runs from a command long after the
 * `AgentBranch` that made the run has gone, and reconstructing one to call `checkout`
 * would be pretending the object survived when it did not.
 *
 * Returns why it could not, rather than throwing — a failed switch is a thing the user
 * needs told, not an error that abandons the restore that follows it.
 */
export async function returnToBranch(
  name: string,
  log: (message: string) => void
): Promise<{ moved: boolean; reason?: string }> {
  const repository = gitExtension()?.exports.getAPI(1).repositories[0];
  if (!repository) return { moved: false, reason: 'no repository' };

  if (repository.state.HEAD?.name === name) return { moved: true };

  try {
    await repository.checkout(name);
    log(`branch: undo returned to ${name}`);
    return { moved: true };
  } catch (error) {
    log(`branch: undo could not return to ${name} (${String(error)})`);
    return { moved: false, reason: String(error) };
  }
}
