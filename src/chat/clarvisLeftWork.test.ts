import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { continuationDecision } from '../agent/branchNames';
import type { LeftWorkFound } from '../agent/leftBranches';
import { earlierRunPort, findLeftRuns, placedRunOptions, type LeftRunTask } from '../agent/leftRuns';
import { GitFacts, type WorkingTree } from '../engine/checkpoint/gitFacts';
import type { LeftRun } from '../engine/checkpoint/leftWorkFile';
import { leftWorkProject, type LeftWorkProject } from '../test/fakes/leftWorkProject';
import { CLARVIS_LEFT_WORK_LINES, whereClarvisWorks, type ClarvisLeftWorkHost, type ClarvisWhere } from './clarvisLeftWork';
import type { EarlierRunPort } from './leftWork';
import { PendingChoice } from './PendingChoice';

/**
 * **Build on Clarvis's own earlier work, or start fresh**, from the question to how the run starts (plan.md M15, "Build on
 * Clarvis's own earlier work"; the owner's decision of 15 Sep 2026, "Give Clarvis's own engine the same question").
 * Driven through the real `PendingChoice` the chat panel answers; the end-to-end tests use real git in temporary
 * repositories whose trunk is `master`, and the real record of left work. The run itself, on the real Git extension, is
 * the host spec's (`branchContinuation.spec.ts`).
 *
 * The gap this closes: Clarvis's own engine started every task on a new branch from the trunk, so after "Leave it there"
 * a follow-up never saw the earlier run's work. The guards, in the order someone would notice them missing: no question;
 * a typed "build on it" sent to the model as a task; a question that runs something though it went unanswered, was
 * stopped or dropped; Unattended asking anyway; the earlier run's uncommitted files left behind, or silently committed,
 * or carried onto a fresh branch; the owner's own changes carried along or committed; and Start fresh stacking on the
 * branch the window is on.
 */

const GREETER = 'clarvis/build-the-greeter-described-in-readme-md';
const SHOUT = 'Also add a --shout option to greet.py that prints the greeting in capitals, with a test for it.';

// ── The question, through the real PendingChoice ─────────────────────────────

interface Asking {
  host: ClarvisLeftWorkHost;
  pending: PendingChoice;
  /** The buttons each time the panel was given some, and `[]` each time they were cleared. */
  offered: string[][];
  said: string[];
  logged: string[];
  treeReads: number;
  found: () => LeftWorkFound<LeftRunTask>;
}

function leftRun(branch: string, patch: Partial<LeftRunTask> = {}): LeftRunTask {
  const run: LeftRun = {
    branch,
    taskId: `task-${branch}`,
    task: `Work on ${branch}`,
    summary: 'Done.',
    startedFrom: 'master',
    headCommit: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    files: [],
    inFlightAtStart: [],
    uncommitted: [],
    endedAt: '2026-09-15T16:00:00.000Z',
    host: 'code-server',
  };
  return { branch, tip: run.headCommit, updatedAt: run.endedAt, onBranch: false, run, ...patch };
}

function work(tasks: LeftRunTask[], headBranch = 'master'): LeftWorkFound<LeftRunTask> {
  return { startsFrom: 'master', trunk: 'master', headBranch, tasks };
}

/** As `RunSession.whereClarvisWorks` wires it, with stand-ins for git: its own buttons and words only. */
function asking(find: () => Promise<LeftWorkFound<LeftRunTask>>, options: { unattended?: boolean; tree?: Partial<WorkingTree>; earlier?: EarlierRunPort } = {}): Asking {
  const offered: string[][] = [];
  const pending = new PendingChoice((items) => offered.push(items.map((item) => item.label)));
  let found: LeftWorkFound<LeftRunTask> = { tasks: [] };
  const h: Asking = { host: undefined as unknown as ClarvisLeftWorkHost, pending, offered, said: [], logged: [], treeReads: 0, found: () => found };
  h.host = {
    find: async () => (found = await find()),
    unattended: () => options.unattended ?? false,
    ask: (choices, accepts) => pending.ask(choices, 'where I should work', true, accepts),
    note: async (line) => void h.said.push(line),
    tree: async () => {
      h.treeReads++;
      return { changed: [], untracked: [], shown: [], ...options.tree };
    },
    filesOn: async () => [],
    earlier: options.earlier,
    log: (line) => void h.logged.push(line),
  };
  return h;
}

/** As `RunSession.whereClarvisWorks` wires it, on a real repository: the record's finder, git, and the save of the earlier run's files. */
function onProject(p: LeftWorkProject, options: { unattended?: boolean } = {}): Asking {
  const git = new GitFacts(p.root);
  const log = (line: string) => void h.logged.push(line);
  const h = asking(() => findLeftRuns({ git, root: p.root, gitDir: path.join(p.root, '.git'), stillHolds: async () => true, log }), options);
  h.host.tree = () => {
    h.treeReads++;
    return git.workingTree();
  };
  h.host.filesOn = (branch) => git.filesOn(branch);
  h.host.earlier = earlierRunPort({ git, root: p.root, found: () => h.found().tasks, log });
  return h;
}

/** The question running, once its buttons are on screen. Wrapped, so awaiting this doesn't wait for an answer. */
async function asked(h: Asking): Promise<{ flow: Promise<ClarvisWhere> }> {
  const flow = whereClarvisWorks(h.host);
  await until(() => h.pending.isWaiting);
  return { flow };
}

/** A flow that should end on its own: failed, not left hanging, when it waits for an answer instead. */
async function within<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('it waited for an answer instead of ending')), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("asked with one left run: one plain line in Clarvis's own words, then Build on <branch> and Start fresh from master", async () => {
  const task = leftRun(GREETER);
  const h = asking(async () => work([task]));

  const { flow } = await asked(h);

  assert.deepEqual(h.said, [
    `My earlier work is still on \`${GREETER}\`, not merged into \`master\`. Build on it, and this task runs on that branch, on top of that work, or start fresh on a new branch from \`master\`.`,
  ]);
  assert.deepEqual(h.offered.at(-1), [`Build on ${GREETER}`, 'Start fresh from master']);
  assert.equal(h.pending.supply(`Build on ${GREETER}`), true);
  assert.deepEqual(await flow, { kind: 'build_on', task });
  assert.deepEqual(h.offered.at(-1), [], 'the buttons are gone');
});

test('asked with several: the branch the window is on first, then the most recent, at most three, then Start fresh', async () => {
  const tasks = [
    leftRun('clarvis/one', { updatedAt: '2026-09-15T10:00:00Z' }),
    leftRun('clarvis/two', { updatedAt: '2026-09-15T11:00:00Z', onBranch: true }),
    leftRun('clarvis/three', { updatedAt: '2026-09-15T12:00:00Z' }),
    leftRun('clarvis/four', { updatedAt: '2026-09-15T13:00:00Z' }),
  ];
  const h = asking(async () => work(tasks, 'clarvis/two'));

  const { flow } = await asked(h);

  assert.deepEqual(h.offered.at(-1), ['Build on clarvis/two', 'Build on clarvis/four', 'Build on clarvis/three', 'Start fresh from master']);
  assert.match(h.said[0], /^I left earlier work on 4 branches that aren't merged into `master`\. The 3 most recent are below\. Build on one, and this task runs on that branch, on top of that work/);
  assert.equal(h.pending.supply('3'), true, 'a number picks the button, as every question here');
  assert.deepEqual(await flow, { kind: 'build_on', task: tasks[2] });
});

test('not asked when nothing was left: a fresh start, as today, with nothing said and nothing read', async () => {
  const h = asking(async () => work([]));

  assert.deepEqual(await within(whereClarvisWorks(h.host)), { kind: 'fresh' });
  assert.deepEqual([h.said, h.offered, h.pending.isWaiting, h.treeReads], [[], [], false, 0]);
});

test('typed answers work like the buttons and are consumed, so they never reach the model as a task; anything else is the message it is, and nothing runs', async () => {
  const answers: [string, ClarvisWhere['kind']][] = [
    ['build on it', 'build_on'],
    ['continue', 'build_on'],
    ['that branch', 'build_on'],
    ['fresh', 'fresh'],
    ['start fresh', 'fresh'],
    ['new branch', 'fresh'],
  ];
  for (const [typed, kind] of answers) {
    const h = asking(async () => work([leftRun(GREETER)]));
    const { flow } = await asked(h);
    // Consumed: `ChatService.runTook` stops routing here, so the words are never a task for the model.
    assert.equal(h.pending.supply(typed), true, typed);
    assert.equal((await flow).kind, kind, typed);
  }
  for (const typed of [SHOUT, 'ok', 'yes', 'build on it?', 'continue with the greeter and add a shout flag']) {
    const h = asking(async () => work([leftRun(GREETER)]));
    const { flow } = await asked(h);
    assert.equal(h.pending.supply(typed), false, `${typed} goes on to be read as a message`);
    assert.deepEqual(await flow, { kind: 'nothing' }, typed);
  }
});

test('Stop, or a mode switch while the question shows, runs nothing and presses nothing', async () => {
  const stopped = asking(async () => work([leftRun(GREETER)]));
  const first = await asked(stopped);
  // `RunSession.stopWaiting`, from the Stop button or a typed "stop".
  stopped.pending.cancel();
  assert.deepEqual(await first.flow, { kind: 'nothing' });
  assert.ok(stopped.logged.some((line) => /^left work: the question went unanswered, was stopped or was dropped, so nothing runs$/.test(line)));

  const switched = asking(async () => work([leftRun(GREETER, { onBranch: true })], GREETER));
  const second = await asked(switched);
  // `RunSession.modeStoppedAsking` supplies "Do it" as not typed.
  assert.equal(switched.pending.supply('Do it', false), false);
  assert.deepEqual(await second.flow, { kind: 'nothing' });
});

test("Unattended asks nothing: it builds on the branch the window is on, or starts fresh, with one line saying which", async () => {
  const here = leftRun(GREETER, { onBranch: true, updatedAt: '2026-09-15T09:00:00Z' });
  const on = asking(async () => work([leftRun('clarvis/newer'), here], GREETER), { unattended: true });
  assert.deepEqual(await within(whereClarvisWorks(on.host)), { kind: 'build_on', task: here });
  assert.deepEqual(on.said, [`Unattended, so I didn't ask: I build on \`${GREETER}\`, the branch you're on, where my earlier work is.`]);

  const off = asking(async () => work([leftRun(GREETER)]), { unattended: true });
  assert.deepEqual(await within(whereClarvisWorks(off.host)), { kind: 'fresh' });
  assert.deepEqual(off.said, [CLARVIS_LEFT_WORK_LINES.unattendedFresh('master', [leftRun(GREETER)])]);
  assert.equal(off.said[0], `Unattended, so I didn't ask: I start fresh on a new branch from \`master\`. My earlier work stays on \`${GREETER}\`.`);
  assert.deepEqual([on.offered, off.offered], [[], []]);
});

test("a commit of the earlier run's files that fails stops the task: the line says why, and nothing runs", async () => {
  const here = leftRun(GREETER, { onBranch: true });
  const failure = "The last run's files couldn't be committed to `clarvis/build-the-greeter-described-in-readme-md` (a hook said no), so I didn't start.";
  const earlier: EarlierRunPort = { sort: async () => ({ branch: GREETER, saving: ['greet.py'], edited: [] }), save: async () => ({ ok: false, line: failure }) };
  const h = asking(async () => work([here], GREETER), { earlier });

  const { flow } = await asked(h);
  h.pending.supply('build on it');

  assert.deepEqual(await flow, { kind: 'nothing' });
  assert.deepEqual(h.said.slice(1), [failure]);
});

test('Build on a branch the window is not on is refused while tracked files have changes, in plain words, and nothing runs', async () => {
  const h = asking(async () => work([leftRun(GREETER)]), { tree: { changed: ['README.md'] } });
  const { flow } = await asked(h);
  h.pending.supply('build on it');

  assert.deepEqual(await flow, { kind: 'nothing' });
  assert.equal(h.said[1], `You have changes on \`master\` that aren't committed yet (\`README.md\`). Switching to \`${GREETER}\` would carry them along, so I didn't start. Commit them or put them aside, then ask again.`);
});

// ── End to end: the record, the question, and how the run starts ────────────

test('Build on, end to end in a master repository: the run gets that branch at its tip, main… master as its base, and the earlier task and summary; the question makes no branch and commits nothing', async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { committed: { 'greet.py': 'print("hello")\n' }, task: 'Build the greeter described in README.md', summary: 'Built greet.py, which prints hello.' });
  const tip = p.git('rev-parse', GREETER);
  const branches = () => p.git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
  const before = branches();
  const h = onProject(p);

  const { flow } = await asked(h);
  assert.match(h.said[0], /^My earlier work is still on `clarvis\/build-the-greeter-described-in-readme-md`, not merged into `master`\./);
  assert.deepEqual(h.offered.at(-1), [`Build on ${GREETER}`, 'Start fresh from master']);
  assert.equal(h.pending.supply('build on it'), true);
  const where = await flow;
  assert.equal(where.kind, 'build_on');
  if (where.kind !== 'build_on') return;

  const { engine, theirs } = await placedRunOptions(new GitFacts(p.root), where, h.found().startsFrom);

  assert.deepEqual(engine.continueOn, { branch: GREETER, headCommit: tip, theirs: [], base: 'master' });
  assert.deepEqual(theirs, []);
  assert.match(engine.earlierWork ?? '', /The earlier task, as it was asked: Build the greeter described in README\.md/);
  assert.match(engine.earlierWork ?? '', /What you said when it ended: Built greet\.py, which prints hello\./);
  assert.match(engine.earlierWork ?? '', /\n- Built greet\.py, which prints hello\./, "the branch's commits");
  assert.doesNotMatch(engine.earlierWork ?? '', /build on it/, "the typed answer is nobody's task");
  assert.equal(engine.startFresh, undefined);
  assert.deepEqual(continuationDecision(GREETER, await new GitFacts(p.root).branches(), tip, tip, true), { kind: 'continue', branch: GREETER });
  assert.deepEqual([branches(), p.git('rev-parse', GREETER), p.git('symbolic-ref', '--short', 'HEAD')], [before, tip, 'master'], 'no branch made, nothing committed, and the switch is the run’s');
  assert.equal(h.said.length, 1, 'a clean tree: nothing refused, nothing comes along');
});

test("live, 13 Sep: Build on the branch the window is on, where the last run left its files uncommitted: they are committed there first, said in the chat, and the owner's files in flight stay theirs", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, {
    uncommitted: { 'greet.py': 'print("hello")\n', 'test_greet.py': 'def test_greet(): pass\n' },
    inFlight: { 'plan.md': '# Plan\n', '.vscode/settings.json': '{}\n' },
    task: 'Build the greeter',
  });
  const tipBefore = p.git('rev-parse', GREETER);
  const h = onProject(p);

  const { flow } = await asked(h);
  assert.deepEqual(h.offered.at(-1), [`Build on ${GREETER}`, 'Start fresh from master']);
  h.pending.supply('continue');
  const where = await flow;

  assert.equal(where.kind, 'build_on');
  assert.deepEqual(h.said.slice(1), [`Committed the last run's 2 files to \`${GREETER}\` so this run builds on them.`]);
  assert.equal(p.git('rev-parse', `${GREETER}~1`), tipBefore);
  assert.equal(p.git('diff-tree', '--no-commit-id', '--name-only', '-r', GREETER), 'greet.py\ntest_greet.py');
  assert.equal(p.git('log', '-1', '--format=%B', GREETER), "Save the earlier run's work before building on it\n\nTask: Build the greeter");
  assert.equal(h.treeReads, 0, 'no switch: nothing is checked, nothing comes along');
  if (where.kind !== 'build_on') return;
  const { engine } = await placedRunOptions(new GitFacts(p.root), where, 'master');
  assert.deepEqual([...(engine.continueOn?.theirs ?? [])].sort(), ['.vscode/settings.json', 'plan.md'], "the owner's files stay theirs, never committed as the run's");
  assert.equal(engine.continueOn?.headCommit, p.git('rev-parse', GREETER), 'the run carries on at the commit that saved them');
});

test("Build on the branch the window is on: a file of the last run's changed since stays the owner's, and the line says it isn't committed", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { committed: { 'greet.py': 'print("hello")\n' }, uncommitted: { 'test_greet.py': 'def test_greet(): pass\n', 'notes.md': 'notes\n' } });
  fs.writeFileSync(path.join(p.root, 'test_greet.py'), 'def test_greet(): assert True\n');
  const h = onProject(p);

  const { flow } = await asked(h);
  h.pending.supply('build on it');

  assert.equal((await flow).kind, 'build_on');
  assert.deepEqual(h.said.slice(1), [
    `Committed the last run's 1 file to \`${GREETER}\` so this run builds on it. \`test_greet.py\` changed after the last run ended, so it isn't committed and stays yours.`,
  ]);
  assert.equal(p.git('diff-tree', '--no-commit-id', '--name-only', '-r', GREETER), 'notes.md');
  assert.equal(p.git('status', '--porcelain'), '?? test_greet.py');
});

test("Start fresh from the branch the window is on: the last run's own files are committed there first, files a command made come along with a line of their own, and the run starts fresh, never on that branch", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { uncommitted: { 'greet.py': 'print("hello")\n' }, task: 'Build the greeter' });
  fs.mkdirSync(path.join(p.root, '__pycache__'));
  fs.writeFileSync(path.join(p.root, '__pycache__', 'greet.cpython-312.pyc'), 'bytes');
  const h = onProject(p);

  const { flow } = await asked(h);
  h.pending.supply('start fresh');

  assert.deepEqual(await flow, { kind: 'fresh' });
  assert.deepEqual(h.said.slice(1), [`Committed the last run's 1 file to \`${GREETER}\` before starting fresh.`, 'This comes along, not committed anywhere: `__pycache__/`.']);
  assert.equal(p.git('diff-tree', '--no-commit-id', '--name-only', '-r', GREETER), 'greet.py');
  assert.equal(p.git('log', '-1', '--format=%B', GREETER), "Save the earlier run's work before starting fresh\n\nTask: Build the greeter");
  assert.equal(p.git('status', '--porcelain'), '?? __pycache__/');
  assert.deepEqual((await placedRunOptions(new GitFacts(p.root), { kind: 'fresh' }, 'master')).engine, { startFresh: true }, 'never stacked on the clarvis branch the window is on');
  assert.deepEqual((await findLeftRuns({ git: new GitFacts(p.root), root: p.root, gitDir: path.join(p.root, '.git'), stillHolds: async () => true })).tasks.map((task) => task.branch), [GREETER], 'offered again next time');
});

test("Start fresh from that branch is refused, with nothing committed, while the owner has changes to tracked files, an untracked file master also has, or one of the last run's files changed since", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { committed: { 'greet.py': 'print("hello")\n' }, uncommitted: { 'test_greet.py': 'def test_greet(): pass\n' } });
  const tip = p.git('rev-parse', GREETER);
  const attempt = async () => {
    const h = onProject(p);
    const { flow } = await asked(h);
    h.pending.supply('start fresh');
    return { where: await flow, said: h.said.slice(1) };
  };
  const refused = (line: string) => ({ where: { kind: 'nothing' }, said: [line] });

  fs.writeFileSync(path.join(p.root, 'README.md'), '# Greeter, edited by the owner\n');
  assert.deepEqual(
    await attempt(),
    refused(`You have changes on \`${GREETER}\` that aren't committed yet (\`README.md\`). Starting fresh from \`master\` would carry them along, so I didn't start. Commit them or put them aside, then ask again.`)
  );
  p.git('checkout', '--', 'README.md');

  p.git('checkout', '--quiet', 'master');
  fs.writeFileSync(path.join(p.root, 'NOTES.md'), 'on master\n');
  p.git('add', 'NOTES.md');
  p.git('commit', '--quiet', '-m', 'Notes on master', '--', 'NOTES.md');
  p.git('checkout', '--quiet', GREETER);
  fs.writeFileSync(path.join(p.root, 'NOTES.md'), 'the owner’s own notes\n');
  assert.deepEqual(
    await attempt(),
    refused("`NOTES.md` isn't in git, and `master` has a file of the same name. Starting fresh from `master` would clash with it, so I didn't start. Commit it or put it aside, then ask again.")
  );
  fs.rmSync(path.join(p.root, 'NOTES.md'));

  fs.writeFileSync(path.join(p.root, 'test_greet.py'), 'def test_greet(): assert True\n');
  assert.deepEqual(
    await attempt(),
    refused(`You have changes on \`${GREETER}\` that aren't committed yet (\`test_greet.py\`). Starting fresh from \`master\` would carry them along, so I didn't start. Commit them or put them aside, then ask again.`)
  );

  assert.equal(p.git('rev-parse', GREETER), tip, 'nothing was committed');
});

test("Build on another left branch from the branch the last run left: that run's own files are committed there before switching, and nothing of it comes along", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun('clarvis/farewell', { committed: { 'farewell.py': 'print("bye")\n' }, endedAt: '2026-09-15T15:00:00Z' });
  await p.leaveClarvisRun(GREETER, { uncommitted: { 'greet.py': 'print("hello")\n' }, endedAt: '2026-09-15T16:00:00Z' });
  const h = onProject(p);

  const { flow } = await asked(h);
  assert.deepEqual(h.offered.at(-1), [`Build on ${GREETER}`, 'Build on clarvis/farewell', 'Start fresh from master']);
  h.pending.supply('Build on clarvis/farewell');
  const where = await flow;

  assert.equal(where.kind === 'build_on' && where.task.branch, 'clarvis/farewell');
  assert.deepEqual(h.said.slice(1), [`Committed the last run's 1 file to \`${GREETER}\` before switching to \`clarvis/farewell\`.`]);
  assert.equal(p.git('diff-tree', '--no-commit-id', '--name-only', '-r', GREETER), 'greet.py');
  assert.equal(p.git('status', '--porcelain'), '', 'nothing of that run comes along');
});

test("Start fresh from master is today's start: nothing read, nothing committed, and the run is offered again next time", async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { committed: { 'greet.py': 'print("hello")\n' } });
  fs.writeFileSync(path.join(p.root, 'README.md'), 'the owner is editing this\n');
  const tip = p.git('rev-parse', GREETER);
  const h = onProject(p);

  const { flow } = await asked(h);
  h.pending.supply('Start fresh from master');

  assert.deepEqual(await flow, { kind: 'fresh' });
  assert.deepEqual([h.treeReads, h.said.length, p.git('rev-parse', GREETER), p.git('symbolic-ref', '--short', 'HEAD')], [0, 1, tip, 'master']);
  assert.deepEqual((await findLeftRuns({ git: new GitFacts(p.root), root: p.root, gitDir: path.join(p.root, '.git'), stillHolds: async () => true })).tasks.map((task) => task.branch), [GREETER]);
});

test('Unattended on the branch the last run left: builds on it without asking, with one line saying so and one saying what was committed', async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { uncommitted: { 'greet.py': 'print("hello")\n' } });
  const h = onProject(p, { unattended: true });

  const where = await within(whereClarvisWorks(h.host));

  assert.equal(where.kind, 'build_on');
  assert.deepEqual(h.said, [CLARVIS_LEFT_WORK_LINES.unattendedBuildOn(GREETER), `Committed the last run's 1 file to \`${GREETER}\` so this run builds on it.`]);
  assert.deepEqual(h.offered, []);
});

test('not asked when nothing was left: no record, a branch only Codex left, a run merged into master, or one whose branch was deleted', async (t) => {
  const p = await leftWorkProject(t);
  const nothingAsked = async (why: string) => {
    const h = onProject(p);
    assert.deepEqual(await within(whereClarvisWorks(h.host)), { kind: 'fresh' }, why);
    assert.deepEqual([h.said, h.offered], [[], []], why);
  };

  await nothingAsked('no record');
  p.leaveCodexWork('clarvis/codex-greeter', { file: 'greet.py' });
  await nothingAsked("a branch Codex left, with its idle task in RAVIS, is the Codex question's");
  await p.leaveClarvisRun('clarvis/merged', { committed: { 'merged.py': 'x = 1\n' } });
  p.git('merge', '--quiet', '--no-edit', 'clarvis/merged');
  await p.leaveClarvisRun('clarvis/deleted', { committed: { 'deleted.py': 'x = 2\n' } });
  p.git('branch', '-D', 'clarvis/deleted');
  await nothingAsked('merged, and deleted');
});

test('the record survives a window reload and serves the other editor: a run left from code-server is asked about by a fresh window in desktop VS Code', async (t) => {
  const p = await leftWorkProject(t);
  await p.leaveClarvisRun(GREETER, { committed: { 'greet.py': 'print("hello")\n' }, host: 'code-server', summary: 'Built it in the browser editor.' });

  // Nothing of the first window is kept: a new finder, new git facts, the record read from the git folder.
  const h = onProject(p);
  const { flow } = await asked(h);
  assert.match(h.said[0], /^My earlier work is still on/);
  h.pending.supply('1');
  const where = await flow;

  assert.deepEqual(where.kind === 'build_on' && [where.task.run.host, where.task.run.summary], ['code-server', 'Built it in the browser editor.']);
});
