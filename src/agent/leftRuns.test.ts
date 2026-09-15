import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { GitFacts } from '../engine/checkpoint/gitFacts';
import { readLeftWork, withLeftRun, writeLeftWork, type LeftRun } from '../engine/checkpoint/leftWorkFile';
import { findLeftWork } from '../engine/codex/leftTasks';
import { leftWorkProject, type LeftWorkProject } from '../test/fakes/leftWorkProject';
import { contentOf, earlierRunPort, earlierWorkBrief, findLeftRuns, placedRunOptions, rememberLeftRun, sortFiles, type LeftRunsDeps, type LeftRunTask } from './leftRuns';

/**
 * Which work Clarvis's own engine left on its branch, the record it is found from, the save of the earlier run's own files,
 * and what the next run is told (plan.md M15, "Build on Clarvis's own earlier work"; the owner's decision of 15 Sep 2026).
 * Real git in temporary repositories whose trunk is `master`, as the live tests' were.
 *
 * The guards, in the order someone would notice them missing: the live case of 13 Sep, a run that committed nothing,
 * never offered; work merged into the trunk, a deleted branch or a moved one offered again; a branch only Codex left
 * offered to the wrong engine; a record another window or another folder wrote trusted; the owner's files in flight, or
 * a file they changed since, committed as the run's; a save done silently; and the new request mixed into the brief.
 */

const GREETER = 'clarvis/build-the-greeter-described-in-readme-md';

function runsDeps(p: LeftWorkProject, extra: Partial<LeftRunsDeps> = {}): LeftRunsDeps {
  return { git: new GitFacts(p.root), root: p.root, gitDir: path.join(p.root, '.git'), stillHolds: async () => true, ...extra };
}

function recordedBranches(p: LeftWorkProject): string[] | false {
  const read = readLeftWork(p.root, path.join(p.root, '.git'));
  return read.kind === 'found' && read.record.runs.map((run) => run.branch);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function leftRunTask(branch: string, run: Partial<LeftRun> = {}): LeftRunTask {
  const recorded: LeftRun = {
    branch,
    taskId: `task-${branch}`,
    task: 'Build the greeter described in README.md',
    summary: 'Built greet.py, which prints hello.',
    startedFrom: 'master',
    headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    files: ['greet.py'],
    inFlightAtStart: [],
    uncommitted: [],
    endedAt: '2026-09-15T16:00:00.000Z',
    host: 'code-server',
    ...run,
  };
  return { branch, tip: recorded.headCommit, updatedAt: recorded.endedAt, onBranch: false, run: recorded };
}

// ── Finding it ──────────────────────────────────────────────────────────────

test('one run left with a commit, in a master repository: found from the record in the git folder by a fresh reader, as after a window reload or from the other editor', async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { committed: { 'greet.py': 'print("hello")\n' }, task: 'Build the greeter described in README.md', summary: 'Built greet.py.', host: 'code-server' });

  const found = await findLeftRuns(runsDeps(p));

  assert.deepEqual([found.startsFrom, found.trunk, found.headBranch], ['master', 'master', 'master'], 'master, as git has it: never a literal main');
  assert.deepEqual(
    found.tasks.map((task) => [task.branch, task.tip, task.onBranch, task.updatedAt, task.run.task, task.run.summary, task.run.host, task.run.files]),
    [[GREETER, p.git('rev-parse', GREETER), false, '2026-09-15T16:00:00.000Z', 'Build the greeter described in README.md', 'Built greet.py.', 'code-server', ['greet.py']]]
  );
  assert.equal(fs.existsSync(path.join(p.root, '.git', 'clarvis-left-work.json')), true);
  assert.equal(p.git('status', '--porcelain'), '', 'never committed: the record is inside .git');
});

test("live, 13 Sep: a run that committed nothing is still found while the window is on its branch with the run's own files as it left them; from master its branch holds nothing", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, {
    uncommitted: { 'greet.py': 'print("hello")\n', 'test_greet.py': 'def test_greet(): pass\n' },
    inFlight: { 'plan.md': '# Plan\n', '.vscode/settings.json': '{}\n' },
  });

  const found = await findLeftRuns(runsDeps(p));

  assert.deepEqual([found.headBranch, found.trunk], [GREETER, 'master']);
  assert.deepEqual(found.tasks.map((task) => [task.branch, task.onBranch]), [[GREETER, true]]);
  const { run } = found.tasks[0];
  assert.deepEqual([[...run.files].sort(), [...run.inFlightAtStart].sort()], [['greet.py', 'test_greet.py'], ['.vscode/settings.json', 'plan.md']]);
  assert.deepEqual(run.uncommitted.map((file) => file.path).sort(), ['greet.py', 'test_greet.py'], "the owner's files in flight are never recorded as the run's");

  p.git('checkout', '--quiet', 'master');
  assert.deepEqual((await findLeftRuns(runsDeps(p))).tasks, [], 'uncommitted files belong to whichever branch is checked out');
});

test('not offered, and dropped from the record: a run merged into master, one whose branch is gone, one whose branch no longer holds its work, and one on master itself; a branch only Codex left is never offered here', async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun('clarvis/merged', { committed: { 'merged.py': 'x = 1\n' } });
  p.git('merge', '--quiet', '--no-edit', 'clarvis/merged');
  await p.leaveClarvisRun('clarvis/deleted', { committed: { 'deleted.py': 'x = 2\n' } });
  p.git('branch', '-D', 'clarvis/deleted');
  await p.leaveClarvisRun('clarvis/moved', { committed: { 'moved.py': 'x = 3\n' } });
  p.git('branch', '--force', 'clarvis/moved', 'master');
  await p.leaveClarvisRun('clarvis/kept', { committed: { 'kept.py': 'x = 4\n' } });
  p.leaveCodexWork('clarvis/codex-greeter', { file: 'greet.py' });
  const gitDir = path.join(p.root, '.git');
  const read = readLeftWork(p.root, gitDir);
  const onMaster = { ...leftRunTask('master').run, headCommit: p.git('rev-parse', 'master') };
  await writeLeftWork(p.root, gitDir, withLeftRun(read.kind === 'found' ? read.record : undefined, onMaster, p.root), async () => true);
  const logged: string[] = [];

  const found = await findLeftRuns(runsDeps(p, { log: (line) => void logged.push(line) }));

  assert.deepEqual(found.tasks.map((task) => task.branch), ['clarvis/kept']);
  assert.deepEqual(recordedBranches(p), ['clarvis/kept']);
  const reasons: [string, RegExp][] = [
    ['clarvis/merged', /merged into master$/],
    ['clarvis/deleted', /its branch is gone$/],
    ['clarvis/moved', /its branch no longer holds that run's work$/],
    ['master', /it is master itself$/],
  ];
  for (const [branch, why] of reasons) {
    assert.ok(logged.some((line) => line.includes(`the run on ${branch} isn't offered`) && why.test(line)), `${branch}: ${logged.join('\n')}`);
  }
});

test('the record is tidied only while this window holds the project lock', async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun('clarvis/deleted', { committed: { 'deleted.py': 'x\n' } });
  p.git('branch', '-D', 'clarvis/deleted');
  const logged: string[] = [];

  assert.deepEqual((await findLeftRuns(runsDeps(p, { stillHolds: async () => false, log: (line) => void logged.push(line) }))).tasks, []);

  assert.deepEqual(recordedBranches(p), ['clarvis/deleted'], 'left as it was');
  assert.ok(logged.some((line) => /the record wasn't tidied \(fenced\)/.test(line)), logged.join('\n'));
});

test("a record that can't be read, or that belongs to another folder, offers nothing and is left as it is", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { committed: { 'greet.py': 'x\n' } });
  const file = path.join(p.root, '.git', 'clarvis-left-work.json');
  const good = fs.readFileSync(file, 'utf8');
  const logged: string[] = [];

  fs.writeFileSync(file, good.replace('"runs": [', '"runs": [{"branch": 1},'));
  assert.deepEqual((await findLeftRuns(runsDeps(p, { log: (line) => void logged.push(line) }))).tasks, []);
  assert.match(fs.readFileSync(file, 'utf8'), /"branch": 1/, 'left as it is');
  assert.ok(logged.some((line) => /can't be used here \(not a record of left work\)/.test(line)), logged.join('\n'));

  fs.writeFileSync(file, good.replace(JSON.stringify(p.root), JSON.stringify(`${p.root}-elsewhere`)));
  assert.deepEqual((await findLeftRuns(runsDeps(p))).tasks, []);
  assert.deepEqual((await findLeftRuns(runsDeps(p, { gitDir: undefined }))).tasks, [], 'a folder without git has no record');
});

test('a branch both engines left is offered by both questions, each from its own finding', async (t) => {
  const p = await leftWorkProject(t);
  const session = p.leaveCodexWork(GREETER, { file: 'greet.py' });
  // Later Clarvis's own engine carried the task on there, after a switch, and left it too.
  p.git('checkout', '--quiet', GREETER);
  fs.writeFileSync(path.join(p.root, 'test_greet.py'), 'def test_greet(): pass\n');
  p.git('add', 'test_greet.py');
  p.git('commit', '--quiet', '-m', 'Added a test for the greeter');
  const deps = { git: new GitFacts(p.root), root: p.root, gitDir: path.join(p.root, '.git'), stillHolds: async () => true };
  const ended = { branch: GREETER, taskId: 'task-2', task: 'Add a test', summary: 'Added test_greet.py.', startedFrom: 'master', files: ['test_greet.py'], inFlightAtStart: [], host: 'desktop' as const, now: new Date('2026-09-15T17:30:00Z') };
  assert.equal(await rememberLeftRun(deps, ended), 'saved');
  p.git('checkout', '--quiet', 'master');

  assert.deepEqual((await findLeftRuns(runsDeps(p))).tasks.map((task) => task.branch), [GREETER]);
  assert.deepEqual((await findLeftWork(p.deps())).tasks.map((task) => [task.branch, task.sessionId]), [[GREETER, session.id]]);
});

// ── The earlier run's own files ─────────────────────────────────────────────

test("the earlier run's own files, read now: as it left them, changed since, unreadable, or no longer uncommitted; the owner's files in flight are never among them", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, {
    uncommitted: { 'greet.py': 'print("hello")\n', 'test_greet.py': 'def test_greet(): pass\n', 'notes.md': 'notes\n', 'docs/usage.md': 'usage\n' },
    inFlight: { 'plan.md': '# Plan\n' },
  });
  const [left] = (await findLeftRuns(runsDeps(p))).tasks;
  fs.writeFileSync(path.join(p.root, 'test_greet.py'), 'def test_greet(): assert True\n');
  p.git('add', 'notes.md');
  p.git('commit', '--quiet', '-m', 'The owner committed the notes', '--', 'notes.md');
  fs.chmodSync(path.join(p.root, 'docs', 'usage.md'), 0o000);

  const sorted = sortFiles(p.root, left.run, await new GitFacts(p.root).dirty());

  assert.deepEqual({ saving: sorted.saving, edited: [...sorted.edited].sort() }, { saving: ['greet.py'], edited: ['docs/usage.md', 'test_greet.py'] });
  assert.equal(contentOf(p.root, 'greet.py'), sha256('print("hello")\n'));
  assert.equal(contentOf(p.root, 'missing.py'), null);
  assert.equal(contentOf(p.root, '../outside.txt'), undefined, 'never outside the folder');
  assert.equal(contentOf(p.root, path.join(p.root, 'greet.py')), undefined);
});

test("saving the earlier run's files commits only those, on its branch, and says so; the owner's files in flight stay uncommitted", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, {
    uncommitted: { 'greet.py': 'print("hello")\n', 'test_greet.py': 'def test_greet(): pass\n' },
    inFlight: { 'plan.md': '# Plan\n', '.vscode/settings.json': '{}\n' },
    task: 'Build the greeter',
  });
  const found = await findLeftRuns(runsDeps(p));
  const logged: string[] = [];
  const port = earlierRunPort({ git: new GitFacts(p.root), root: p.root, found: () => found.tasks, log: (line) => void logged.push(line) });
  const tipBefore = p.git('rev-parse', GREETER);

  const earlier = await port.sort();
  assert.deepEqual(earlier, { branch: GREETER, saving: ['greet.py', 'test_greet.py'], edited: [] });
  if (!earlier) return;
  const saved = await port.save(earlier, { kind: 'fresh', from: 'master' });

  assert.deepEqual(saved, { ok: true, line: `Committed the last run's 2 files to \`${GREETER}\` before starting fresh.` });
  assert.equal(p.git('rev-parse', `${GREETER}~1`), tipBefore);
  assert.deepEqual(p.git('diff-tree', '--no-commit-id', '--name-only', '-r', GREETER).split('\n'), ['greet.py', 'test_greet.py']);
  assert.equal(p.git('log', '-1', '--format=%B', GREETER), "Save the earlier run's work before starting fresh\n\nTask: Build the greeter");
  assert.deepEqual(p.git('status', '--porcelain', '--untracked-files=all').split('\n').sort(), ['?? .vscode/settings.json', '?? plan.md'], "the owner's files in flight are left as they were");
  assert.ok(logged.some((line) => line.startsWith(`left work: committed 2 file(s) the last run left on ${GREETER}`)), logged.join('\n'));

  const elsewhere = earlierRunPort({ git: new GitFacts(p.root), root: p.root, found: () => found.tasks.map((task) => ({ ...task, onBranch: false })), log: () => undefined });
  assert.equal(await elsewhere.sort(), undefined, "not on a left run's branch: nothing of it to save");
});

test('the line for each reason, files changed since named as not committed when building on, and a commit that fails stops the run', async () => {
  const task = leftRunTask(GREETER);
  const commits: string[][] = [];
  const git = {
    dirty: async () => [],
    commitOnBranch: async (...args: [string, string[], string]) => {
      commits.push(args[1]);
      return { ok: true as const, commit: 'abcdef1234567890' };
    },
  };
  const port = earlierRunPort({ git, root: '/nowhere', found: () => [task], log: () => undefined });

  assert.deepEqual(await port.save({ branch: GREETER, saving: ['greet.py'], edited: ['test_greet.py'] }, { kind: 'build_on' }), {
    ok: true,
    line: `Committed the last run's 1 file to \`${GREETER}\` so this run builds on it. \`test_greet.py\` changed after the last run ended, so it isn't committed and stays yours.`,
  });
  assert.deepEqual(await port.save({ branch: GREETER, saving: ['greet.py', 'test_greet.py'], edited: [] }, { kind: 'switch', to: 'clarvis/other' }), {
    ok: true,
    line: `Committed the last run's 2 files to \`${GREETER}\` before switching to \`clarvis/other\`.`,
  });
  assert.deepEqual(await port.save({ branch: GREETER, saving: [], edited: ['test_greet.py', 'notes.md'] }, { kind: 'build_on' }), {
    ok: true,
    line: "`test_greet.py`, `notes.md` changed after the last run ended, so they aren't committed and stay yours.",
  });
  assert.deepEqual(await port.save({ branch: GREETER, saving: [], edited: [] }, { kind: 'fresh', from: 'master' }), { ok: true, line: undefined });
  assert.equal(commits.length, 2, "nothing is committed when none of the run's own files are left");

  const failing = earlierRunPort({ git: { ...git, commitOnBranch: async () => ({ ok: false as const, detail: 'HEAD is on master, not x' }) }, root: '/nowhere', found: () => [task], log: () => undefined });
  assert.deepEqual(await failing.save({ branch: GREETER, saving: ['greet.py'], edited: [] }, { kind: 'fresh', from: 'master' }), {
    ok: false,
    line: `The last run's files couldn't be committed to \`${GREETER}\` (HEAD is on master, not x), so I didn't start.`,
  });
});

// ── Written when a run ends ─────────────────────────────────────────────────

test('a run is recorded with only its own uncommitted files and their content, none when the checkout is on another branch, one run per branch, and not at all when its branch is gone or the lock was lost', async (t) => {
  const p = await leftWorkProject(t);
  p.git('checkout', '--quiet', '-b', GREETER);
  fs.writeFileSync(path.join(p.root, 'greet.py'), 'print("hello")\n');
  fs.writeFileSync(path.join(p.root, 'plan.md'), '# The owner’s plan\n');
  const deps = { git: new GitFacts(p.root), root: p.root, gitDir: path.join(p.root, '.git'), stillHolds: async () => true };
  const ended = { branch: GREETER, taskId: 'task-1', task: 'Build the greeter', summary: 'Built greet.py.', startedFrom: 'master', files: ['greet.py', 'plan.md'], inFlightAtStart: ['plan.md'], host: 'desktop' as const, now: new Date('2026-09-15T17:00:00Z') };
  const runs = () => {
    const read = readLeftWork(p.root, deps.gitDir);
    return read.kind === 'found' ? read.record.runs : [];
  };

  assert.equal(await rememberLeftRun(deps, ended), 'saved');
  assert.deepEqual(runs(), [
    {
      branch: GREETER,
      taskId: 'task-1',
      task: 'Build the greeter',
      summary: 'Built greet.py.',
      startedFrom: 'master',
      headCommit: p.git('rev-parse', GREETER),
      files: ['greet.py'],
      inFlightAtStart: ['plan.md'],
      uncommitted: [{ path: 'greet.py', sha256: sha256('print("hello")\n') }],
      endedAt: '2026-09-15T17:00:00.000Z',
      host: 'desktop',
    },
  ]);

  assert.equal(await rememberLeftRun(deps, { ...ended, summary: 'Built it again.' }), 'saved');
  assert.deepEqual(runs().map((run) => run.summary), ['Built it again.'], 'one run per branch');

  p.git('checkout', '--quiet', 'master');
  assert.equal(await rememberLeftRun(deps, { ...ended, summary: 'Ended off its branch.' }), 'saved');
  assert.deepEqual(runs()[0].uncommitted, [], 'uncommitted files belong to whichever branch is checked out');

  assert.equal(await rememberLeftRun(deps, { ...ended, branch: 'clarvis/gone' }), 'no_branch');
  assert.equal(await rememberLeftRun({ ...deps, stillHolds: async () => false }, { ...ended, summary: 'Taken over.' }), 'fenced');
  assert.deepEqual(runs().map((run) => run.summary), ['Ended off its branch.']);
});

// ── What the next run starts with ───────────────────────────────────────────

test("the brief for a Build on: the earlier task, what it said when it ended and the branch's commits, clipped, never the new request", () => {
  const brief = earlierWorkBrief(leftRunTask(GREETER), ["Save the earlier run's work before building on it", 'Built greet.py, which prints hello.']);

  assert.equal(
    brief,
    [
      '',
      '',
      `This task builds on your own earlier work on \`${GREETER}\`, which is checked out for it. Add to that work; don't start it again from scratch.`,
      '',
      'The earlier task, as it was asked: Build the greeter described in README.md',
      '',
      'What you said when it ended: Built greet.py, which prints hello.',
      '',
      "Commits on this branch so far, newest first:\n- Save the earlier run's work before building on it\n- Built greet.py, which prints hello.",
      '',
      'Re-read any file before you edit it.',
    ].join('\n')
  );
  const silent = earlierWorkBrief(leftRunTask(GREETER, { summary: '   ', task: 'y'.repeat(5_000) }), []);
  assert.match(silent, /It ended without saying anything\./);
  assert.doesNotMatch(silent, /Commits on this branch/);
  assert.match(silent, /as it was asked: y{1999}…\n/);
});

test("how the run starts on the answer: Build on carries that branch on at its tip with the branch the question named as its base, and the earlier run in its brief; Start fresh never stacks; what is uncommitted is the owner's", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { committed: { 'greet.py': 'print("hello")\n' }, summary: 'Built greet.py.' });
  fs.writeFileSync(path.join(p.root, 'README.md'), '# edited by the owner\n');
  const [left] = (await findLeftRuns(runsDeps(p))).tasks;
  const git = new GitFacts(p.root);

  const buildOn = await placedRunOptions(git, { kind: 'build_on', task: left }, 'master');

  assert.deepEqual(buildOn.theirs, ['README.md']);
  assert.deepEqual(buildOn.engine.continueOn, { branch: GREETER, headCommit: p.git('rev-parse', GREETER), theirs: ['README.md'], base: 'master' });
  assert.equal(buildOn.engine.earlierWork, earlierWorkBrief(left, ['Built greet.py.']));
  assert.deepEqual(await placedRunOptions(git, { kind: 'fresh' }, 'master'), { engine: { startFresh: true }, theirs: ['README.md'] });
});
