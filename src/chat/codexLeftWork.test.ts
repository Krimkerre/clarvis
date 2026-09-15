import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { AgentEvent } from '../agent/AgentRunner';
import { continuationDecision } from '../agent/branchNames';
import { GitFacts, type WorkingTree } from '../engine/checkpoint/gitFacts';
import { findLeftWork, type LeftTask, type LeftWork } from '../engine/codex/leftTasks';
import { CodexRunCore, type CodexBranch, type CodexGit, type CodexSave } from '../engine/codex/runCore';
import { leftWorkProject } from '../test/fakes/leftWorkProject';
import {
  buildOnLabel,
  leftWorkChoice,
  LEFT_WORK_LINES,
  startFreshLabel,
  whereCodexWorks,
  type CodexWhere,
  type LeftWorkHost,
} from './codexLeftWork';
import { PendingChoice } from './PendingChoice';

/**
 * **Build on Codex's earlier work, or start fresh**, from the question to Codex's next turn (plan.md M15; the owner's
 * decision of 15 Sep 2026, "Ask each time"). Driven through the real `PendingChoice` the chat panel answers; the end-to-end
 * tests use real git in temporary repositories whose trunk is `master`, and the fake RAVIS relay.
 *
 * The live failure this ends: in `live-test-c`, a follow-up to a greeter Codex had built started a new Codex task on a
 * new branch from `master`, and Codex wrote a second greeter from scratch. So the guards, in the order someone would
 * notice them missing: no question at all; the owner's typed "build on it" sent to Codex as a task instead of answering;
 * a question that runs something though it went unanswered, was stopped or dropped by a mode switch; Unattended asking
 * anyway, or picking a branch the window isn't on; a switch that carries the owner's uncommitted work along; and Build
 * on making a new session or a new branch after all.
 */

const GREETER = 'clarvis/build-the-greeter-described-in-readme-md-greet-p';
const SHOUT = 'Also add a --shout option to greet.py that prints the greeting in capitals, with a test for it.';

// ── The question, through the real PendingChoice ─────────────────────────────

interface Asking {
  host: LeftWorkHost;
  pending: PendingChoice;
  /** The buttons each time the panel was given some, and `[]` each time they were cleared. */
  offered: string[][];
  said: string[];
  logged: string[];
  treeReads: number;
}

function leftTask(branch: string, patch: Partial<LeftTask> = {}): LeftTask {
  return { sessionId: `as_${branch.replace(/\W/g, '')}`, taskId: `task-${branch}`, branch, tip: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', updatedAt: '2026-09-15T16:00:00Z', onBranch: false, ...patch };
}

function work(tasks: LeftTask[], headBranch = 'master'): LeftWork {
  return { startsFrom: 'master', trunk: 'master', headBranch, tasks };
}

/**
 * As `RunSession.whereCodexWorks` wires it: its own buttons and words only. `tree` stands in for the checkout's changes
 * (`GitFacts.workingTree`) and `onTarget` for the files on the branch a switch goes to (`GitFacts.filesOn`).
 */
function asking(find: () => Promise<LeftWork>, options: { unattended?: boolean; tree?: Partial<WorkingTree>; onTarget?: string[] } = {}): Asking {
  const offered: string[][] = [];
  const pending = new PendingChoice((items) => offered.push(items.map((item) => item.label)));
  const h: Asking = { host: undefined as unknown as LeftWorkHost, pending, offered, said: [], logged: [], treeReads: 0 };
  h.host = {
    find,
    unattended: () => options.unattended ?? false,
    ask: (choices, accepts) => pending.ask(choices, 'where Codex should work', true, accepts),
    note: async (line) => void h.said.push(line),
    tree: async () => {
      h.treeReads++;
      return { changed: [], untracked: [], shown: [], ...options.tree };
    },
    filesOn: async () => options.onTarget ?? [],
    log: (line) => void h.logged.push(line),
  };
  return h;
}

/** The question running, once its buttons are on screen. Wrapped, so awaiting this doesn't wait for an answer. */
async function asked(h: Asking): Promise<{ flow: Promise<CodexWhere> }> {
  const flow = whereCodexWorks(h.host);
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

test('asked with one left task: one plain line, then Build on <branch> and Start fresh from master', async () => {
  const task = leftTask(GREETER);
  const h = asking(async () => work([task]));

  const { flow } = await asked(h);

  assert.deepEqual(h.said, [
    `Codex's earlier work is still on \`${GREETER}\`, not merged into \`master\`. Build on it, and Codex adds to that work and keeps its earlier conversation, or start fresh on a new branch from \`master\`.`,
  ]);
  assert.deepEqual(h.offered.at(-1), [`Build on ${GREETER}`, 'Start fresh from master']);
  assert.equal(h.pending.supply(`Build on ${GREETER}`), true);
  assert.deepEqual(await flow, { kind: 'build_on', task });
  assert.deepEqual(h.offered.at(-1), [], 'the buttons are gone');
});

test('asked with several: the branch the window is on first, then the most recent, at most three, then Start fresh', async () => {
  const tasks = [
    leftTask('clarvis/one', { updatedAt: '2026-09-15T10:00:00Z' }),
    leftTask('clarvis/two', { updatedAt: '2026-09-15T11:00:00Z', onBranch: true }),
    leftTask('clarvis/three', { updatedAt: '2026-09-15T12:00:00Z' }),
    leftTask('clarvis/four', { updatedAt: '2026-09-15T13:00:00Z' }),
  ];
  const h = asking(async () => work(tasks, 'clarvis/two'));

  const { flow } = await asked(h);

  assert.deepEqual(h.offered.at(-1), ['Build on clarvis/two', 'Build on clarvis/four', 'Build on clarvis/three', 'Start fresh from master']);
  assert.match(h.said[0], /^Codex left earlier work on 4 branches that aren't merged into `master`\. The 3 most recent are below\. Build on one, and Codex adds/);
  assert.equal(h.pending.supply('2'), true, 'a number picks the button, as every question here');
  assert.deepEqual(await flow, { kind: 'build_on', task: tasks[3] });
});

test('not asked when nothing was left: a fresh start, as today, with nothing said', async () => {
  const h = asking(async () => work([]));

  assert.deepEqual(await within(whereCodexWorks(h.host)), { kind: 'fresh' });
  assert.deepEqual([h.said, h.offered, h.pending.isWaiting], [[], [], false]);
});

test('Start fresh, clicked, numbered or typed ("fresh", "start fresh", "new branch"), is a fresh start and reads no changes', async () => {
  for (const typed of ['Start fresh from master', '2', 'fresh', 'start fresh', 'new branch', 'Start over']) {
    const h = asking(async () => work([leftTask(GREETER)]));
    const { flow } = await asked(h);

    assert.equal(h.pending.supply(typed), true, typed);
    assert.deepEqual(await flow, { kind: 'fresh' }, typed);
    assert.equal(h.treeReads, 0, typed);
  }
});

test('typing "build on it", "continue" or "that branch" answers like the button, and is consumed, so it never reaches Codex as a task', async () => {
  for (const typed of ['build on it', 'Build on that branch', 'continue', 'continue there', 'that branch', '1']) {
    const task = leftTask(GREETER);
    const h = asking(async () => work([task]));
    const { flow } = await asked(h);

    // Consumed: `ChatService.runTook` stops routing here, so the words are never a Codex task.
    assert.equal(h.pending.supply(typed), true, typed);
    assert.deepEqual(await flow, { kind: 'build_on', task }, typed);
  }
});

test('anything else typed is the message it is: the question goes, and nothing runs', async () => {
  for (const typed of [SHOUT, 'ok', 'yes', 'no', 'build on it?', 'continue with the greeter but add a shout flag too']) {
    const h = asking(async () => work([leftTask(GREETER)]));
    const { flow } = await asked(h);

    assert.equal(h.pending.supply(typed), false, `${typed} goes on to be read as a message`);
    assert.deepEqual(await flow, { kind: 'nothing' }, typed);
    assert.deepEqual(h.offered.at(-1), [], typed);
  }
});

test('Stop while the question shows runs nothing', async () => {
  const h = asking(async () => work([leftTask(GREETER)]));
  const { flow } = await asked(h);

  // `RunSession.stopWaiting`, from the Stop button or a typed "stop".
  h.pending.cancel();

  assert.deepEqual(await flow, { kind: 'nothing' });
  assert.ok(h.logged.some((line) => /went unanswered, was stopped or was dropped, so nothing runs/.test(line)));
});

test('a mode switch while the question shows drops it, and presses nothing', async () => {
  const h = asking(async () => work([leftTask(GREETER, { onBranch: true })], GREETER));
  const { flow } = await asked(h);

  // `RunSession.modeStoppedAsking` supplies "Do it" as not typed.
  assert.equal(h.pending.supply('Do it', false), false);

  assert.deepEqual(await flow, { kind: 'nothing' });
});

test('Unattended asks nothing: it builds on the branch the window is on, and says so in one line', async () => {
  const here = leftTask(GREETER, { onBranch: true, updatedAt: '2026-09-15T09:00:00Z' });
  const h = asking(async () => work([leftTask('clarvis/newer'), here], GREETER), { unattended: true });

  assert.deepEqual(await within(whereCodexWorks(h.host)), { kind: 'build_on', task: here });
  assert.deepEqual(h.said, [LEFT_WORK_LINES.unattendedBuildOn(GREETER)]);
  assert.match(h.said[0], /^Unattended, so I didn't ask: Codex builds on `clarvis\/build-the-greeter-described-in-readme-md-greet-p`, the branch you're on/);
  assert.deepEqual([h.offered, h.pending.isWaiting], [[], false]);
});

test("Unattended starts fresh when the window isn't on a left branch, and says so in one line", async () => {
  const h = asking(async () => work([leftTask(GREETER)]), { unattended: true });

  assert.deepEqual(await within(whereCodexWorks(h.host)), { kind: 'fresh' });
  assert.deepEqual(h.said, [`Unattended, so I didn't ask: Codex starts fresh on a new branch from \`master\`. Its earlier work stays on \`${GREETER}\`.`]);
  assert.deepEqual(h.offered, []);
});

test('Build on a branch the window is not on, with uncommitted changes to tracked files, is refused in plain words and nothing runs; on the branch itself it goes ahead', async () => {
  const h = asking(async () => work([leftTask(GREETER)]), { tree: { changed: ['README.md', 'notes.txt'] } });
  const { flow } = await asked(h);
  h.pending.supply('build on it');

  assert.deepEqual(await flow, { kind: 'nothing' });
  assert.match(h.said[1], /^You have changes on `master` that aren't committed yet \(`README\.md`, `notes\.txt`\)\. Switching to `clarvis\/build-the-greeter/);

  const here = leftTask(GREETER, { onBranch: true });
  const onIt = asking(async () => work([here], GREETER), { tree: { changed: ['README.md'] } });
  const again = await asked(onIt);
  onIt.pending.supply('build on it');
  assert.deepEqual(await again.flow, { kind: 'build_on', task: here });
  assert.equal(onIt.treeReads, 0, 'no switch, so nothing of the owner’s moves');
});

// ── Changed from 0.17.3: the switch rule both engines share (plan.md M15, the owner's rule of 15 Sep 2026) ──────────

test("changed from 0.17.3: untracked files the branch doesn't have no longer refuse a Build on; they come along, named in a line of their own", async () => {
  const task = leftTask(GREETER);
  const h = asking(async () => work([task]), { tree: { untracked: ['README.md', '__pycache__/greet.cpython-312.pyc'], shown: ['README.md', '__pycache__/'] }, onTarget: ['greet.py'] });
  const { flow } = await asked(h);
  h.pending.supply('build on it');

  assert.deepEqual(await flow, { kind: 'build_on', task });
  assert.deepEqual(h.said.slice(1), ['These come along, not committed anywhere: `README.md`, `__pycache__/`.']);
});

test('an untracked file the branch has a file of the same name for refuses the switch, naming it', async () => {
  const h = asking(async () => work([leftTask(GREETER)]), { tree: { untracked: ['greet.py'], shown: ['greet.py'] }, onTarget: ['README.md', 'greet.py'] });
  const { flow } = await asked(h);
  h.pending.supply('build on it');

  assert.deepEqual(await flow, { kind: 'nothing' });
  assert.equal(
    h.said[1],
    `\`greet.py\` isn't in git, and \`${GREETER}\` has a file of the same name. Switching to \`${GREETER}\` would clash with it, so Codex didn't start. Commit it or put it aside, then ask again.`
  );
});

test("changed from 0.17.3: Start fresh from a clarvis branch the window is on is checked the same way; git that can't say refuses too", async () => {
  const here = leftTask(GREETER, { onBranch: true });
  const h = asking(async () => work([leftTask('clarvis/other'), here], GREETER), { tree: { changed: ['greet.py'] } });
  const { flow } = await asked(h);
  h.pending.supply('start fresh');

  assert.deepEqual(await flow, { kind: 'nothing' });
  assert.equal(
    h.said[1],
    `You have changes on \`${GREETER}\` that aren't committed yet (\`greet.py\`). Starting fresh from \`master\` would carry them along, so Codex didn't start. Commit them or put them aside, then ask again.`
  );

  const blind = asking(async () => work([leftTask('clarvis/other')]));
  blind.host.tree = async () => undefined;
  const again = await asked(blind);
  blind.pending.supply('build on it');
  assert.deepEqual(await again.flow, { kind: 'nothing' });
  assert.equal(blind.said[1], "I couldn't tell which files in this folder have changes, so Codex didn't start. Ask again in a moment.");
});

test('typed answers: the question’s own words, short; the shared yes, questions and sentences are not answers', () => {
  const offered = [leftTask(GREETER), leftTask('clarvis/other')];
  for (const typed of ['build on it', 'build on this branch', 'continue', 'Continue on it', 'that branch', 'use the same branch']) {
    assert.equal(leftWorkChoice(typed, offered, 'master'), buildOnLabel(GREETER), typed);
  }
  for (const typed of ['fresh', 'start fresh', 'Start a new one', 'new branch', 'on a new branch', 'start over']) {
    assert.equal(leftWorkChoice(typed, offered, 'master'), startFreshLabel('master'), typed);
  }
  for (const typed of ['yes', 'ok', 'do it', 'no', 'not now', 'continue?', 'what is on that branch', 'continue with the greeter and add tests please', SHOUT]) {
    assert.equal(leftWorkChoice(typed, offered, 'master'), undefined, typed);
  }
});

// ── End to end: finding, asking, and Codex's next turn ───────────────────────

const WINDOW = { id: 'win-code-server-7f3a2b', host: 'code-server' as const };
const FAST = { streamBackoffMs: [20, 40, 80], silenceLimitMs: 5_000, retry: { attempts: 2, delayMs: 10 }, interruptRetry: { attempts: 3, delayMs: 10 }, interruptKeepTryingMs: 20 };

/**
 * Git for the Codex runner, done with real git: a switch continues on a branch by the same rule `AgentBranch.continueOn`
 * applies (`continuationDecision`), and a save commits on the task's branch. The Git extension glue itself is checked in
 * the extension host (`codexBuildOn.spec.ts`).
 */
class RealGit implements CodexGit {
  readonly begun: string[] = [];
  readonly continued: { branch: string; headCommit: string; task?: string }[] = [];

  constructor(private readonly root: string) {}

  async begin(task: string): Promise<CodexBranch> {
    this.begun.push(task);
    return { ok: false, line: 'a new branch was asked for' };
  }

  async continueOn(branch: string, headCommit: string, task?: string): Promise<CodexBranch> {
    this.continued.push({ branch, headCommit, task });
    const facts = new GitFacts(this.root);
    const tip = await facts.tip(branch);
    const contains = tip !== undefined && (await facts.isAncestor(headCommit, tip));
    const decision = continuationDecision(branch, await facts.branches(), tip, headCommit, contains);
    if (decision.kind === 'refuse') return { ok: false, line: decision.advice };
    this.git('checkout', '--quiet', branch);
    return { ok: true, branch, headCommit: this.git('rev-parse', 'HEAD') };
  }

  async save(work: { summary: string; files: string[]; branch: string | undefined }): Promise<CodexSave> {
    if (work.files.length === 0) return { ok: true, commit: this.git('rev-parse', 'HEAD'), committed: false, files: [] };
    const committed = await new GitFacts(this.root).commitOnBranch(work.branch ?? '', work.files, `Codex: ${work.summary}`);
    return committed.ok ? { ok: true, commit: committed.commit, committed: true, files: work.files } : { ok: false, line: committed.detail };
  }

  async abandon(): Promise<void> {}

  private git(...args: string[]): string {
    return execFileSync('git', ['-C', this.root, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
  }
}

test('Build on, end to end in a master repository: the window moves to the greeter’s branch, and the request is a continue turn on the old session, with no new session and no new branch', async (t) => {
  const p = await leftWorkProject(t);
  const session = p.leaveCodexWork(GREETER, { file: 'greet.py' });
  const tipBefore = p.git('rev-parse', GREETER);
  const branches = () => p.git('for-each-ref', '--format=%(refname:short)', 'refs/heads');
  const branchesBefore = branches();
  const h = asking(() => findLeftWork(p.deps()));

  const { flow } = await asked(h);
  assert.match(h.said[0], /^Codex's earlier work is still on `clarvis\/build-the-greeter-described-in-readme-md-greet-p`, not merged into `master`\./);
  assert.deepEqual(h.offered.at(-1), [`Build on ${GREETER}`, 'Start fresh from master']);
  assert.equal(h.pending.supply('build on it'), true);
  const where = await flow;
  assert.equal(where.kind, 'build_on');
  if (where.kind !== 'build_on') return;

  const git = new RealGit(p.root);
  const core = new CodexRunCore({
    relay: p.relay,
    tokens: p.tokens,
    cursors: { get: () => null, set: () => undefined },
    git,
    window: WINDOW,
    workspace: { root: p.root, gitDir: path.join(p.root, '.git') },
    mode: 'agent',
    maxSteps: 25,
    ask: async () => undefined,
    timing: FAST,
  });
  t.after(() => core.dispose());
  const events: AgentEvent[] = [];
  let over = false;
  void (async () => {
    try {
      for await (const event of core.buildOn(where.task, SHOUT, new AbortController().signal)) events.push(event);
    } finally {
      over = true;
    }
  })();
  await until(() => session.turns.length === 1 || over);

  assert.deepEqual(session.turns, [{ text: SHOUT, kind: 'continue' }], `the request is a turn on the earlier task; it said ${JSON.stringify(events)}`);
  assert.equal(p.git('symbolic-ref', '--short', 'HEAD'), GREETER, "the window is on the greeter's branch");
  assert.ok(fs.existsSync(path.join(p.root, 'greet.py')), 'greet.py is there for Codex to add to');
  assert.equal(branches(), branchesBefore, 'no new branch');
  assert.equal(p.fake.sessions().all.length, 1, 'no new session');
  assert.equal(p.sent.includes('POST /api/v1/agent-sessions'), false, 'nothing created in RAVIS');
  assert.deepEqual(git.begun, []);
  assert.deepEqual(git.continued, [{ branch: GREETER, headCommit: tipBefore, task: SHOUT }]);

  // Codex adds the option to its own greeter, on the same branch.
  fs.writeFileSync(path.join(p.root, 'greet.py'), 'import sys\nprint("HELLO" if "--shout" in sys.argv else "hello")\n');
  p.fake.sessions().completeItem(session, { type: 'fileChange', id: 'call_fc_1', status: 'completed', changes: [{ path: 'greet.py', change: 'update', added: 1, removed: 1 }] });
  p.fake.sessions().completeItem(session, { type: 'agentMessage', id: 'msg_shout', text: 'Added --shout.', phase: null });
  p.fake.sessions().completeTurn(session);
  await until(() => over);

  assert.equal(p.git('rev-parse', `${GREETER}~1`), tipBefore, "Codex's new commit sits on its earlier work");
  assert.equal(events.at(-1)?.text, 'Added --shout.');
  assert.deepEqual(session.settles.map((settle) => settle.next), ['idle']);
  assert.deepEqual(p.fake.violations, []);
});

test('Start fresh is today’s start: nothing is sent to the earlier task, which stays idle and is offered again next time', async (t) => {
  const p = await leftWorkProject(t);
  const session = p.leaveCodexWork(GREETER, { file: 'greet.py' });
  const h = asking(() => findLeftWork(p.deps()));

  const { flow } = await asked(h);
  assert.equal(h.pending.supply('start fresh'), true);

  assert.deepEqual(await flow, { kind: 'fresh' });
  assert.deepEqual([session.state, session.turns.length], ['idle', 0]);
  assert.equal(p.sent.some((line) => line.startsWith('POST')), false, 'nothing was sent to RAVIS');
  assert.equal(p.git('symbolic-ref', '--short', 'HEAD'), 'master', 'no branch moved');
  assert.equal((await findLeftWork(p.deps())).tasks[0]?.sessionId, session.id, 'offered again later');
});
