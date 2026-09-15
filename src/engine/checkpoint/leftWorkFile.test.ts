import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import { encodeLeftWork, leftWorkPath, MOST_LEFT_RUNS, readLeftWork, withLeftRun, withoutLeftRuns, writeLeftWork, type LeftRun, type LeftWorkRecord } from './leftWorkFile';

/**
 * The record of runs Clarvis's own engine left on their branches (plan.md M15, "Build on Clarvis's own earlier work"), on
 * disk as the checkpoint is: in the git folder beside `clarvis-task-checkpoint.json`, never committed; written whole,
 * 0600, and only by the window that still holds the project; never another folder's. One run per branch.
 */

const holds = async () => true;
const lost = async () => false;

async function withGitDir(run: (root: string, gitDir: string) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-left-work-file-')));
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir);
  try {
    await run(root, gitDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function leftRun(branch: string, patch: Partial<LeftRun> = {}): LeftRun {
  return {
    branch,
    taskId: `task-${branch}`,
    task: `Work on ${branch}`,
    summary: 'Done.',
    startedFrom: 'master',
    headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    files: ['greet.py'],
    inFlightAtStart: [],
    uncommitted: [],
    endedAt: '2026-09-15T16:00:00.000Z',
    host: 'code-server',
    ...patch,
  };
}

test('saved whole, as 0600, beside the checkpoint in the git folder, and read back by a fresh reader, as after a window reload or from the other editor', () =>
  withGitDir(async (root, gitDir) => {
    const run = leftRun('clarvis/greeter', { uncommitted: [{ path: 'greet.py', sha256: 'f'.repeat(64) }, { path: 'old.py', sha256: null }], inFlightAtStart: ['plan.md'] });
    const record = withLeftRun(undefined, run, root);

    const written = await writeLeftWork(root, gitDir, record, holds);

    const file = leftWorkPath(gitDir);
    assert.equal(written.kind, 'saved');
    assert.equal(file, path.join(root, '.git', 'clarvis-left-work.json'));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(gitDir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file left behind');
    assert.deepEqual(readLeftWork(root, gitDir), { kind: 'found', record: { version: 1, workspaceRoot: root, runs: [run] } });
  }));

test('one run per branch, the most recent first, at most twenty; the runs on given branches can be dropped', () => {
  let record: LeftWorkRecord | undefined;
  for (let index = 0; index < 25; index++) record = withLeftRun(record, leftRun(`clarvis/run-${index}`), '/project');
  record = withLeftRun(record, leftRun('clarvis/run-20', { summary: 'Built on it again.' }), '/project');

  assert.equal(record.runs.length, MOST_LEFT_RUNS);
  assert.deepEqual(
    record.runs.slice(0, 3).map((run) => [run.branch, run.summary]),
    [
      ['clarvis/run-20', 'Built on it again.'],
      ['clarvis/run-24', 'Done.'],
      ['clarvis/run-23', 'Done.'],
    ]
  );
  assert.equal(record.runs.filter((run) => run.branch === 'clarvis/run-20').length, 1);
  assert.deepEqual(withoutLeftRuns(record, ['clarvis/run-20', 'clarvis/run-24']).runs[0].branch, 'clarvis/run-23');
  assert.deepEqual(
    withLeftRun({ ...record, workspaceRoot: '/another-project' }, leftRun('clarvis/x'), '/project').runs.map((run) => run.branch),
    ['clarvis/x'],
    "another folder's runs aren't built on"
  );
});

test("a window that no longer holds the project writes nothing; another folder's record is neither written here nor read as this one's", () =>
  withGitDir(async (root, gitDir) => {
    await writeLeftWork(root, gitDir, withLeftRun(undefined, leftRun('clarvis/holder'), root), holds);

    assert.deepEqual(await writeLeftWork(root, gitDir, withLeftRun(undefined, leftRun('clarvis/taken-over'), root), lost), { kind: 'fenced' });
    const read = readLeftWork(root, gitDir);
    assert.deepEqual(read.kind === 'found' && read.record.runs.map((run) => run.branch), ['clarvis/holder']);

    const elsewhere = withLeftRun(undefined, leftRun('clarvis/elsewhere'), `${root}-other`);
    assert.equal((await writeLeftWork(root, gitDir, elsewhere, holds)).kind, 'failed');
    fs.writeFileSync(leftWorkPath(gitDir), JSON.stringify(elsewhere));
    assert.deepEqual(readLeftWork(root, gitDir), { kind: 'other_project' });
  }));

test('a file that is not a record, one malformed run in it, or a file that cannot be read is unreadable, never "nothing left"', () =>
  withGitDir(async (root, gitDir) => {
    assert.deepEqual(readLeftWork(root, gitDir), { kind: 'absent' });
    fs.writeFileSync(leftWorkPath(gitDir), '{"version": 1');
    assert.equal(readLeftWork(root, gitDir).kind, 'unreadable');
    fs.writeFileSync(leftWorkPath(gitDir), JSON.stringify({ version: 1, workspaceRoot: root, runs: [leftRun('clarvis/fine'), { branch: 'clarvis/broken' }] }));
    assert.equal(readLeftWork(root, gitDir).kind, 'unreadable');
    fs.writeFileSync(leftWorkPath(gitDir), JSON.stringify({ version: 1, workspaceRoot: root, runs: [leftRun('clarvis/fine', { uncommitted: [{ path: 'x.py', sha256: 7 } as never] })] }));
    assert.equal(readLeftWork(root, gitDir).kind, 'unreadable');

    fs.rmSync(leftWorkPath(gitDir));
    fs.mkdirSync(leftWorkPath(gitDir));
    assert.equal(readLeftWork(root, gitDir).kind, 'unreadable');
  }));

test('secrets in what the run said are removed, the task is clipped, and a record too large drops its oldest runs first', () => {
  const said = leftRun('clarvis/a', { summary: 'Set it up with sk-abcdefghijklmnopqrstuvwxyz in the env.', task: 'x'.repeat(10_000) });
  const { text } = encodeLeftWork({ version: 1, workspaceRoot: '/project', runs: [said] });
  assert.doesNotMatch(text, /sk-abcdefghij/);
  assert.match(text, /\[secret removed\]/);
  assert.equal((JSON.parse(text) as LeftWorkRecord).runs[0].task.length, 4_000);

  const bulky = Array.from({ length: MOST_LEFT_RUNS }, (_, index) =>
    leftRun(`clarvis/bulky-${index}`, { files: Array.from({ length: 200 }, (_, file) => `src/${'nested/'.repeat(20)}file-${file}.py`) })
  );
  const encoded = encodeLeftWork({ version: 1, workspaceRoot: '/project', runs: bulky });
  const kept = (JSON.parse(encoded.text) as LeftWorkRecord).runs;
  assert.ok(encoded.bytes <= 256 * 1024, String(encoded.bytes));
  assert.ok(kept.length < MOST_LEFT_RUNS && kept.length > 0, String(kept.length));
  assert.equal(kept[0].branch, 'clarvis/bulky-0', 'the most recent kept');
});
