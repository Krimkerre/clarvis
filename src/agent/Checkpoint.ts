import * as vscode from 'vscode';
import { returnToBranch } from './AgentBranch';
import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Undo for a whole agent run.
 *
 * Git covers committed work and VS Code's undo stack covers a single edit, but neither
 * covers *"the agent touched nine files across four steps and the result is wrong"* —
 * especially when some of those files were never committed in the first place. So
 * every file is copied before it is first modified, and the copies are kept until the
 * next run replaces them.
 *
 * Deliberately **not** a git operation. Uncommitted work is the case that matters most
 * here, and any git-based undo would either discard it or refuse to run.
 */

/** One file, as it was before the run touched it. */
interface CheckpointEntry {
  /** Workspace-relative, so a moved project does not invalidate the record. */
  file: string;
  /** Where the copy lives. Absent when the file did not exist — see `created`. */
  copy?: string;
  /** True when the agent created this file, so undo means deleting it. */
  created: boolean;
}

interface CheckpointRecord {
  task: string;
  startedAt: number;
  entries: CheckpointEntry[];
  /**
   * The branch the user was on when the run began.
   *
   * Undo restored the files and left you standing on the run's branch, which is only
   * half an undo: the working tree said the run never happened while the editor still
   * said you were inside it.
   */
  startedOn?: string;
}

const RECORD_KEY = 'clarvis.agent.checkpoint';

/**
 * Snapshots files before an agent changes them.
 *
 * One checkpoint per run, holding the state at the moment the run began — not a
 * per-step history. Multi-level undo sounds better than it is: after a failed run the
 * question is "put it back how it was", and a stack of nine partial states is a
 * decision nobody wants to make while annoyed.
 */
export class Checkpoint {
  private record: CheckpointRecord | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly root: string | undefined,
    private readonly log: (message: string) => void
  ) {}

  /** Where copies are kept. Outside the workspace, so a checkpoint never becomes a diff. */
  private get storeDir(): string {
    return path.join(this.context.globalStorageUri.fsPath, 'checkpoint');
  }

  /**
   * Starts a run, discarding any previous checkpoint.
   *
   * The old copies go at *start* rather than at the end of the previous run, so a run
   * that crashed halfway still leaves its checkpoint behind to be undone.
   */
  async begin(task: string): Promise<void> {
    await this.clearStore();
    this.record = { task, startedAt: Date.now(), entries: [] };
    await this.context.globalState.update(RECORD_KEY, this.record);
    this.log(`checkpoint: started for "${task}"`);
  }

  /**
   * Remembers where the user was, once the branch layer has worked out where that is.
   *
   * Separate from `begin()` because the checkpoint is deliberately created *before* any
   * branching happens — undo has to work even when isolation failed — so the branch is
   * not known yet at that point.
   */
  async noteBranch(name: string | undefined): Promise<void> {
    if (!this.record || !name) return;
    this.record.startedOn = name;
    await this.context.globalState.update(RECORD_KEY, this.record);
  }

  /**
   * Records a file's current state, once.
   *
   * Called before every write. Repeat calls for the same file are ignored — the
   * checkpoint holds the state at the *start* of the run, so the second edit to a file
   * must not overwrite the copy made before the first.
   */
  async capture(absolutePath: string): Promise<void> {
    if (!this.record || !this.root) return;

    const relative = path.relative(this.root, absolutePath);
    if (this.record.entries.some((entry) => entry.file === relative)) return;

    let entry: CheckpointEntry;

    try {
      const contents = await fs.readFile(absolutePath);
      const copy = path.join(this.storeDir, `${this.record.entries.length}-${path.basename(relative)}`);

      await fs.mkdir(this.storeDir, { recursive: true });
      await fs.writeFile(copy, contents);
      entry = { file: relative, copy, created: false };
    } catch {
      // No such file: the agent is about to create it, and undo means removing it.
      entry = { file: relative, created: true };
    }

    this.record.entries.push(entry);
    await this.context.globalState.update(RECORD_KEY, this.record);
    this.log(`checkpoint: captured ${relative}${entry.created ? ' (new file)' : ''}`);
  }

  /** What the last run touched, for the undo prompt. */
  static stored(context: vscode.ExtensionContext): CheckpointRecord | undefined {
    return context.globalState.get<CheckpointRecord>(RECORD_KEY);
  }

  /**
   * Puts every captured file back, and deletes the ones that were created.
   *
   * Returns what it did rather than announcing it: the caller owns the wording, and a
   * restore that silently half-worked is the worst possible outcome, so failures are
   * counted and reported instead of swallowed.
   */
  static async undo(
    context: vscode.ExtensionContext,
    root: string | undefined,
    log: (message: string) => void
  ): Promise<{ restored: number; deleted: number; failed: string[]; stuckOn?: string }> {
    const record = Checkpoint.stored(context);
    if (!record || !root) return { restored: 0, deleted: 0, failed: [] };

    // **Branch first, then files.** Proven the other way round: with the pre-run content
    // already written back, git refuses the switch — the file is modified relative to
    // the run's own commit, and that it happens to match the target's content is not
    // something git will take on trust. Moving first leaves a clean tree to switch from.
    let stuckOn: string | undefined;
    if (record.startedOn) {
      const back = await returnToBranch(record.startedOn, log);
      if (!back.moved) stuckOn = record.startedOn;
    }

    let restored = 0;
    let deleted = 0;
    const failed: string[] = [];

    for (const entry of record.entries) {
      const target = path.join(root, entry.file);

      try {
        if (entry.created) {
          await fs.rm(target, { force: true });
          deleted++;
        } else if (entry.copy) {
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(entry.copy, target);
          restored++;
        }
      } catch (error) {
        // One unwritable file must not abandon the other eight.
        failed.push(entry.file);
        log(`checkpoint: could not restore ${entry.file} (${String(error)})`);
      }
    }

    log(`checkpoint: undo restored ${restored}, deleted ${deleted}, failed ${failed.length}`);
    return { restored, deleted, failed, stuckOn };
  }

  private async clearStore(): Promise<void> {
    try {
      await fs.rm(this.storeDir, { recursive: true, force: true });
    } catch {
      // Nothing there yet, which is the normal first-run case.
    }
  }
}
