import { randomBytes } from 'crypto';

import type { TaskNote } from '../bridge/activity';

/**
 * Where a task NERVIS handed over has got to, told as §6.4's `clarvis.task.*` (the owner's decision of 16 Sep
 * 2026: a Clarvis "task" is a handover from NERVIS).
 *
 * **Remembered per workspace, because the file is not.** NERVIS's `clarvis-task.md` is deleted once the
 * interview's first answers are saved, and the task goes on for days after — planned, built a milestone at a
 * time, across reloads. Each handover has its own folder, opened as its own workspace, so one remembered task per
 * workspace is the whole model. `vscode`-free: the host hands in `workspaceState` and the activity.
 *
 * **Telling never stops the work.** The note goes to `Activity`, which swallows a failing listener; a failure to
 * remember is logged by the caller and the task carries on untracked.
 */

export const TRACKED_TASK_KEY = 'clarvis.nervisTask';

export type TaskStage = NonNullable<TaskNote['stage']>;

export interface TrackedTask {
  readonly id: string;
  readonly stage: TaskStage;
}

export interface TaskStore {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

const VALID_ID = /^nt_[0-9a-f]{16}$/;

/** A handover's id as NERVIS writes it. One written before NERVIS wrote ids gets one here, so it is still followed. */
export function mintTaskId(): string {
  return `nt_${randomBytes(8).toString('hex')}`;
}

export class NervisTaskTrack {
  constructor(
    private readonly store: TaskStore,
    private readonly tell: (note: TaskNote) => void,
    private readonly mint: () => string = mintTaskId
  ) {}

  /** The task this workspace is following, if any. */
  current(): TrackedTask | undefined {
    const held = this.store.get(TRACKED_TASK_KEY) as Partial<TrackedTask> | undefined;
    return held && typeof held.id === 'string' && VALID_ID.test(held.id) && typeof held.stage === 'string'
      ? { id: held.id, stage: held.stage }
      : undefined;
  }

  /** A handover was picked up: its planning begins. A second handover in the same workspace replaces the first. */
  async pickedUp(taskId: string | undefined): Promise<void> {
    const held = this.current();
    const planning = held?.stage === 'planning' ? held.id : undefined;
    // An id-less handover offered again keeps the id it was given the first time.
    const id = taskId && VALID_ID.test(taskId) ? taskId : (planning ?? this.mint());
    // The same handover offered again — a window closed at the first question — is the same pickup.
    if (id === planning) return;
    await this.moveTo({ id, stage: 'planning' });
  }

  /** A run from the task's plan began. */
  async building(): Promise<void> {
    await this.stage('building');
  }

  /** That run ended with the plan not yet finished — stopped, failed, or a milestone done and the next waiting. */
  async paused(): Promise<void> {
    await this.stage('paused');
  }

  /** The whole plan is built: the task is done, and no longer followed. */
  async finished(): Promise<void> {
    const task = this.current();
    if (!task) return;
    await this.store.update(TRACKED_TASK_KEY, undefined);
    this.tell({ kind: 'task', phase: 'completed', taskId: task.id, outcome: 'built' });
  }

  /** Said only on a change: a stage told twice is one stage. */
  private async stage(stage: TaskStage): Promise<void> {
    const task = this.current();
    if (!task || task.stage === stage) return;
    await this.moveTo({ id: task.id, stage });
  }

  private async moveTo(task: TrackedTask): Promise<void> {
    await this.store.update(TRACKED_TASK_KEY, task);
    this.tell({ kind: 'task', phase: 'started', taskId: task.id, stage: task.stage });
  }
}
