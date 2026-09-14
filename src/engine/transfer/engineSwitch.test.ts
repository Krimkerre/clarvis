import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from '../../agent/AgentRunner';
import { CLARVIS_CREDENTIAL, FakeRavisRelay } from '../../test/fakes/FakeRavisRelay';
import type { FakeLocks } from '../../test/fakes/fakeLocks';
import type { FakeSessions, MachineSession } from '../../test/fakes/fakeSessions';
import { readCheckpoint } from '../checkpoint/checkpointFile';
import { GitFacts } from '../checkpoint/gitFacts';
import { newCheckpoint, undeliveredFeedback, type TaskCheckpoint } from '../checkpoint/taskCheckpoint';
import type { PromptShower, RequestPrompt } from '../codex/approvals';
import { CodexRunCore, type CodexBranch, type CodexGit, type CodexRunOptions, type CodexSave } from '../codex/runCore';
import { CODEX_LINES } from '../codex/translate';
import { encodeLockFile, lockFilePath, readLockFile, type LockFileContent } from '../lock/fileLock';
import type { GroupStop } from '../lock/groupKill';
import { LockClient } from '../lock/lockClient';
import { takeProjectLock, type LockOutcome, type ProjectLock, type ProjectLockDeps } from '../lock/projectLock';
import { RelayClient } from '../relay/relayClient';
import { RelayHttp, relayEndpoint } from '../relay/relayHttp';
import type { RunningCommand } from '../relay/relayTypes';
import { TokenStore } from '../relay/tokenStore';
import { ClarvisDestination, ClarvisSource, type ClarvisRunHandle } from './clarvisSwitch';
import { CodexDestination, CodexSource } from './codexSwitch';
import { EngineSwitch, SWITCH_LINES, type SwitchPrompts } from './engineSwitch';
import { switchConfirmLine } from './transferState';

/**
 * Switching an unfinished task between Codex and Clarvis's own engine, both ways (design §6.2), against the fake
 * RAVIS with its session and lock machines, a real git repository in a temporary folder, and real lock and
 * checkpoint files. The guards, as a person would notice them missing:
 * - a switch that let go of the project before the other engine had it, so a third window started writing;
 * - Codex's question answered for the other engine, or its work saved after the destination had started;
 * - the other engine starting on a new branch beside the work, or beside something still running;
 * - words typed during the switch that never reached the engine that carried on;
 * - a cut-off `npm install` run again by the engine that carried on;
 * - a failed switch that released the lock while a command was still going, or on an expired token.
 */

const WINDOW = { id: 'win-desktop-1c9e4d', host: 'desktop' as const };
const THIRD = { id: 'win-code-server-7f3a2b', host: 'code-server' as const };
const TASK = 'Build milestone 2 of plan.md. Before each step, print STEP: <the step, copied from the plan>.';
const TASK_ID = '8b1c2d3e-4f50-4a61-9b72-83c4d5e6f708';
const COMMIT = '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';
/** `codex-state.json`'s Codex home, which the default `GET /api/v1/codex` answer names. */
const HOME = 'sha256:d7f90d4554be65c7796599f94992709e65bff5bae4234c7fcdfadade543cc593';
const NPM: RunningCommand = { pid: 48210, pgid: 48210, start: 'Sun Sep 13 05:41:07 2026', comm: 'npm' };
const FAST = { streamBackoffMs: [20, 40, 80], silenceLimitMs: 5_000, retry: { attempts: 2, delayMs: 10 }, interruptRetry: { attempts: 3, delayMs: 10 }, interruptKeepTryingMs: 20 };

/** Codex's git as the runner sees it: commits recorded, branches continued where told. */
class RecordingGit implements CodexGit {
  readonly continued: [string, string][] = [];
  readonly forSwitch: boolean[] = [];
  refuseContinuation: string | undefined;

  async begin(): Promise<CodexBranch> {
    return { ok: true, branch: 'clarvis/add-utc', headCommit: COMMIT };
  }

  async continueOn(branch: string, headCommit: string): Promise<CodexBranch> {
    this.continued.push([branch, headCommit]);
    return this.refuseContinuation ? { ok: false, line: this.refuseContinuation } : { ok: true, branch, headCommit };
  }

  async save(work: { files: string[]; forSwitch?: boolean }): Promise<CodexSave> {
    this.forSwitch.push(work.forSwitch === true);
    return { ok: true, commit: COMMIT, committed: true, files: work.files };
  }

  async abandon(): Promise<void> {}
}

interface Harness {
  root: string;
  gitDir: string;
  fake: FakeRavisRelay;
  machine: FakeSessions;
  locks: FakeLocks;
  /** Requests as `METHOD /path`, and the markers a test adds, in order. */
  sent: string[];
  relay: RelayClient;
  tokens: TokenStore;
  git: RecordingGit;
  core(options?: Partial<CodexRunOptions>): CodexRunCore;
  lockDeps(window: { id: string; host: 'desktop' | 'code-server' }, overrides?: Partial<ProjectLockDeps>): ProjectLockDeps;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
}

async function withSwitch(run: (h: Harness) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-switch-')));
  const tokenFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-switch-tokens-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  for (const [key, value] of [['user.name', 'Clarvis test'], ['user.email', 'clarvis-test@example.invalid'], ['commit.gpgsign', 'false']]) git(root, 'config', key, value);
  fs.writeFileSync(path.join(root, 'hello.py'), 'print("hello")\n');
  git(root, 'add', 'hello.py');
  git(root, 'commit', '--quiet', '-m', 'first');
  const fake = await FakeRavisRelay.start();
  const sent: string[] = [];
  const endpoint = relayEndpoint(fake.url, CLARVIS_CREDENTIAL);
  if (!endpoint.ok) throw new Error(endpoint.reason);
  const http = new RelayHttp(endpoint.endpoint, (input, init) => {
    sent.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return fetch(input, init);
  });
  const relay = new RelayClient(http);
  const lockClient = new LockClient(http);
  const tokens = new TokenStore(tokenFolder);
  const cursors = new Map<string, number>();
  const recordingGit = new RecordingGit();
  const cores: CodexRunCore[] = [];
  const gitDir = path.join(root, '.git');
  const harness: Harness = {
    root,
    gitDir,
    fake,
    machine: fake.sessions(),
    locks: fake.locks(),
    sent,
    relay,
    tokens,
    git: recordingGit,
    core: (options = {}) => {
      const made = new CodexRunCore({
        relay,
        locks: lockClient,
        tokens,
        cursors: { get: (id) => cursors.get(id) ?? null, set: (id, value) => void cursors.set(id, value) },
        git: recordingGit,
        window: WINDOW,
        workspace: { root, gitDir },
        mode: 'agent',
        maxSteps: 25,
        ask: async () => undefined,
        timing: FAST,
        ...options,
      });
      cores.push(made);
      return made;
    },
    lockDeps: (window, overrides = {}) => ({
      root,
      gitDir,
      taskId: TASK_ID,
      window,
      pid: process.pid,
      pidStart: 'Sun Sep 13 05:10:02 2026',
      locks: lockClient,
      judge: async () => 'alive',
      stopGroup: async () => ({ gone: true, signalled: 1 }),
      every: () => () => undefined,
      ...overrides,
    }),
  };
  try {
    await run(harness);
    assert.deepEqual(fake.violations, [], 'every request, answer and frame matched the contract fixtures');
  } finally {
    for (const made of cores) made.dispose();
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(tokenFolder, { recursive: true, force: true });
  }
}

interface Followed {
  events: AgentEvent[];
  next(match: (event: AgentEvent) => boolean): Promise<AgentEvent>;
}

function follow(events: AsyncIterable<AgentEvent>): Followed {
  const seen: AgentEvent[] = [];
  let over = false;
  void (async () => {
    try {
      for await (const event of events) seen.push(event);
    } finally {
      over = true;
    }
  })();
  return {
    events: seen,
    async next(match) {
      await waitFor(() => over || seen.some(match), 'an event');
      const found = seen.find(match);
      if (!found) throw new Error(`the run ended first; it said ${JSON.stringify(seen)}`);
      return found;
    },
  };
}

/** A promise that fails the test after `ms`, instead of hanging the suite. */
function within<T>(promise: Promise<T>, what: string, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function holdingAsker(): { ask: PromptShower; asked: { prompt: RequestPrompt; signal: AbortSignal; answer(reply: string | undefined): void }[] } {
  const asked: { prompt: RequestPrompt; signal: AbortSignal; answer(reply: string | undefined): void }[] = [];
  const ask: PromptShower = (prompt, signal) => new Promise((resolve) => asked.push({ prompt, signal, answer: resolve }));
  return { ask, asked };
}

/** The checkout lock file RAVIS writes for a Codex session (the fake writes no files). */
function codexLockFile(file: string, session: MachineSession): void {
  const content: LockFileContent = {
    version: 3,
    ravis_lock_id: null,
    taskId: session.taskId,
    engine: 'codex',
    state: 'running',
    holder: { kind: 'codex_session', session_id: session.id, pid: 4411, pid_start: 'Sun Sep 13 05:10:02 2026', window_id: null, host: 'ravis', since: '2026-09-13T01:12:00Z' },
    heartbeatAt: '2026-09-13T01:42:00Z',
    waitingOnYou: false,
    leftover: [],
    takenOverFrom: null,
    running_command: null,
  };
  fs.writeFileSync(file, encodeLockFile(content), { mode: 0o600 });
}

const confirmAll = (confirmations: string[], leftover: 'stop_them' | 'cancel' = 'stop_them', leftovers: string[] = []): SwitchPrompts => ({
  confirm: async (line) => (confirmations.push(line), true),
  leftover: async (line) => (leftovers.push(line), leftover),
});

const isDone = (event: AgentEvent) => event.kind === 'done';

// ── Codex → Clarvis's own engine ─────────────────────────────────────────────

/** A Codex task running with a question on screen, and the pieces of a switch to Clarvis's own engine around it. */
async function codexTaskToSwitch(h: Harness) {
  const { ask, asked } = holdingAsker();
  const core = h.core({ ask });
  const codexRun = follow(core.start(TASK, new AbortController().signal));
  await waitFor(() => h.machine.all.length === 1 && core.isConnected, 'the Codex task to run');
  const session = h.machine.all[0];
  h.machine.openRequest(session, 'command');
  await waitFor(() => asked.length === 1, 'the question to be asked');
  codexLockFile(lockFilePath(h.root, h.gitDir), session);
  const source = new CodexSource({ core, saved: undefined, workspaceRoot: h.root, gitDir: h.gitDir, host: 'desktop', homeFingerprint: HOME });
  return { core, codexRun, session, asked, source };
}

test("Codex → Clarvis's own engine, in order: the lock reserved, the question let go, the stop confirmed, the work committed, the checkpoint written, settled for transfer — only then the lock taken with the token and the run started", () =>
  withSwitch(async (h) => {
    const { core, codexRun, session, asked, source } = await codexTaskToSwitch(h);
    const lockId = h.locks.rowForSession(session.id)?.id;
    assert.ok(lockId, 'the Codex session holds the project from its create');
    const confirmations: string[] = [];
    const briefs: TaskCheckpoint[] = [];
    const facts: { questionLetGo?: boolean; state?: string; thirdWindow?: LockOutcome; taken?: LockOutcome } = {};
    // The switch, once made: the destination and the save below speak to it while it runs.
    const live: { engineSwitch?: EngineSwitch } = {};
    const destination = new ClarvisDestination({
      model: 'ravis/clarvis-agent',
      workspaceRoot: h.root,
      gitDir: h.gitDir,
      take: async (token, checkpoint) => {
        h.sent.push('the destination takes the lock');
        facts.taken = await takeProjectLock(h.lockDeps(WINDOW, { taskId: checkpoint.taskId, transferToken: token, transferredFrom: checkpoint.codexSession?.id }));
        return facts.taken;
      },
      run: async (checkpoint) => {
        briefs.push(checkpoint);
        h.sent.push("Clarvis's own engine started");
        live.engineSwitch?.noteFeedback('Also update the README.'); // typed after the brief was written
        return { ok: true, value: undefined };
      },
    });
    const reserve = source.stopForSwitch.bind(source);
    source.stopForSwitch = async () => {
      const reserved = await reserve();
      facts.questionLetGo = asked[0].signal.aborted;
      core.interject('Keep the --local flag too.'); // typed while Codex is stopping
      return reserved;
    };
    const save = source.saveCheckpoint.bind(source);
    source.saveCheckpoint = async (checkpoint) => {
      const written = await save(checkpoint);
      h.sent.push('checkpoint written');
      facts.state = h.locks.rowFor(h.root)?.state;
      facts.thirdWindow = await takeProjectLock(h.lockDeps(THIRD, { taskId: 'a-third-task' }));
      live.engineSwitch?.noteFeedback('Typed while the work was being saved.');
      return written;
    };
    live.engineSwitch = new EngineSwitch({ source, destination, prompts: confirmAll(confirmations), host: 'desktop', sourceModel: 'ravis/clarvis-codex' });

    const outcome = await live.engineSwitch.run();

    assert.equal(outcome.kind, 'started', JSON.stringify(outcome));
    assert.deepEqual(confirmations, [switchConfirmLine('clarvis', 'ravis/clarvis-agent')], 'the cost was confirmed before anything stopped');
    assert.equal(facts.questionLetGo, true, 'the question went as soon as the project was reserved');
    assert.deepEqual(
      h.sent.filter((line) => /\/transfer$|\/interrupt$|\/settle|checkpoint written|destination takes|POST \/api\/v1\/project-locks$|engine started/.test(line)),
      [
        `POST /api/v1/project-locks/${lockId}/transfer`,
        `POST /api/v1/agent-sessions/${session.id}/interrupt`,
        `POST /api/v1/agent-sessions/${session.id}/settle-claim`,
        'checkpoint written',
        `POST /api/v1/agent-sessions/${session.id}/settle`,
        'the destination takes the lock',
        'POST /api/v1/project-locks',
        "Clarvis's own engine started",
      ]
    );
    assert.deepEqual(h.fake.seen.find((request) => request.path.endsWith('/interrupt'))?.body, { reason: 'switch' });
    assert.deepEqual([session.settles.map((settle) => settle.next), h.git.forSwitch], [['transfer'], [true]], "Codex's work committed as stopped for a switch, then settled for transfer");
    assert.equal(h.sent.some((line) => line.endsWith('/release') || line.startsWith('DELETE')), false, 'nothing released, and the session never ended');
    assert.equal(session.state, 'idle', 'left idle with its thread, for a switch back');
    assert.equal(facts.state, 'transferring', 'the lock was held, reserved for the destination, while the checkpoint was written');
    assert.equal(facts.thirdWindow?.held, false, 'a third window could not take the project in the middle of the switch');
    assert.deepEqual(session.answers, [], "Codex's question was never answered for the other engine");

    const brief = briefs[0];
    assert.deepEqual([brief.engine, brief.git.branch, brief.git.headCommit, brief.transfer?.step, brief.codexSession?.homeFingerprint], ['codex', 'clarvis/add-utc', COMMIT, 'starting', HOME]);
    assert.match(brief.unresolvedQuestions[0]?.summary ?? '', /^Codex asked to run `/);
    assert.deepEqual(undeliveredFeedback(brief), ['Keep the --local flag too.', 'Typed while the work was being saved.'], 'what was typed during the switch reached the destination');

    const saved = readCheckpoint(h.root, h.gitDir);
    const final = saved.kind === 'found' ? saved.checkpoint : undefined;
    assert.deepEqual([final?.engine, final?.status, final?.transfer, final?.previousModel, final?.codexSession?.id], ['clarvis', 'running', undefined, 'ravis/clarvis-codex', session.id]);
    assert.deepEqual(
      final?.latestFeedback.map((note) => [note.text, note.delivered]),
      [
        ['Keep the --local flag too.', true],
        ['Typed while the work was being saved.', true],
        ['Also update the README.', false],
      ]
    );
    assert.deepEqual(outcome.kind === 'started' && outcome.lateFeedback, ['Also update the README.']);
    const row = h.locks.rowFor(h.root);
    assert.deepEqual([row?.holder.kind, row?.holder.window_id], ['clarvis_run', WINDOW.id]);
    const lockFile = readLockFile(lockFilePath(h.root, h.gitDir));
    assert.equal(lockFile.kind === 'present' && lockFile.content.holder.window_id, WINDOW.id, "RAVIS's file for the handed-over session was replaced by this window's");
    assert.equal((await codexRun.next(isDone)).text, CODEX_LINES.handedOver);
    if (facts.taken?.held) await facts.taken.lock.release();
  }));

test('something Codex left running puts the switch to the owner; cancelling keeps the locks, starts nothing, and the task is saved as a stop once it is gone', () =>
  withSwitch(async (h) => {
    const { session, source } = await codexTaskToSwitch(h);
    h.machine.leaveProcessesOnStop(session, [{ pid: 51310, comm: 'node', started_at: '2026-09-13T01:12:00Z' }]);
    const leftovers: string[] = [];
    let destinationUsed = false;
    const destination = new ClarvisDestination({
      model: 'ravis/clarvis-agent',
      workspaceRoot: h.root,
      gitDir: h.gitDir,
      take: async () => ((destinationUsed = true), { held: false, line: 'never' }),
      run: async () => ((destinationUsed = true), { ok: true, value: undefined }),
    });
    const engineSwitch = new EngineSwitch({ source, destination, prompts: confirmAll([], 'cancel', leftovers), host: 'desktop', sourceModel: 'ravis/clarvis-codex' });

    const outcome = await engineSwitch.run();

    assert.deepEqual(outcome, { kind: 'cancelled', line: SWITCH_LINES.cancelled });
    assert.match(leftovers[0] ?? '', /`node` \(pid 51310\)/);
    assert.equal(destinationUsed, false, 'a destination never starts beside a leftover');
    assert.equal(h.sent.some((line) => line.endsWith('/settle-claim') || line.endsWith('/release') || line === 'POST /api/v1/project-locks'), false);
    assert.deepEqual([h.locks.rowFor(h.root)?.holder.session_id, session.state], [session.id, 'leftover'], 'the lock stays with the session while something runs');

    h.machine.processesGone(session);
    await waitFor(() => session.settles.length === 1, 'the stopped task to be saved');
    assert.deepEqual(session.settles.map((settle) => settle.next), ['idle'], 'saved as an ordinary stop, never handed over');
    assert.equal(h.locks.rowFor(h.root), undefined, 'the lock went only with the settle, once everything was gone');
    assert.equal(destinationUsed, false);
  }));

// ── Clarvis's own engine → Codex ─────────────────────────────────────────────

interface ClarvisTask {
  lock: ProjectLock;
  lockId: string;
  base: TaskCheckpoint;
  mainHead: string;
  earlier: MachineSession;
  run: ClarvisRunHandle;
}

/**
 * A run of Clarvis's own engine on `clarvis/add-utc`: its own commit made, a command's output left uncommitted, the
 * owner's own notes in flight since before the task, a command recorded as running — and the task's Codex session
 * from an earlier switch, idle.
 */
async function clarvisTaskToSwitch(h: Harness): Promise<ClarvisTask> {
  const mainHead = git(h.root, 'rev-parse', 'HEAD');
  git(h.root, 'checkout', '--quiet', '-b', 'clarvis/add-utc');
  fs.writeFileSync(path.join(h.root, 'hello.py'), 'print("hello, UTC")\n');
  git(h.root, 'commit', '--quiet', '-am', "Clarvis's own commit");
  fs.writeFileSync(path.join(h.root, 'generated.txt'), 'left by a command\n');
  fs.writeFileSync(path.join(h.root, 'notes.md'), "the owner's\n");
  const taken = await takeProjectLock(h.lockDeps(WINDOW));
  if (!taken.held) throw new Error(taken.line);
  taken.lock.commandStarted(NPM);
  const earlier = h.machine.seed({ root: h.root, taskId: TASK_ID, state: 'idle', turnActive: false, holdsLock: false });
  h.tokens.save(h.root, earlier.id, earlier.token, TASK_ID);
  const base: TaskCheckpoint = {
    ...newCheckpoint({
      taskId: TASK_ID,
      workspaceRoot: h.root,
      host: 'desktop',
      engine: 'clarvis',
      task: TASK,
      now: new Date(),
      plan: { fromPlan: true, steps: ['Parse the arguments', 'Add the --utc flag'], uncheckedSteps: ['Add the --utc flag'] },
      git: { branch: 'clarvis/add-utc', baseBranch: 'main', baseCommit: mainHead, dirty: ['notes.md'] },
    }),
    codexSession: { id: earlier.id, threadId: 'thread-1', lastTurnStatus: 'completed', sawHeadCommit: mainHead, homeFingerprint: HOME },
  };
  let finish: () => void = () => undefined;
  const returned = new Promise<void>((resolve) => (finish = resolve));
  const run: ClarvisRunHandle = {
    stop: () => {
      h.sent.push("Clarvis's run stopped");
      setTimeout(finish, 5);
    },
    returned,
    drainInterjections: () => ['Typed while the run was stopping.'],
    pendingQuestion: () => 'Run `npm test` before committing?',
    interruptedOperation: () => ({ kind: 'command', summary: 'npm install left-pad', state: 'unknown' }),
    checksRun: () => [{ command: 'npm test', exitCode: 1, engine: 'clarvis', ranAt: new Date().toISOString(), outputTail: '1 failed' }],
    result: { files: ['hello.py'] },
    branches: { working: 'clarvis/add-utc' },
  };
  return { lock: taken.lock, lockId: h.locks.rowFor(h.root)?.id ?? '', base, mainHead, earlier, run };
}

function codexDestination(h: Harness, followed: { run?: Followed }): CodexDestination {
  return new CodexDestination({
    core: h.core(),
    relay: h.relay,
    git: new GitFacts(h.root),
    workspaceRoot: h.root,
    gitDir: h.gitDir,
    host: 'desktop',
    follow: (run) => void (followed.run = follow(run(new AbortController().signal))),
  });
}

test('Clarvis → Codex: the lock reserved, the run stopped and its command confirmed gone, its leftovers committed, the checkpoint written — then a catch-up turn on the idle session with the token, never a new session, and nothing uncertain repeated', () =>
  withSwitch(async (h) => {
    const task = await clarvisTaskToSwitch(h);
    const confirmations: string[] = [];
    const source = new ClarvisSource({
      lock: task.lock,
      run: task.run,
      git: new GitFacts(h.root),
      base: task.base,
      gitDir: h.gitDir,
      host: 'desktop',
      stopGroup: async (): Promise<GroupStop> => (h.sent.push('command group confirmed gone'), { gone: true, signalled: 1 }),
    });
    const save = source.saveCheckpoint.bind(source);
    source.saveCheckpoint = async (checkpoint) => {
      const written = await save(checkpoint);
      h.sent.push('checkpoint written');
      return written;
    };
    const handedOver = source.handedOver.bind(source);
    source.handedOver = () => {
      handedOver();
      h.sent.push('lock handed over');
    };
    const followed: { run?: Followed } = {};
    const engineSwitch = new EngineSwitch({ source, destination: codexDestination(h, followed), prompts: confirmAll(confirmations), host: 'desktop', sourceModel: 'claude-sonnet-4.5' });

    const outcome = await engineSwitch.run();

    assert.equal(outcome.kind, 'started', JSON.stringify(outcome));
    assert.deepEqual(confirmations, [switchConfirmLine('codex', 'ravis/clarvis-codex')]);
    assert.deepEqual(
      h.sent.filter((line) => /\/transfer$|run stopped|confirmed gone|checkpoint written|\/turns$|handed over|\/release$|^POST \/api\/v1\/agent-sessions$/.test(line)),
      [
        `POST /api/v1/project-locks/${task.lockId}/transfer`,
        "Clarvis's run stopped",
        'command group confirmed gone',
        'checkpoint written',
        `POST /api/v1/agent-sessions/${task.earlier.id}/turns`,
        'lock handed over',
      ],
      'reserved, stopped, confirmed, saved, started — and no release or new session anywhere'
    );
    assert.equal(h.sent.some((line) => line.startsWith('DELETE')), false, 'the idle session was reused, never ended or archived');

    const head = git(h.root, 'rev-parse', 'HEAD');
    assert.match(git(h.root, 'log', '-1', '--format=%s'), /^Clarvis's work on .* \(stopped for a switch\)$/);
    assert.equal(git(h.root, 'status', '--porcelain'), '?? notes.md', "the command's output committed; the owner's own notes left alone");
    assert.deepEqual(h.git.continued, [['clarvis/add-utc', head]], 'Codex continues on the task branch, at the commit just saved');
    assert.equal(await new GitFacts(h.root).isAncestor(task.mainHead, head), true, 'the base is still main');

    assert.deepEqual(task.earlier.turns.map((turn) => turn.kind), ['catch_up']);
    const turnBody = h.fake.seen.find((request) => request.path.endsWith('/turns'))?.body as { lock?: { transfer_token?: string }; text: string };
    assert.match(turnBody.lock?.transfer_token ?? '', /^FIXTURE-transfer-token-/, 'the lock taken with the transfer token');
    const text = task.earlier.turns[0].text;
    assert.match(text, /^While you were stopped, another engine worked on this project\. Changes since commit/);
    assert.match(text, /Not done and uncertain: command: npm install left-pad \(may or may not have happened\) — check before repeating\./);
    assert.equal(text.split('npm install left-pad').length - 1, 1, 'named once, as something to check — never as something to do');
    assert.match(text, /Open questions: Run `npm test` before committing\?\./);
    assert.match(text, /What the user said meanwhile: Typed while the run was stopping\./);

    const saved = readCheckpoint(h.root, h.gitDir);
    const final = saved.kind === 'found' ? saved.checkpoint : undefined;
    assert.deepEqual([final?.engine, final?.status, final?.transfer, final?.previousModel, final?.git.headCommit], ['codex', 'running', undefined, 'claude-sonnet-4.5', head]);
    assert.deepEqual(final?.latestFeedback.map((note) => note.delivered), [true]);
    assert.deepEqual(final?.uncertainOperations, [{ kind: 'command', summary: 'npm install left-pad', state: 'unknown' }]);
    assert.equal(fs.existsSync(lockFilePath(h.root, h.gitDir)), false, "the window's lock file is dropped; RAVIS holds the project for Codex");
    assert.equal(h.locks.rowFor(h.root)?.holder.session_id, task.earlier.id);
    await followed.run?.next((event) => event.kind === 'text' || event.kind === 'done').catch(() => undefined);
  }));

test('Codex takes a task back on a new session resuming its thread when the Codex home matches, and from a fresh brief when it does not — taking the lock with the token either way', async () => {
  for (const [home, kind] of [
    [HOME, 'resume'],
    ['sha256:another-codex-home', 'brief'],
  ] as const) {
    await withSwitch(async (h) => {
      const task = await clarvisTaskToSwitch(h);
      const reserved = await task.lock.transfer('codex_session');
      if (!reserved.ok) throw new Error(reserved.line);
      const head = git(h.root, 'rev-parse', 'HEAD');
      const checkpoint: TaskCheckpoint = {
        ...task.base,
        git: { ...task.base.git, headCommit: head },
        codexSession: { id: 'as_ENDEDLONGAGO', threadId: 'thread-9', lastTurnStatus: 'completed', sawHeadCommit: task.mainHead, homeFingerprint: home },
      };
      const followed: { run?: Followed } = {};

      const started = await within(codexDestination(h, followed).start(checkpoint, reserved.token), 'Codex to start');

      assert.deepEqual(started, { ok: true, value: undefined }, kind);
      const create = h.fake.seen.find((request) => request.method === 'POST' && request.path === '/api/v1/agent-sessions')?.body as {
        start: { kind: string; thread_id?: string; catch_up_text?: string; text?: string };
        lock: { transfer_token: string };
        clarvis_task_id: string;
        branch: { name: string };
      };
      assert.deepEqual([create.start.kind, create.lock.transfer_token, create.clarvis_task_id, create.branch.name], [kind, reserved.token, TASK_ID, 'clarvis/add-utc']);
      if (kind === 'resume') {
        assert.equal(create.start.thread_id, 'thread-9');
        assert.match(create.start.catch_up_text ?? '', /^While you were stopped, another engine worked on this project\./);
      } else {
        assert.match(create.start.text ?? '', /^Build milestone 2[\s\S]*You are carrying on a task that Clarvis's own engine started/);
      }
      task.lock.handOver();
    });
  }
});

test('a switch that fails after the stop — here the transfer token ran out — releases nothing on its own, and lets the lock go only once the command is confirmed gone', () =>
  withSwitch(async (h) => {
    const task = await clarvisTaskToSwitch(h);
    let groupChecks = 0;
    const source = new ClarvisSource({
      lock: task.lock,
      run: task.run,
      git: new GitFacts(h.root),
      base: task.base,
      gitDir: h.gitDir,
      host: 'desktop',
      pollMs: 5,
      stopGroup: async (): Promise<GroupStop> => {
        groupChecks++;
        if (groupChecks === 2) {
          h.sent.push('its command still running');
          return { gone: false, survivors: [{ pid: 48211, comm: 'node', start: NPM.start }] };
        }
        h.sent.push('command group confirmed gone');
        return { gone: true, signalled: 1 };
      },
    });
    const save = source.saveCheckpoint.bind(source);
    source.saveCheckpoint = async (checkpoint) => {
      const written = await save(checkpoint);
      h.locks.expireTransfer(h.root); // fifteen minutes pass
      return written;
    };
    const engineSwitch = new EngineSwitch({ source, destination: codexDestination(h, {}), prompts: confirmAll([]), host: 'desktop', sourceModel: 'claude-sonnet-4.5' });

    const outcome = await engineSwitch.run();

    assert.deepEqual(outcome, { kind: 'failed', step: 'starting', line: CODEX_LINES.transferExpired });
    assert.deepEqual(task.earlier.turns, [], 'Codex started nothing');
    assert.equal(h.locks.rowFor(h.root)?.holder.window_id, WINDOW.id, 'the expired token released nothing: the project is still this window’s');
    await source.releasing;
    const releases = h.sent.filter((line) => line.endsWith('/release'));
    assert.equal(releases.length, 1);
    const order = h.sent.filter((line) => /still running|confirmed gone|\/release$/.test(line));
    assert.deepEqual(order.slice(-3), ['its command still running', 'command group confirmed gone', `POST /api/v1/project-locks/${task.lockId}/release`], 'released only after confirmation');
    assert.equal(h.locks.rowFor(h.root), undefined);
  }));

test('a branch that no longer holds the saved work refuses the continuation: Codex starts nothing, and the switch fails with the reason', () =>
  withSwitch(async (h) => {
    const task = await clarvisTaskToSwitch(h);
    h.git.refuseContinuation = '`clarvis/add-utc` no longer contains the saved work (commit 9a8b7c6), so nothing was continued. Look at the branch, then switch again.';
    const source = new ClarvisSource({ lock: task.lock, run: task.run, git: new GitFacts(h.root), base: task.base, gitDir: h.gitDir, host: 'desktop', pollMs: 5 });
    const engineSwitch = new EngineSwitch({ source, destination: codexDestination(h, {}), prompts: confirmAll([]), host: 'desktop', sourceModel: 'claude-sonnet-4.5' });

    const outcome = await engineSwitch.run();

    assert.deepEqual(outcome, { kind: 'failed', step: 'starting', line: h.git.refuseContinuation });
    assert.equal(h.sent.some((line) => line.endsWith('/turns') || line === 'POST /api/v1/agent-sessions'), false, 'no turn and no session on a branch beside the work');
    await source.releasing;
  }));
