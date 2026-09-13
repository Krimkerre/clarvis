/**
 * The checkpoint on disk, shared by both editors on this Mac (plan.md M15, C3; design §6.1).
 *
 * **Why a file in the git folder.** VS Code's `workspaceState` belongs to one editor, and a task started in the
 * browser editor can be carried on from desktop VS Code. So the checkpoint lives beside the checkout lock file:
 * `<git_dir>/clarvis-task-checkpoint.json` — inside `.git`, so it is never committed — or
 * `<root>/.clarvis/task-checkpoint.json` for a folder without git.
 *
 * **Written only while holding the project lock.** Every write asks the fence first (`stillHolds`: a revoked
 * lease, or a lock file naming another window, means no). A window that lost the project never writes the
 * checkpoint, just as it never commits (design §6.3).
 *
 * **Written whole or not at all.** A new temporary file in the same folder, created exclusively with mode
 * 0600, flushed, then renamed over the old one: a reader sees the old checkpoint or the new one, never half.
 *
 * **Read only as this project's.** A checkpoint that names another folder is reported as `other_project` and
 * never used (`taskCheckpoint.ts`). A file that can't be read is `unreadable`, not absent: not knowing is not
 * "no task here".
 *
 * vscode-free.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CHECKPOINT_MAX_BYTES, encodeCheckpoint, parseCheckpoint, type TaskCheckpoint } from './taskCheckpoint';

export function checkpointPath(workspaceRoot: string, gitDir: string | undefined): string {
  return gitDir ? path.join(gitDir, 'clarvis-task-checkpoint.json') : path.join(workspaceRoot, '.clarvis', 'task-checkpoint.json');
}

export type CheckpointRead =
  | { kind: 'absent' }
  | { kind: 'found'; checkpoint: TaskCheckpoint }
  /** A checkpoint written for another folder: never carried on from here. */
  | { kind: 'other_project' }
  | { kind: 'unreadable'; detail: string };

export function readCheckpoint(workspaceRoot: string, gitDir: string | undefined): CheckpointRead {
  let text: string;
  try {
    text = fs.readFileSync(checkpointPath(workspaceRoot, gitDir), 'utf8');
  } catch (error) {
    return errno(error) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', detail: errno(error) };
  }
  const parsed = parseCheckpoint(text, workspaceRoot);
  if (parsed.ok) return { kind: 'found', checkpoint: parsed.checkpoint };
  return parsed.reason === 'other_project' ? { kind: 'other_project' } : { kind: 'unreadable', detail: 'not a checkpoint' };
}

export type CheckpointWrite =
  | { kind: 'saved'; bytes: number }
  /** This window no longer holds the project: nothing was written. */
  | { kind: 'fenced' }
  | { kind: 'too_large'; bytes: number }
  | { kind: 'failed'; detail: string };

/** Writes the checkpoint if this window still holds the project lock. */
export async function writeCheckpoint(
  workspaceRoot: string,
  gitDir: string | undefined,
  checkpoint: TaskCheckpoint,
  stillHolds: () => Promise<boolean>
): Promise<CheckpointWrite> {
  // Another folder's record is never written into this one's git folder.
  if (checkpoint.workspaceRoot !== workspaceRoot) return { kind: 'failed', detail: 'the checkpoint belongs to another folder' };
  if (!(await stillHolds())) return { kind: 'fenced' };
  const { text, bytes } = encodeCheckpoint(checkpoint);
  if (bytes > CHECKPOINT_MAX_BYTES) return { kind: 'too_large', bytes };
  return writeWhole(checkpointPath(workspaceRoot, gitDir), text, bytes);
}

function writeWhole(file: string, text: string, bytes: number): CheckpointWrite {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
    return { kind: 'saved', bytes };
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    return { kind: 'failed', detail: errno(error) };
  }
}

function errno(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? String(error);
}
