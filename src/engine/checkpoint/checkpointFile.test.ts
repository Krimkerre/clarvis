import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { checkpointPath, readCheckpoint, writeCheckpoint } from './checkpointFile';
import { newCheckpoint, type TaskCheckpoint } from './taskCheckpoint';

/**
 * The checkpoint on disk (design §6.1): in the git folder, never committed; written whole, 0600, and only by the
 * window that still holds the project; never another folder's.
 */

const NOW = new Date('2026-09-13T02:00:00Z');
const holds = async () => true;
const lost = async () => false;

async function withFolder(git: boolean, run: (root: string, gitDir: string | undefined) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-checkpoint-')));
  const gitDir = git ? path.join(root, '.git') : undefined;
  if (gitDir) fs.mkdirSync(gitDir);
  try {
    await run(root, gitDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function checkpointFor(root: string, overrides: Partial<TaskCheckpoint> = {}): TaskCheckpoint {
  return { ...newCheckpoint({ taskId: 'task-1', workspaceRoot: root, host: 'code-server', engine: 'clarvis', task: 'Build milestone 2.', now: NOW }), ...overrides };
}

test('saved whole, as 0600, in the git folder where it is never committed, and read back', () =>
  withFolder(true, async (root, gitDir) => {
    const saved = checkpointFor(root, { changedFiles: ['hello.py'] });

    const written = await writeCheckpoint(root, gitDir, saved, holds);

    const file = checkpointPath(root, gitDir);
    assert.equal(written.kind, 'saved');
    assert.equal(file, path.join(root, '.git', 'clarvis-task-checkpoint.json'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith('.tmp')), [], 'no temporary file left behind');
    const read = readCheckpoint(root, gitDir);
    assert.deepEqual(read.kind === 'found' && read.checkpoint.changedFiles, ['hello.py']);
  }));

test('a window that no longer holds the project writes nothing, and the checkpoint already there is left as it was', () =>
  withFolder(true, async (root, gitDir) => {
    await writeCheckpoint(root, gitDir, checkpointFor(root, { task: 'the holder’s' }), holds);

    const written = await writeCheckpoint(root, gitDir, checkpointFor(root, { task: 'the taken-over window’s' }), lost);

    assert.deepEqual(written, { kind: 'fenced' });
    const read = readCheckpoint(root, gitDir);
    assert.equal(read.kind === 'found' && read.checkpoint.task, 'the holder’s');
  }));

test('a folder without git keeps it in .clarvis', () =>
  withFolder(false, async (root) => {
    assert.equal((await writeCheckpoint(root, undefined, checkpointFor(root), holds)).kind, 'saved');
    assert.equal(fs.existsSync(path.join(root, '.clarvis', 'task-checkpoint.json')), true);
  }));

test("another folder's checkpoint is neither written here nor read as this one's", () =>
  withFolder(true, async (root, gitDir) => {
    const elsewhere = checkpointFor(`${root}-other`);
    assert.equal((await writeCheckpoint(root, gitDir, elsewhere, holds)).kind, 'failed');
    assert.equal(fs.existsSync(checkpointPath(root, gitDir)), false);

    fs.writeFileSync(checkpointPath(root, gitDir), JSON.stringify(elsewhere));
    assert.deepEqual(readCheckpoint(root, gitDir), { kind: 'other_project' });
  }));

test('a file that is not a checkpoint, or cannot be read, is unreadable — never "no task here"', () =>
  withFolder(true, async (root, gitDir) => {
    assert.deepEqual(readCheckpoint(root, gitDir), { kind: 'absent' });
    fs.writeFileSync(checkpointPath(root, gitDir), '{"version": 3');
    assert.equal(readCheckpoint(root, gitDir).kind, 'unreadable');

    fs.rmSync(checkpointPath(root, gitDir));
    fs.mkdirSync(checkpointPath(root, gitDir));
    assert.equal(readCheckpoint(root, gitDir).kind, 'unreadable');
  }));
