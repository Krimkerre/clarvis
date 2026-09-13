/**
 * Git for a Codex task: the branch it works on and the commit that saves its work
 * (plan.md M15, C2a; design §5.1 step 2, §5.5 "result.files", §5.6).
 *
 * **Clarvis runs git; RAVIS never does.** A task starts the way a run of Clarvis's own engine does — a
 * checkpoint, a copy of every file at risk, its own `clarvis/<task>` branch — and its work is committed on
 * that branch when it settles, by the one window holding RAVIS's settle claim.
 *
 * **What the commit covers.** A window that started the task knows which files were already changed
 * before Codex began: those stay the owner's, as they do for Clarvis's own engine (`planCommit`), and the
 * commit takes what Codex reported changing plus anything else changed since (a command that rewrote a
 * lock file reports no file change). A window that picked the task up later doesn't know what was the
 * owner's, so it commits only what Codex reported — never a sweep of files it can't vouch for.
 *
 * **The branch is checked.** A window saving work for a session whose branch isn't the one checked out
 * says so and saves nothing (design §5.6: HEAD off the task branch at settle).
 *
 * vscode glue over `AgentBranch`, `Checkpoint` and the Git extension; the decisions it relies on are tested
 * where they live (`dirtyAtStart.ts`, `atRisk.ts`, `runCore.test.ts` for when it is called).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { AgentBranch } from '../../agent/AgentBranch';
import { atRiskPaths, type Change } from '../../agent/atRisk';
import { Checkpoint } from '../../agent/Checkpoint';
import { commitSubject } from '../../agent/commitSubject';
import { planCommit } from '../../agent/dirtyAtStart';
import { workspaceRepository } from '../../agent/gitExtension';
import type { RootedRepository } from '../../agent/repositoryForFolder';
import { GitFacts } from '../checkpoint/gitFacts';
import type { CodexBranch, CodexGit, CodexSave } from './runCore';

interface Repository extends RootedRepository {
  state: {
    HEAD?: { name?: string; commit?: string };
    workingTreeChanges?: Change[];
    indexChanges?: Change[];
    untrackedChanges?: Change[];
  };
  add(paths: string[]): Promise<void>;
  commit(message: string, options: { all: boolean }): Promise<void>;
}

/** Scratch space Codex's commands may use; never committed (design §5.5). */
const SCRATCH = `.clarvis${path.sep}tmp${path.sep}`;

export class CodexGitGlue implements CodexGit {
  private readonly branch: AgentBranch;
  private readonly checkpoint: Checkpoint;
  private task = '';
  /** Files already changed when this window started the task; unknown to a window that picked it up. */
  private dirtyAtStart: string[] | undefined;
  private savedOn: string | undefined;

  constructor(
    context: vscode.ExtensionContext,
    private readonly root: string,
    private readonly log: (line: string) => void
  ) {
    this.branch = new AgentBranch(log, context.workspaceState);
    this.checkpoint = new Checkpoint(context, root, log);
  }

  /** The branch the work is on, and the one the owner started from. */
  get branches(): { working?: string; startedFrom?: string } {
    return { working: this.branch.current ?? this.savedOn, startedFrom: this.branch.previous };
  }

  async begin(task: string): Promise<CodexBranch> {
    this.task = task;
    await this.checkpoint.begin(task);
    await this.checkpoint.captureAll(this.branch.atRisk());
    const repository = await workspaceRepository<Repository>();
    this.dirtyAtStart = repository ? this.changedPaths(repository) : [];
    const isolation = await this.branch.begin(task);
    await this.checkpoint.noteBranch(this.branch.previous);
    const head = repository?.state.HEAD?.commit;
    if (isolation.isolated && this.branch.current && head) return { ok: true, branch: this.branch.current, headCommit: head };
    await this.branch.discardIfEmpty();
    return { ok: false, line: needsGitLine(isolation.advice) };
  }

  /**
   * A task switched to Codex (C3; review B2): the undo snapshot as for a new task, then its existing branch checked out
   * at or after the commit the other engine saved — refused, with the reason, when that branch is missing or moved.
   * The commit it stands on is read from git itself, not the Git extension's state, which catches up later.
   */
  async continueOn(branch: string, headCommit: string): Promise<CodexBranch> {
    await this.checkpoint.begin(this.task || `Carrying on ${branch}`);
    await this.checkpoint.captureAll(this.branch.atRisk());
    const repository = await workspaceRepository<Repository>();
    this.dirtyAtStart = repository ? this.changedPaths(repository) : [];
    const isolation = await this.branch.continueOn({ branch, headCommit, theirs: this.dirtyAtStart });
    await this.checkpoint.noteBranch(this.branch.previous);
    const head = isolation.isolated ? (await new GitFacts(this.root).head()).commit : undefined;
    if (head) return { ok: true, branch, headCommit: head };
    return { ok: false, line: isolation.advice ?? `Codex couldn't carry the task on on \`${branch}\`, so nothing was started.` };
  }

  async save(work: SaveWork): Promise<CodexSave> {
    const repository = await workspaceRepository<Repository>();
    const refusal = this.saveRefusal(repository, work.branch);
    return refusal ? { ok: false, line: refusal } : this.commitWork(repository as Repository, work);
  }

  /** Why nothing may be saved from here: no repository, or HEAD isn't the task's branch (design §5.6). */
  private saveRefusal(repository: Repository | undefined, sessionBranch: string | undefined): string | undefined {
    if (!repository) return "There's no git repository here any more, so Codex's work wasn't saved.";
    const expected = this.branch.current ?? sessionBranch;
    const head = repository.state.HEAD?.name;
    return expected && head === expected ? undefined : offBranchLine(expected, head);
  }

  private async commitWork(repository: Repository, work: SaveWork): Promise<CodexSave> {
    const files = this.filesToCommit(repository, work.files);
    const hash = files.length > 0 ? await this.commit(repository, commitMessage(this.task, work), files) : undefined;
    this.savedOn = this.branch.current ?? work.branch;
    if (hash === undefined) return { ok: true, commit: headCommit(repository), committed: false, files: [] };
    return { ok: true, commit: hash, committed: true, files };
  }

  async abandon(): Promise<void> {
    await this.branch.discardIfEmpty();
  }

  private filesToCommit(repository: Repository, reported: string[]): string[] {
    const codexFiles = reported.filter((file) => this.inside(file));
    if (this.dirtyAtStart === undefined) return codexFiles;
    const everything = [...new Set([...codexFiles, ...this.changedPaths(repository)])];
    return planCommit(everything, this.dirtyAtStart).commit;
  }

  /** Modified, staged and untracked paths, relative to the root, inside it, scratch space excluded. */
  private changedPaths(repository: Repository): string[] {
    return atRiskPaths(repository.state)
      .map((file) => path.relative(this.root, file))
      .filter((file) => this.inside(file));
  }

  private inside(file: string): boolean {
    const relative = path.normalize(file);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.startsWith(SCRATCH);
  }

  private async commit(repository: Repository, message: string, files: string[]): Promise<string | undefined> {
    try {
      await repository.add(files.map((file) => path.join(this.root, file)));
      await repository.commit(message, { all: false });
      const hash = repository.state.HEAD?.commit;
      this.log(`codex: committed ${files.length} file(s) — ${message.split('\n')[0]}`);
      return hash;
    } catch (error) {
      this.log(`codex: the commit failed (${String(error)})`);
      return undefined;
    }
  }
}

type SaveWork = { summary: string; stopped: boolean; files: string[]; branch: string | undefined; forSwitch?: boolean };

function headCommit(repository: Repository): string {
  return repository.state.HEAD?.commit ?? '';
}

function commitMessage(task: string, work: { summary: string; stopped: boolean; forSwitch?: boolean }): string {
  const subject = commitSubject(work.summary, task || 'Codex task');
  const lead = work.stopped ? "Codex's work, stopped part-way" : 'Codex';
  // Design §6.2 step 4: the commit says the work was stopped to hand the task over, not abandoned.
  const head = work.forSwitch ? `Codex's work on ${subject} (stopped for a switch)` : `${lead}: ${subject}`;
  return task ? `${head}\n\nTask: ${task}` : head;
}

function needsGitLine(advice: string | undefined): string {
  const why = "Codex needs this folder to be a git repository with at least one commit: its work is saved as commits on a branch of its own.";
  return advice ? `${why} ${advice}` : why;
}

function offBranchLine(expected: string | undefined, head: string | undefined): string {
  if (!expected) return "Codex's branch isn't known here, so its work wasn't saved from this editor.";
  return `This editor is on ${head ?? 'no branch'}, not Codex's branch ${expected}, so its work wasn't saved. Switch to ${expected}, then open the task again.`;
}
