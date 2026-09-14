import assert from 'node:assert/strict';
import * as fs from 'fs';
import { test } from 'node:test';
import * as os from 'os';
import * as path from 'path';
import type { AgentEvent } from '../../agent/AgentRunner';
import { matchStep, readStepMarkers } from '../../agent/stepProgress';
import { CLARVIS_CREDENTIAL, FakeRavisRelay, FIXTURE_LOCK } from '../../test/fakes/FakeRavisRelay';
import type { FakeSessions, MachineSession } from '../../test/fakes/fakeSessions';
import { errorAnswer } from '../../test/fakes/fakeAnswers';
import { ALLOW_SITES_ROUTE, CODEX_STATE_ROUTE, exampleNamed } from '../../test/fakes/relayContract';
import { encodeLockFile, lockFilePath, readLockFile, type LockFileContent } from '../lock/fileLock';
import { LockClient } from '../lock/lockClient';
import type { Verdict } from '../lock/lockRule';
import { takeProjectLock } from '../lock/projectLock';
import { createSessionKey, freshKey } from '../relay/idempotency';
import { RelayClient } from '../relay/relayClient';
import { RelayHttp, relayEndpoint } from '../relay/relayHttp';
import type { CodexState, CreateSessionBody, RunningCommand, SessionMode, SessionSummary } from '../relay/relayTypes';
import { K1_FILE_CHANGE, K2_COMMANDS, K11_FOR_THE_SESSION } from '../../test/fakes/calibrationRequests';
import { TokenStore } from '../relay/tokenStore';
import {
  CodexRunCore,
  type CodexBranch,
  type CodexCursors,
  type CodexGit,
  type CodexLockFloor,
  type CodexRunOptions,
  type CodexSave,
} from './runCore';
import type { PromptShower, RequestPrompt } from './approvals';
import { SITE_LINES } from './siteAsks';
import { CODEX_LINES } from './translate';

/**
 * The remote Codex runner against `FakeRavisRelay` and its session state machine: a whole task, Stop,
 * steering, reattaching, two windows, presence and the failure states. Every test ends by asserting that
 * each request the runner sent and each answer and frame the fake gave matched RAVIS's contract fixtures.
 *
 * The guards these tests exist for, in the order a person would notice them missing: a question that
 * stays on screen after Stop; a click after Stop that runs a command anyway; words typed to Codex that
 * vanish; a progress bar that never moves; a file listed twice or committed by two windows; and a
 * reopened window that asks the same question twice.
 */

const ROOT = '/Users/owner/Documents/coding/add-utc-demo';
const WINDOW_A = { id: 'win-desktop-1c9e4d', host: 'desktop' as const };
const WINDOW_B = { id: 'win-code-server-7f3a2b', host: 'code-server' as const };
const TASK = 'Build milestone 2 of plan.md. Before each step, print STEP: <the step, copied from the plan>.';
const HEAD = '3f9c2e1d8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e';
const COMMIT = '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b';
const FAST = {
  streamBackoffMs: [20, 40, 80],
  silenceLimitMs: 5_000,
  retry: { attempts: 2, delayMs: 10 },
  interruptRetry: { attempts: 3, delayMs: 10 },
  interruptKeepTryingMs: 20,
};

/** Git as the runner sees it: records what it was asked to do, and commits only when there are files. */
class FakeGit implements CodexGit {
  readonly begun: string[] = [];
  readonly saves: { summary: string; stopped: boolean; files: string[] }[] = [];
  /** The branch each save was told the session is on. */
  readonly branches: (string | undefined)[] = [];
  /** Branches continued for a switch into Codex, and the commit each was continued at. */
  readonly continued: [string, string][] = [];
  /** The line `continueOn` refuses with, when a test sets one. */
  refuseContinuation: string | undefined;
  readonly forSwitch: boolean[] = [];
  abandoned = 0;

  async begin(task: string): Promise<CodexBranch> {
    this.begun.push(task);
    return { ok: true, branch: 'clarvis/add-utc', headCommit: HEAD };
  }

  async continueOn(branch: string, headCommit: string): Promise<CodexBranch> {
    this.continued.push([branch, headCommit]);
    return this.refuseContinuation ? { ok: false, line: this.refuseContinuation } : { ok: true, branch, headCommit };
  }

  async save(work: { summary: string; stopped: boolean; files: string[]; branch: string | undefined; forSwitch?: boolean }): Promise<CodexSave> {
    this.forSwitch.push(work.forSwitch === true);
    this.saves.push({ summary: work.summary, stopped: work.stopped, files: work.files });
    this.branches.push(work.branch);
    const committed = work.files.length > 0;
    return { ok: true, commit: committed ? COMMIT : HEAD, committed, files: work.files };
  }

  async abandon(): Promise<void> {
    this.abandoned++;
  }
}

interface Harness {
  fake: FakeRavisRelay;
  machine: FakeSessions;
  git: FakeGit;
  tokens: TokenStore;
  cursors: Map<string, number>;
  /** Each request the runner started, in order, as `METHOD /path` — and any markers a test adds. */
  sent: string[];
  /** The recording HTTP the runner uses, for a lock client whose requests belong in `sent` too. */
  http: RelayHttp;
  core(options?: Partial<CodexRunOptions>): CodexRunCore;
}

function mapCursors(map: Map<string, number>): CodexCursors {
  return { get: (id) => map.get(id) ?? null, set: (id, value) => void map.set(id, value) };
}

/** The runner's HTTP, recording each request as it is started — synchronously, before any answer. */
function recordingHttp(fake: FakeRavisRelay, sent: string[]): RelayHttp {
  const endpoint = relayEndpoint(fake.url, CLARVIS_CREDENTIAL);
  if (!endpoint.ok) throw new Error(endpoint.reason);
  return new RelayHttp(endpoint.endpoint, (input, init) => {
    sent.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
    return fetch(input, init);
  });
}

async function withCodex(run: (h: Harness) => Promise<void>): Promise<void> {
  const fake = await FakeRavisRelay.start();
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-codex-run-'));
  const cores: CodexRunCore[] = [];
  const sent: string[] = [];
  const cursors = new Map<string, number>();
  const git = new FakeGit();
  const tokens = new TokenStore(folder);
  const http = recordingHttp(fake, sent);
  const relay = new RelayClient(http);
  const core = (options: Partial<CodexRunOptions> = {}) => {
    const made = new CodexRunCore({
      relay,
      tokens,
      cursors: mapCursors(cursors),
      git,
      window: WINDOW_A,
      workspace: { root: ROOT, gitDir: `${ROOT}/.git` },
      mode: 'agent',
      maxSteps: 25,
      ask: async () => undefined,
      timing: FAST,
      ...options,
    });
    cores.push(made);
    return made;
  };
  try {
    await run({ fake, machine: fake.sessions(), git, tokens, cursors, sent, http, core });
    assert.deepEqual(fake.violations, [], 'every request, answer and frame matched the contract fixtures');
  } finally {
    for (const made of cores) made.dispose();
    await fake.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

interface Followed {
  events: AgentEvent[];
  /** Resolves once the run has ended, and fails the test when it hasn't within the time. */
  ended(timeoutMs?: number): Promise<void>;
  /** The first event matching, waiting for it if it hasn't come yet. */
  next(match: (event: AgentEvent) => boolean, timeoutMs?: number): Promise<AgentEvent>;
}

/**
 * Reads a run in the background, as `RunSession` does, keeping every event. Every wait is bounded, so a
 * run that never ends fails its test instead of hanging the suite.
 */
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
    ended: (timeoutMs = 5_000) => waitFor(() => over, 'the run to end', timeoutMs),
    async next(match, timeoutMs = 5_000) {
      await waitFor(() => over || seen.some(match), 'an event', timeoutMs);
      const found = seen.find(match);
      if (!found) throw new Error(`the run ended first; it said ${JSON.stringify(seen)}`);
      return found;
    },
  };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const isDone = (event: AgentEvent) => event.kind === 'done';
const chat = (followed: Followed) => followed.events.filter((event) => event.toChat).map((event) => event.text);
const message = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: null });
const fileChange = (id: string, ...changes: [string, string][]) => ({
  type: 'fileChange',
  id,
  status: 'completed',
  changes: changes.map(([file, change]) => ({ path: file, change, added: 1, removed: 0 })),
});

function summaryOf(session: MachineSession): SessionSummary {
  return {
    id: session.id,
    state: session.state,
    clarvis_task_id: session.taskId,
    created_at: '2026-09-13T01:12:00Z',
    updated_at: '2026-09-13T01:54:00Z',
    waiting_on_you: session.open.size > 0,
    attached_windows: 0,
  };
}

function keepToken(h: Harness, session: MachineSession): void {
  h.tokens.save(ROOT, session.id, session.token, session.taskId);
}

interface Asked {
  prompt: RequestPrompt;
  signal: AbortSignal;
  /** Shown again after typed words that weren't an answer. */
  again: boolean;
  /** The owner's reply: a button's label, typed words, or nothing. */
  answer(reply: string | undefined): void;
}

/** An asker that holds each prompt until the test answers it, noting in `sent` when one is let go. */
function holdingAsker(sent?: string[]): { ask: PromptShower; asked: Asked[] } {
  const asked: Asked[] = [];
  const ask: PromptShower = (prompt, signal, again) =>
    new Promise((resolve) => {
      signal.addEventListener('abort', () => sent?.push('question let go'));
      asked.push({ prompt, signal, again, answer: resolve });
    });
  return { ask, asked };
}

async function started(h: Harness, core: CodexRunCore = h.core()) {
  const controller = new AbortController();
  const run = follow(core.start(TASK, controller.signal));
  await waitFor(() => h.machine.all.length === 1 && core.isConnected, 'the task to be created and followed');
  return { run, controller, core, session: h.machine.all[0] };
}

// ── Starting ─────────────────────────────────────────────────────────────────

test('a start is refused, with the reason, before any branch or session exists when Codex may not run', () =>
  withCodex(async (h) => {
    const signedIn = exampleNamed(CODEX_STATE_ROUTE, 'signed in, three projects busy, read by a named caller').response.body as CodexState;
    const unproven = { ...signedIn, runtime: { ...signedIn.runtime, strict_rules: 'unproven' } };
    const cases: [string | { status: number; body: unknown }, RegExp][] = [
      ['allowance used up', /^Codex can't start\. The ChatGPT plan's allowance is used up until 04:30\.$/],
      ['signed out', /^Codex can't start\. Codex is signed out/],
      ['paused for re-testing: the installed binary is neither tested nor accepted', /Codex changed \(now 0\.155\.0\)/],
      [{ status: 200, body: unproven }, /Re-test the file rules/],
    ];

    for (const [answer, expected] of cases) {
      h.fake.reply(CODEX_STATE_ROUTE, answer);
      const core = h.core();
      const run = follow(core.start(TASK, new AbortController().signal));
      await run.ended();
      assert.equal(run.events.length, 1, JSON.stringify(run.events));
      assert.equal(run.events[0].kind, 'done');
      assert.match(run.events[0].text, expected);
      assert.equal(core.blocked, true);
    }
    assert.deepEqual(h.git.begun, [], 'no branch was made');
    assert.equal(h.machine.all.length, 0, 'no session was created');
  }));

test("RAVIS not answering refuses the start as RAVIS being down, and says Clarvis's own engine still works", () =>
  withCodex(async (h) => {
    await h.fake.stopListening();
    const run = follow(h.core().start(TASK, new AbortController().signal));
    await run.ended();

    assert.deepEqual(run.events.map((event) => event.text), [CODEX_LINES.ravisDownAtStart]);
    assert.deepEqual(h.git.begun, []);
  }));

test('a start refused because Codex already holds the project tidies its new branch and names the session to follow', () =>
  withCodex(async (h) => {
    const refusal = structuredClone(
      exampleNamed('POST /api/v1/agent-sessions', "Clarvis's own engine holds the project").response.body
    ) as { error: { message: string; details: { lock: { holder: Record<string, unknown> } } } };
    refusal.error.message = 'Codex is already working on this project.';
    refusal.error.details.lock.holder = {
      ...refusal.error.details.lock.holder,
      kind: 'codex_session',
      session_id: 'as_01J9ZK4T6Q8M2V7R3N5B1C0D',
      window_id: null,
      host: 'ravis',
    };
    h.fake.reply('POST /api/v1/agent-sessions', { status: 409, body: refusal });
    const core = h.core();

    const run = follow(core.start(TASK, new AbortController().signal));
    await run.ended();

    assert.deepEqual(run.events.map((event) => event.text), ['Codex is already working on this project.']);
    assert.equal(h.git.abandoned, 1, 'the branch made for it is tidied');
    assert.equal(core.attachInstead, 'as_01J9ZK4T6Q8M2V7R3N5B1C0D');
  }));

test('a task runs to its settle: the contract’s create, STEP lines that move the progress bar, each file recorded once', () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);

    const create = h.fake.seen.find((request) => request.method === 'POST' && request.path === '/api/v1/agent-sessions');
    const body = create?.body as CreateSessionBody;
    assert.deepEqual(
      { root: body.workspace_root, gitDir: body.git_dir, window: body.window, branch: body.branch, start: body.start, lock: body.lock, limits: body.limits },
      {
        root: ROOT,
        gitDir: `${ROOT}/.git`,
        window: WINDOW_A,
        branch: { name: 'clarvis/add-utc', head_commit: HEAD },
        start: { kind: 'brief', text: TASK },
        lock: { transfer_token: null },
        limits: { max_steps: 25 },
      }
    );
    assert.equal(create?.headers['idempotency-key'], createSessionKey(body.clarvis_task_id, WINDOW_A.id, 1));
    const kept = h.tokens.read(ROOT, session.id);
    assert.equal(kept.kind === 'found' && kept.entry.token, session.token, 'the token is in the token file for other windows');
    assert.equal(session.stream.connects[0].windowId, WINDOW_A.id);

    // The planning handoff: Codex prints STEP lines, and RunSession matches them against the plan's steps.
    h.machine.completeItem(session, message('msg_1', 'STEP: 2. Add the --utc flag'));
    const announced = await run.next((event) => event.kind === 'text' && event.text.includes('STEP:'));
    const steps = ['Parse the arguments', 'Add the --utc flag'];
    assert.deepEqual(readStepMarkers(announced.text).announced.map((step) => matchStep(step, steps)), [1]);

    const change = fileChange('call_fc_1', ['hello.py', 'add']);
    h.machine.completeItem(session, change);
    h.machine.completeItem(session, change); // RAVIS sending the same item again
    h.machine.completeItem(session, message('msg_2', 'Added the flag. Checks: 3 passed.'));
    await run.next((event) => event.text === 'Added the flag. Checks: 3 passed.\n');
    h.machine.completeTurn(session);
    const done = await run.next(isDone);

    assert.equal(run.events.filter((event) => event.detail === 'writeFile: hello.py').length, 1, 'one chat line for the file');
    assert.deepEqual(h.git.saves, [{ summary: 'Added the flag. Checks: 3 passed.', stopped: false, files: ['hello.py'] }]);
    assert.deepEqual(session.settles, [{ claim_id: session.settles[0]?.claim_id, commit: COMMIT, next: 'idle' }]);
    assert.deepEqual([done.text, done.files], ['Added the flag. Checks: 3 passed.', ['hello.py']]);
    assert.deepEqual(core.result, { commits: [COMMIT], files: ['hello.py'] });
    assert.equal(core.blocked, false);
  }));

// ── Stop ─────────────────────────────────────────────────────────────────────

test('Stop lets go of the question before any request is made, then interrupts; a late "once" is never sent', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker(h.sent);
    const { run, controller, session } = await started(h, h.core({ ask }));
    h.machine.openRequest(session, 'command');
    await waitFor(() => asked.length === 1, 'the question to be asked');
    const before = h.sent.length;

    controller.abort();

    assert.equal(asked[0].signal.aborted, true, 'let go in the same tick as Stop');
    assert.deepEqual(h.sent.slice(before), ['question let go', `POST /api/v1/agent-sessions/${session.id}/interrupt`], 'let go first, then RAVIS is told');

    asked[0].answer('Run it'); // the click that raced the stop
    const done = await run.next(isDone);

    assert.equal(done.text, CODEX_LINES.stopped);
    assert.ok(chat(run).includes(CODEX_LINES.stopping));
    assert.equal(h.sent.some((line) => line.endsWith('/answer')), false, 'the late answer was never even sent');
    assert.deepEqual(session.answers, []);
    assert.deepEqual(h.git.saves.map((save) => save.stopped), [true], "the stopped task's work is saved once");
  }));

test('an owner Stop from the dashboard lets go of the question, says where it came from, and settles; a late answer is dropped', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    h.machine.openRequest(session, 'command');
    await waitFor(() => asked.length === 1, 'the question to be asked');

    h.machine.ownerStop(session, 'dashboard');
    await waitFor(() => asked[0].signal.aborted, 'the question to be let go');
    asked[0].answer('Run it');
    const done = await run.next(isDone);

    assert.ok(chat(run).includes('Stopped from the dashboard.'), chat(run).join(' | '));
    assert.equal(session.interrupts, 0, 'this window sent no interrupt of its own');
    assert.equal(h.sent.some((line) => line.endsWith('/answer')), false);
    assert.equal(session.settles.length, 1);
    assert.equal(done.text, CODEX_LINES.stopped);
  }));

test('processes a stop left behind hold the save back until they are gone', () =>
  withCodex(async (h) => {
    const { run, controller, session } = await started(h);
    h.machine.leaveProcessesOnStop(session, [{ pid: 51310, comm: 'node', started_at: '2026-09-13T01:12:00Z' }]);

    controller.abort();
    await run.next((event) => event.text.includes('pid 51310'));
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.deepEqual(session.claimsBy, [], 'no claim while something Codex started still runs');
    assert.deepEqual(h.git.saves, []);
    h.machine.processesGone(session);
    await run.next(isDone);
    assert.equal(h.git.saves.length, 1);
  }));

test('Stop with RAVIS unreachable says so, frees the chat, and keeps trying until RAVIS takes it', () =>
  withCodex(async (h) => {
    const { run, controller, session } = await started(h);
    await h.fake.stopListening();

    controller.abort();
    const done = await run.next(isDone);
    assert.equal(done.text, CODEX_LINES.stopUnreachable);

    await h.fake.listenAgain();
    await waitFor(() => session.interrupts === 1, 'the retried stop to reach RAVIS');
  }));

// ── Steering ─────────────────────────────────────────────────────────────────

test('typed text is steered into the running turn with its turn id and its own key, and "Passed to Codex" follows', () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);
    await waitFor(() => core.activeTurnId === session.activeTurn, 'the turn to be known');

    core.interject('Use datetime.timezone.utc, not pytz.');
    await waitFor(() => session.steers.length === 1, 'the steer');

    assert.deepEqual(session.steers[0], { text: 'Use datetime.timezone.utc, not pytz.', expectedTurnId: session.activeTurn, delivered: 'steered' });
    const steer = h.fake.seen.find((request) => request.path.endsWith('/steer'));
    assert.match(String(steer?.headers['idempotency-key']), /^[0-9a-f-]{36}$/);
    await run.next((event) => event.text === CODEX_LINES.passedOn);
    assert.deepEqual(core.drainInterjections(), [], 'nothing is left waiting');
  }));

test('a steer that races the end of the turn is queued by RAVIS for the next one', () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);
    await waitFor(() => core.activeTurnId === session.activeTurn, 'the turn to be known');
    session.activeTurn = null; // the turn ended just as the text was typed

    core.interject('Also update the README.');
    await waitFor(() => session.steers.length === 1, 'the steer');

    assert.equal(session.steers[0].delivered, 'queued');
    await run.next((event) => event.text === CODEX_LINES.queued);
  }));

test('text typed while the task is stopping is kept, never sent, and handed back by drainInterjections', () =>
  withCodex(async (h) => {
    const { run, controller, session, core } = await started(h);

    controller.abort();
    core.interject('Actually, keep the old flag too.');
    await run.next(isDone);

    assert.deepEqual(session.steers, []);
    assert.ok(chat(run).includes(CODEX_LINES.keptForLater));
    assert.deepEqual(core.drainInterjections(), ['Actually, keep the old flag too.']);
  }));

test('a steer refused with PROJECT_LOCKED says why and keeps the text for later', () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);
    await waitFor(() => core.activeTurnId === session.activeTurn, 'the turn to be known');
    session.activeTurn = null;
    session.holdsLock = false; // Clarvis's own engine took the project
    h.machine.holdRootForClarvis(ROOT);

    core.interject('Rename the flag to --utc-time.');
    await run.next((event) => event.text === CODEX_LINES.lockedForTurns);

    assert.deepEqual(core.drainInterjections(), ['Rename the flag to --utc-time.']);
  }));

test('text typed while RAVIS is unreachable is kept, then steered in once the stream is back', () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);
    await waitFor(() => core.activeTurnId === session.activeTurn, 'the turn to be known');
    await h.fake.stopListening();
    await waitFor(() => !core.isConnected, 'the stream to notice');

    core.interject('Use the other library.');
    assert.equal(session.steers.length, 0, 'nothing reaches RAVIS while it is away');
    await h.fake.listenAgain();

    await waitFor(() => session.steers.length === 1, 'the kept text to be steered in', 8_000);
    assert.equal(session.steers[0].text, 'Use the other library.');
    await run.next((event) => event.text === CODEX_LINES.passedOn);
    assert.ok(chat(run).includes(CODEX_LINES.keptForLater));
    assert.deepEqual(core.drainInterjections(), []);
  }));

test('a new turn refused with PROJECT_LOCKED says why and keeps its text; accepted later, it carries what waited first', () =>
  withCodex(async (h) => {
    const session = h.machine.seed({ state: 'idle', turnActive: false, holdsLock: false });
    h.machine.holdRootForClarvis(ROOT); // left idle by a switch; Clarvis's own engine holds the project
    keepToken(h, session);
    const core = h.core();
    await follow(core.attach(summaryOf(session), new AbortController().signal)).ended();

    assert.equal(await core.continueTurn('Carry on with milestone 2.', 'continue'), CODEX_LINES.lockedForTurns);
    assert.equal(session.turns.length, 0, 'no turn started');
    assert.deepEqual(core.feedback.pending, ['Carry on with milestone 2.']);

    h.machine.releaseRootFromClarvis(ROOT); // Clarvis's own engine let the project go: the turn takes it
    assert.equal(await core.continueTurn('Carry on.', 'continue'), undefined);
    assert.equal(session.turns.length, 1);
    assert.match(session.turns[0].text, /- Carry on with milestone 2\.\n\nCarry on\.$/);
    assert.deepEqual(core.feedback.pending, []);
  }));

// ── Reattaching and windows ──────────────────────────────────────────────────

test('a second window reattaches from its stored cursor and a third from a snapshot; each asks the waiting question once', () =>
  withCodex(async (h) => {
    const session = h.machine.seed();
    keepToken(h, session);
    const cursorBefore = session.stream.latestId;
    const request = h.machine.openRequest(session, 'command');
    const windowC = { id: 'win-desktop-2b8c1f', host: 'desktop' as const };
    const askedB: string[] = [];
    const askedC: string[] = [];
    // Each asker comes back at once with no answer, as a question taken off the panel does. The slot is then
    // free, so a replayed request would be asked a second time if the window didn't remember it.
    const noAnswer =
      (asked: string[]): PromptShower =>
      async (prompt) => {
        asked.push(prompt.requestId);
        return undefined;
      };
    const b = h.core({ window: WINDOW_B, ask: noAnswer(askedB), cursors: mapCursors(new Map([[session.id, cursorBefore]])) });
    const c = h.core({ window: windowC, ask: noAnswer(askedC), cursors: mapCursors(new Map()) });

    const runB = follow(b.attach(summaryOf(session), new AbortController().signal));
    const runC = follow(c.attach(summaryOf(session), new AbortController().signal));
    await waitFor(() => askedB.length === 1 && askedC.length === 1, 'both windows to ask');

    // RAVIS sends the request again, and both connections drop and resume.
    h.machine.resendRequest(session, request);
    session.stream.disconnect();
    await waitFor(() => session.stream.connects.length >= 4 && b.isConnected && c.isConnected, 'both to reconnect');
    h.machine.completeItem(session, message('msg_after', 'Still working.'));
    await runB.next((event) => event.text === 'Still working.\n');
    await runC.next((event) => event.text === 'Still working.\n');

    assert.deepEqual([askedB, askedC], [[request.id], [request.id]], 'asked once each');
    const byWindow = (id: string) => session.stream.connects.filter((connect) => connect.windowId === id);
    assert.equal(byWindow(WINDOW_B.id)[0].lastEventId, String(cursorBefore), 'B resumed from its stored cursor');
    assert.deepEqual([byWindow(windowC.id)[0].lastEventId, byWindow(windowC.id)[0].after], [undefined, null], 'C came in on a snapshot');
    assert.ok(Number(byWindow(WINDOW_B.id)[1].lastEventId) > cursorBefore, 'and resumed after what it had seen');
    assert.equal(runB.events.filter((event) => event.text === 'Still working.\n').length, 1, 'nothing arrived twice');
    assert.match(runB.events[0].text, /Codex is still working on this project \(started \d\d:\d\d; a question is waiting\)\. Reconnected\./);
  }));

test('two windows: the first answer wins, the other window’s question goes away, and only one of them commits', () =>
  withCodex(async (h) => {
    const session = h.machine.seed();
    keepToken(h, session);
    const a = holdingAsker();
    const b = holdingAsker();
    const coreA = h.core({ ask: a.ask, cursors: mapCursors(new Map()) });
    const coreB = h.core({ window: WINDOW_B, ask: b.ask, cursors: mapCursors(new Map()) });
    const runA = follow(coreA.attach(summaryOf(session), new AbortController().signal));
    const runB = follow(coreB.attach(summaryOf(session), new AbortController().signal));
    await waitFor(() => coreA.isConnected && coreB.isConnected, 'both windows to follow');

    const request = h.machine.openRequest(session, 'command');
    await waitFor(() => a.asked.length === 1 && b.asked.length === 1, 'both windows to ask');
    a.asked[0].answer('Run it');
    await waitFor(() => b.asked[0].signal.aborted, "B's question to go once A answered");
    b.asked[0].answer('Run it'); // too late

    h.machine.completeItem(session, fileChange('call_fc_1', ['hello.py', 'add']));
    h.machine.completeTurn(session);
    const [doneA, doneB] = await Promise.all([runA.next(isDone), runB.next(isDone)]);

    assert.deepEqual(session.answers.map((answer) => [answer.requestId, answer.key]), [[request.id, `${request.id}:${WINDOW_A.id}`]]);
    assert.ok(chat(runB).includes('Answered in the other editor.'));
    assert.equal(h.git.saves.length, 1, 'one window committed');
    assert.equal(session.settles.length, 1);
    const saved = [doneA, doneB].filter((done) => done.text !== CODEX_LINES.savedElsewhere);
    assert.deepEqual(saved.map((done) => done.files), [['hello.py']]);
    assert.deepEqual(
      [doneA, doneB].filter((done) => done.text === CODEX_LINES.savedElsewhere).map((done) => done.files),
      [[]],
      'the other has nothing to review'
    );
  }));

test('a task that finished while no window was open is settled by the next window that attaches, from its replay', () =>
  withCodex(async (h) => {
    const session = h.machine.seed();
    keepToken(h, session);
    const cursor = session.stream.latestId;
    h.machine.completeItem(session, fileChange('call_fc_1', ['hello.py', 'add']));
    h.machine.completeItem(session, message('msg_1', 'Done: added --utc.'));
    h.machine.completeTurn(session);

    const core = h.core({ cursors: mapCursors(new Map([[session.id, cursor]])) });
    const done = await follow(core.attach(summaryOf(session), new AbortController().signal)).next(isDone);

    assert.deepEqual(h.git.saves, [{ summary: 'Done: added --utc.', stopped: false, files: ['hello.py'] }]);
    assert.deepEqual(h.git.branches, ['clarvis/add-utc'], 'resumed from a cursor, the branch is read from RAVIS before saving');
    assert.equal(session.settles.length, 1);
    assert.deepEqual([done.text, done.files], ['Done: added --utc.', ['hello.py']]);
  }));

test('a panel whose pings stop is posted detached with its stream closed; when they resume, attached at once and reopened from its cursor', () =>
  withCodex(async (h) => {
    const t0 = Date.parse('2026-09-13T02:00:00Z');
    const session = h.machine.seed();
    keepToken(h, session);
    const core = h.core({ now: () => new Date(t0) });
    const run = follow(core.attach(summaryOf(session), new AbortController().signal));
    await waitFor(() => core.isConnected && session.presence.length === 1, 'attached');
    assert.deepEqual(session.presence[0], { window_id: WINDOW_A.id, host: 'desktop', panel_connected: true });
    h.machine.completeItem(session, message('m1', 'one'));
    await run.next((event) => event.text === 'one\n');
    const cursor = h.cursors.get(session.id);

    core.presenceTick(t0 + 25_000); // no ping for 25 s: the tab was closed
    await waitFor(() => session.presence.length === 2 && session.stream.connections === 0, 'detached');
    assert.equal(session.presence[1].panel_connected, false);
    assert.equal(core.isAttached, false);
    assert.equal(core.isFinished, false, 'closing the stream never stops the task');

    core.panelPinged(t0 + 40_000); // the tab is back, same extension host
    await waitFor(() => session.presence.length === 3 && session.stream.connections === 1, 'attached again');
    assert.equal(session.presence[2].panel_connected, true);
    assert.equal(session.stream.connects.at(-1)?.lastEventId, String(cursor));
  }));

test('a gap in the stream is recovered from a snapshot: the waiting question is asked once, and the stream carries on', () =>
  withCodex(async (h) => {
    const session = h.machine.seed();
    keepToken(h, session);
    for (let emitted = 0; emitted < 5; emitted++) session.stream.emitExample('usage.updated');
    const request = h.machine.openRequest(session, 'question');
    session.stream.expireBefore(session.stream.latestId - 1);
    const asked: string[] = [];
    const ask: PromptShower = (prompt) => {
      asked.push(prompt.requestId);
      return new Promise(() => undefined);
    };
    const core = h.core({ ask, cursors: mapCursors(new Map([[session.id, 1234]])) });

    const run = follow(core.attach(summaryOf(session), new AbortController().signal));
    await waitFor(() => asked.length === 1, 'the question from the snapshot');
    h.machine.completeItem(session, message('m', 'After the gap.'));
    await run.next((event) => event.text === 'After the gap.\n');

    assert.deepEqual(asked, [request.id]);
    assert.deepEqual(
      session.stream.connects.map((connect) => [connect.lastEventId, connect.after]),
      [
        ['1234', null],
        [undefined, String(session.stream.latestId - 1)],
      ]
    );
  }));

test('a token the stream no longer accepts ends the run blocked, saying so; a missing token says what to do', () =>
  withCodex(async (h) => {
    const session = h.machine.seed();
    h.tokens.save(ROOT, session.id, `ast_${'W'.repeat(43)}`, session.taskId);
    const refused = h.core();
    const done = await follow(refused.attach(summaryOf(session), new AbortController().signal)).next(isDone);
    assert.equal(done.text, CODEX_LINES.tokenRefused);
    assert.equal(refused.blocked, true);

    const other = h.machine.seed();
    const missing = follow(h.core().attach(summaryOf(other), new AbortController().signal));
    await missing.ended();
    assert.deepEqual(missing.events.map((event) => event.text), [CODEX_LINES.tokenMissing]);
  }));

// ── The fence, and failures mid-task ─────────────────────────────────────────

test('a project lock RAVIS gave to another editor is the fence: the work is never committed, whether or not the claim is refused', () =>
  withCodex(async (h) => {
    // RAVIS says the lock is superseded, then grants the claim anyway: the window's own fence holds.
    const { run, session, core } = await started(h);
    h.machine.supersedeLock(session);
    session.superseded = false;
    await run.next((event) => event.text === CODEX_LINES.superseded);
    h.machine.completeTurn(session);
    const done = await run.next(isDone);
    assert.equal(done.text, CODEX_LINES.superseded);
    assert.equal(core.blocked, true);

    // RAVIS refuses the claim with LOCK_SUPERSEDED.
    const waiting = h.machine.seed({ state: 'completed_needs_review', turnActive: false });
    keepToken(h, waiting);
    h.machine.supersedeLock(waiting);
    const refused = await follow(h.core({ cursors: mapCursors(new Map()) }).attach(summaryOf(waiting), new AbortController().signal)).next(isDone);
    assert.equal(refused.text, CODEX_LINES.superseded);

    assert.deepEqual(h.git.saves, [], 'nothing was committed');
    assert.equal(session.settles.length + waiting.settles.length, 0);
  }));

const NPM_COMMAND: RunningCommand = { pid: 48210, pgid: 48210, start: 'Sun Sep 13 05:41:07 2026', comm: 'npm' };

/** A checkout on disk, with a git folder for the lock file, removed afterwards. */
async function withCheckout(run: (root: string, gitDir: string) => Promise<void>): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clarvis-codex-checkout-')));
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir);
  try {
    await run(root, gitDir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** The lock file an editor left when it closed mid-run, still recording the command it had going. */
function closedEditorsLock(file: string, command: RunningCommand | null): void {
  const content: LockFileContent = {
    version: 3,
    ravis_lock_id: null,
    taskId: 'the-closed-editors-task',
    engine: 'clarvis',
    state: 'running',
    holder: { kind: 'clarvis_run', session_id: null, pid: 999_999, pid_start: 'Sun Sep 13 01:00:00 2026', window_id: WINDOW_B.id, host: WINDOW_B.host, since: '2026-09-13T01:12:00Z' },
    heartbeatAt: '2026-09-13T01:40:00Z',
    waitingOnYou: false,
    leftover: [],
    takenOverFrom: null,
    running_command: command,
  };
  fs.writeFileSync(file, encodeLockFile(content), { mode: 0o600 });
}

/** The real project lock over the fake, with the other editor judged `verdict` and its command's stop recorded. */
function checkoutFloor(h: Harness, root: string, gitDir: string, verdict: Verdict, stopped: RunningCommand[]): CodexLockFloor {
  return {
    takeFromGoneEditor: async (taskId) => {
      const outcome = await takeProjectLock({
        root,
        gitDir,
        taskId,
        window: WINDOW_A,
        pid: process.pid,
        pidStart: 'Sun Sep 13 05:10:02 2026',
        locks: new LockClient(h.http),
        adopt: true,
        judge: async () => verdict,
        stopGroup: async (command) => {
          stopped.push(command);
          h.sent.push("the closed editor's command stopped");
          return { gone: true, signalled: 2 };
        },
        every: () => () => undefined,
      });
      return outcome.held ? { release: () => outcome.lock.release() } : { refusal: outcome.line };
    },
  };
}

test('a task an editor that closed left paused is reconciled: its command stopped, the checkout adopted, the work saved, the lock let go after (F-A9)', () =>
  withCodex((h) =>
    withCheckout(async (root, gitDir) => {
      const file = lockFilePath(root, gitDir);
      closedEditorsLock(file, NPM_COMMAND);
      const session = h.machine.seed({ root, state: 'uncertain', turnActive: false });
      h.tokens.save(root, session.id, session.token, session.taskId);
      h.machine.supersedeLock(session);
      const stopped: RunningCommand[] = [];
      const core = h.core({ workspace: { root, gitDir }, floor: checkoutFloor(h, root, gitDir, 'gone', stopped), cursors: mapCursors(new Map()) });

      const run = follow(core.attach(summaryOf(session), new AbortController().signal));
      const done = await run.next(isDone);
      await run.ended();

      assert.deepEqual(stopped, [NPM_COMMAND], 'what the closed editor left running was stopped first');
      assert.deepEqual(
        h.sent.filter((line) => /stopped|project-locks|settle/.test(line)),
        [
          "the closed editor's command stopped",
          'POST /api/v1/project-locks',
          `POST /api/v1/agent-sessions/${session.id}/settle-claim`,
          `POST /api/v1/agent-sessions/${session.id}/settle`,
          `POST /api/v1/project-locks/${FIXTURE_LOCK.id}/release`,
        ],
        'stopped, adopted, claimed, saved — and only then let go'
      );
      const adopt = h.fake.seen.find((request) => request.path === '/api/v1/project-locks')?.body as { adopt_file_lock?: boolean; clarvis_task_id?: string };
      assert.deepEqual([adopt.adopt_file_lock, adopt.clarvis_task_id], [true, session.taskId]);
      assert.equal(h.git.saves.length, 1);
      assert.ok(chat(run).includes(CODEX_LINES.adoptedFromGoneEditor));
      assert.notEqual(done.text, CODEX_LINES.superseded);
      assert.equal(fs.existsSync(file), false, 'the lock file is gone once the run is over');
    })
  ));

test('a task paused for an editor that is still there stays fenced: nothing is stopped, adopted, claimed or saved', () =>
  withCodex((h) =>
    withCheckout(async (root, gitDir) => {
      const file = lockFilePath(root, gitDir);
      closedEditorsLock(file, NPM_COMMAND);
      const session = h.machine.seed({ root, state: 'uncertain', turnActive: false });
      h.tokens.save(root, session.id, session.token, session.taskId);
      h.machine.supersedeLock(session);
      const stopped: RunningCommand[] = [];
      const core = h.core({ workspace: { root, gitDir }, floor: checkoutFloor(h, root, gitDir, 'unresponsive', stopped), cursors: mapCursors(new Map()) });

      const done = await follow(core.attach(summaryOf(session), new AbortController().signal)).next(isDone);

      assert.equal(done.text, CODEX_LINES.superseded);
      assert.deepEqual(stopped, []);
      assert.equal(h.sent.some((line) => line.includes('project-locks') || line.endsWith('/settle-claim')), false);
      assert.deepEqual(h.git.saves, []);
      const read = readLockFile(file);
      assert.equal(read.kind === 'present' && read.content.holder.window_id, WINDOW_B.id, "the other editor's lock file is untouched");
    })
  ));

test('"carry on" after the step cap is a carry_on turn on the same session, followed to its own settle — never a new task', () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);
    h.machine.completeTurn(session, { status: 'interrupted', error: { kind: 'step_cap', message: 'The step cap of 25 was reached.' } });
    await run.next(isDone);
    await run.ended();
    assert.equal(core.endedAtStepCap, true);
    // As it happens live: the first run closed its stream once its settle was answered, before RAVIS's `idle`
    // reached it, so this host's cursor stops just short of the last turn's end.
    h.cursors.set(session.id, session.stream.latestId - 1);

    const next = h.core();
    const carried = follow(next.carryOn(session.id, 'Carry on where you stopped.', new AbortController().signal));
    await waitFor(() => session.turns.length === 1, 'the carry-on turn');
    h.machine.completeItem(session, message('msg_rest', 'Finished the rest.'));
    h.machine.completeTurn(session);
    const done = await carried.next(isDone);

    assert.deepEqual(session.turns, [{ text: 'Carry on where you stopped.', kind: 'carry_on' }]);
    const read = h.sent.lastIndexOf(`GET /api/v1/agent-sessions/${session.id}`);
    assert.ok(read !== -1 && read < h.sent.indexOf(`POST /api/v1/agent-sessions/${session.id}/turns`), 'where the stream stands is read before the turn starts');
    assert.equal(h.machine.all.length, 1, 'no second session');
    assert.deepEqual(h.git.begun, [TASK], 'no second branch');
    assert.equal(done.text, 'Finished the rest.');
    assert.equal(session.settles.length, 2);
    assert.equal(next.endedAtStepCap, false);
  }));

test('RAVIS restarting mid-turn says the last step may not have finished, and the work is still saved', () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);
    h.machine.restartRavis(session);
    await run.next(isDone);

    assert.ok(chat(run).includes(CODEX_LINES.uncertain));
    assert.equal(h.git.saves.length, 1);
    assert.equal(core.blocked, false);
  }));

test("a failed turn says RAVIS's own words and leaves the run blocked, with its work still saved", () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);
    h.machine.completeTurn(session, { status: 'failed', error: { kind: 'other', message: "Codex couldn't reach OpenAI." } });
    await run.next(isDone);

    assert.ok(chat(run).includes("Codex's turn failed: Codex couldn't reach OpenAI."));
    assert.equal(core.blocked, true);
    assert.equal(h.git.saves.length, 1);
  }));

test('the step cap RAVIS enforces is said in its words, is not a failure, and the work is saved', () =>
  withCodex(async (h) => {
    const { run, session, core } = await started(h);
    h.machine.completeTurn(session, { status: 'interrupted', error: { kind: 'step_cap', message: 'The step cap of 25 was reached.' } });
    await run.next(isDone);

    assert.ok(chat(run).includes('The step cap of 25 was reached. Codex stopped there; its work so far is kept.'));
    assert.equal(core.blocked, false);
    assert.equal(h.git.saves.length, 1);
  }));

// ── Approvals (C2b), against the fake with Codex's requests from calibration ───

const ANSWER_ROUTE = 'POST /api/v1/agent-sessions/{sid}/requests/{rid}/answer';
const labelsOf = (asked: Asked) => asked.prompt.options.map((option) => option.label);

test("an approval is asked with RAVIS's decisions only, and answered with the button's, keyed <request id>:<window id>", () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    const request = h.machine.openCalibrationRequest(session, K2_COMMANDS[0]);
    await waitFor(() => asked.length === 1, 'the command to be asked');

    assert.deepEqual(labelsOf(asked[0]), ['Run it', 'Skip it', 'Stop the run']);
    assert.equal(asked[0].prompt.detail[0], `\`${K2_COMMANDS[0].script}\``, "the script inside Codex's shell wrapper");
    asked[0].answer('Run it');
    await waitFor(() => session.answers.length === 1, 'the answer to reach RAVIS');
    assert.deepEqual(session.answers, [{ requestId: request.id, decision: 'once', key: `${request.id}:${WINDOW_A.id}` }]);

    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test("Unattended, with this window's panel there, answers calibration's commands and file change itself, in order, copying the file first", () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const core = h.core({ ask, mode: 'unattended', capture: async (paths) => void h.sent.push(`capture ${paths.join(' ')}`) });
    const { run, session } = await started(h, core);
    const requests = [...K2_COMMANDS.map((command) => h.machine.openCalibrationRequest(session, command)), h.machine.openCalibrationRequest(session, K1_FILE_CHANGE)];
    await waitFor(() => session.answers.length === 5, 'every request to be answered');

    assert.equal(asked.length, 0, 'nobody was asked');
    assert.deepEqual(
      session.answers.map((answer) => [answer.requestId, answer.decision]),
      requests.map((request) => [request.id, 'once'])
    );
    const change = requests[4];
    assert.deepEqual(
      h.sent.filter((line) => line.startsWith('capture') || line.endsWith(`/requests/${change.id}/answer`)),
      ['capture ravis-cal-k1-cal_5a1d6ecc33b4-untrusted.txt', `POST /api/v1/agent-sessions/${session.id}/requests/${change.id}/answer`],
      'the file copied for undo before the answer went'
    );

    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('a switch to Unattended answers the quiet command already on screen, and its buttons go', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    let mode: SessionMode = 'agent';
    const { run, session, core } = await started(h, h.core({ ask, modeNow: () => mode }));
    h.machine.openCalibrationRequest(session, K11_FOR_THE_SESSION);
    await waitFor(() => asked.length === 1, 'the command to be asked');

    mode = 'unattended';
    core.modeChanged();
    await waitFor(() => session.answers.length === 1, 'Unattended to answer it');
    assert.equal(asked[0].signal.aborted, true);
    assert.equal(session.answers[0].decision, 'once');

    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('with the panel gone, a switch to Unattended answers nothing; once it is back, it does', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    let mode: SessionMode = 'agent';
    let clock = Date.parse('2026-09-14T14:00:00Z');
    const core = h.core({ ask, modeNow: () => mode, now: () => new Date(clock) });
    const { run, session } = await started(h, core);
    h.machine.openCalibrationRequest(session, K11_FOR_THE_SESSION);
    await waitFor(() => asked.length === 1, 'the command to be asked');

    clock += 30_000;
    core.presenceTick(clock); // no ping for 30 s: the panel is gone
    mode = 'unattended';
    core.modeChanged();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(session.answers.length, 0, 'nothing answered while no panel is attached');
    assert.equal(asked[0].signal.aborted, false);

    core.panelPinged(clock + 1);
    await waitFor(() => core.isConnected, 'the stream to reopen');
    core.modeChanged();
    await waitFor(() => session.answers.length === 1, 'Unattended to answer it now');
    assert.equal(session.answers[0].decision, 'once');

    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test("an answer RAVIS never received is said so, and the request is asked again once RAVIS answers", () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    const request = h.machine.openCalibrationRequest(session, K2_COMMANDS[0]);
    await waitFor(() => asked.length === 1, 'the command to be asked');

    await h.fake.stopListening();
    asked[0].answer('Run it');
    await run.next((event) => event.text === CODEX_LINES.answerUnsent);
    assert.equal(session.answers.length, 0);

    await h.fake.listenAgain();
    await waitFor(() => asked.length === 2, 'the request to be asked again once RAVIS is back', 10_000);
    asked[1].answer('Run it');
    await waitFor(() => session.answers.length === 1, 'the answer to reach RAVIS');
    assert.deepEqual(session.answers.map((answer) => [answer.requestId, answer.decision]), [[request.id, 'once']]);

    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('blocked sites are one card; the task carries on once every host is decided and its work is saved, and "Reconnecting" shows only while RAVIS reopens', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    h.machine.blockSites(session, ['download.pytorch.org', 'huggingface.co']);
    await waitFor(() => asked.length === 1, 'the group to be asked');

    assert.equal(session.state, 'running', "a site ask doesn't make the task wait");
    assert.equal(asked[0].prompt.line, 'Codex was blocked from reaching download.pytorch.org and huggingface.co.');
    assert.deepEqual(labelsOf(asked[0]), [
      'Allow download.pytorch.org',
      'Keep download.pytorch.org blocked',
      'Allow huggingface.co',
      'Keep huggingface.co blocked',
      'Allow all',
    ]);

    h.fake.reply(ANSWER_ROUTE, "allow a site Codex didn't add");
    asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => asked.length === 2, 'the card to be drawn again');
    assert.ok(chat(run).includes("Codex didn't add download.pytorch.org, so it stays blocked."));

    // The turn ends with the asks open: RAVIS lets go of the thread, and the work so far is saved meanwhile.
    h.machine.completeTurn(session);
    await run.next((event) => event.kind === 'status' && event.text === SITE_LINES.reconnecting);
    await waitFor(() => session.settles.length === 1 && session.state === 'idle', 'the work so far to be saved');
    assert.equal(run.events.some(isDone), false, 'the run goes on while the owner decides');
    assert.equal(session.turns.length, 0, 'nothing carries on before every host is decided');

    asked[1].answer('Keep huggingface.co blocked');
    await waitFor(() => asked.length === 3, 'the card for the host left');
    assert.deepEqual(labelsOf(asked[2]), ['Allow download.pytorch.org', 'Keep download.pytorch.org blocked']);
    asked[2].answer('Allow download.pytorch.org');

    await waitFor(() => session.turns.length === 1, 'the carry-on');
    assert.deepEqual(session.turns, [{ kind: 'carry_on', text: 'The owner allowed download.pytorch.org; huggingface.co stays blocked. Carry on where you stopped.' }]);
    assert.ok(chat(run).includes('Allowed download.pytorch.org; huggingface.co stays blocked. Codex carries on where it stopped.'));
    assert.equal(session.state, 'starting', 'RAVIS holds the turn until the thread is reopened');

    h.machine.finishReopen(session);
    await run.next((event) => event.kind === 'status' && event.text === '');
    await waitFor(() => session.activeTurn !== null, 'the carry-on turn to begin');
    h.machine.completeTurn(session);
    await run.next(isDone);
    assert.equal(session.settles.length, 2, 'each turn saved');
    assert.deepEqual(
      session.answers.map((answer) => answer.decision),
      ['keep_blocked', 'allow_site'],
      "the refused allow was RAVIS's scripted answer, never recorded"
    );
  }));

const TURNS_ROUTE = 'POST /api/v1/agent-sessions/{sid}/turns';
const reconnectingShown = (run: Followed) => run.events.filter((event) => event.kind === 'status' && event.text === SITE_LINES.reconnecting).length;
const createBodies = (h: Harness) =>
  h.fake.seen.filter((seen) => seen.method === 'POST' && seen.path === '/api/v1/agent-sessions').map((seen) => seen.body as CreateSessionBody);

/** A task with one blocked host whose turn has ended and whose work is saved, waiting on the owner's decision. */
async function waitingOnASite(h: Harness) {
  const { ask, asked } = holdingAsker();
  const started_ = await started(h, h.core({ ask }));
  h.machine.blockSites(started_.session, ['download.pytorch.org']);
  await waitFor(() => asked.length === 1, 'the site to be asked');
  h.machine.completeTurn(started_.session);
  await waitFor(() => started_.session.state === 'idle', 'the work so far to be saved');
  // …and this window has heard so: its cursor is past RAVIS's idle, not only RAVIS's own state.
  const idleAt = started_.session.stream.latestId;
  await waitFor(() => (h.cursors.get(started_.session.id) ?? 0) >= idleAt, 'this window to hear the task is idle');
  return { ...started_, asked };
}

test('hosts decided while their turn still runs carry the task on only after that turn has ended and its work is saved; a reopen that runs out of time says so', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    h.machine.blockSites(session, ['download.pytorch.org']);
    await waitFor(() => asked.length === 1, 'the ask');
    asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => session.answers.length === 1, 'the decision to reach RAVIS');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(session.turns.length, 0, 'no carry-on while the turn runs');
    assert.equal(session.reopening, null, "RAVIS doesn't let go of a thread whose turn still runs");
    assert.ok(chat(run).includes('Allowed download.pytorch.org. Codex carries on where it stopped.'));

    h.machine.completeTurn(session);
    await waitFor(() => session.turns.length === 1, 'the carry-on');
    const settleAt = h.sent.findIndex((line) => line.endsWith('/settle'));
    const turnAt = h.sent.findIndex((line) => line.endsWith('/turns'));
    assert.ok(settleAt !== -1 && settleAt < turnAt, 'saved first, then carried on');
    assert.deepEqual(h.machine.get(session.id)?.reopening?.hosts, ['download.pytorch.org'], 'RAVIS reopens for the site allowed since the thread loaded');
    assert.equal(session.turns[0].text, 'The owner allowed download.pytorch.org. Carry on where you stopped.');

    h.machine.finishReopen(session, 'incomplete');
    await run.next((event) => event.text === SITE_LINES.reopenIncomplete);
    assert.equal(run.events.filter((event) => event.kind === 'status').at(-1)?.text, '', 'the reconnecting line is gone');
    await waitFor(() => session.activeTurn !== null, 'the carry-on turn');
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('a site allowed after Codex reconnected reopens the thread again, shown the same way, and the task carries on again', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    h.machine.blockSites(session, ['download.pytorch.org']);
    await waitFor(() => asked.length === 1, 'the first ask');
    h.machine.completeTurn(session);
    await waitFor(() => reconnectingShown(run) === 1 && session.state === 'idle', 'the first reopen, with the work saved');
    asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => session.turns.length === 1, 'the first carry-on');
    h.machine.finishReopen(session);
    await waitFor(() => session.activeTurn !== null, 'the carry-on turn');

    h.machine.blockSites(session, ['huggingface.co']);
    await waitFor(() => asked.length === 2, 'the second ask');
    asked[1].answer('Allow huggingface.co');
    await waitFor(() => session.answers.length === 2, 'the second decision');
    h.machine.completeTurn(session);
    await waitFor(() => reconnectingShown(run) === 2, 'the second reopen, shown the same way');
    await waitFor(() => session.turns.length === 2, 'the second carry-on');
    assert.equal(session.turns[1].text, 'The owner allowed huggingface.co. Carry on where you stopped.');
    h.machine.finishReopen(session);
    await waitFor(() => session.activeTurn !== null, 'the second carry-on turn');
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('a Stop while the owner decides, with the work saved and nothing running, ends the run at once: nothing interrupted, nothing carried on', () =>
  withCodex(async (h) => {
    const { run, core, session, asked } = await waitingOnASite(h);
    core.stop();
    const done = await run.next(isDone);
    assert.equal(done.text, CODEX_LINES.stopped);
    assert.equal(asked[0].signal.aborted, true, 'the card goes with the Stop');
    assert.equal(session.interrupts, 0);
    assert.equal(session.turns.length, 0);
    assert.equal(session.open.size, 1, 'RAVIS keeps the site ask: it outlives the turn');
  }));

test('a Stop while the carry-on waits for the reopen drops that turn, and the run ends once the stop is saved', () =>
  withCodex(async (h) => {
    const { run, core, session, asked } = await waitingOnASite(h);
    asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => session.state === 'starting', 'the carry-on waiting for the reopen');
    core.stop();
    const done = await run.next(isDone);
    assert.equal(done.text, CODEX_LINES.stopped);
    assert.equal(session.interrupts, 1);
    assert.deepEqual([session.reopening?.queued, session.reopening?.resume], [null, false], 'the waiting turn dropped, the resume skipped');
    assert.equal(session.activeTurn, null, 'the carry-on never began');
    assert.equal(session.settles.length, 2);
    assert.equal(run.events.filter((event) => event.kind === 'status').at(-1)?.text, '', 'the reconnecting line goes with the run');
  }));

test('RAVIS restarting while the carry-on waits for the reopen leaves the task uncertain: its work is saved and the run ends', () =>
  withCodex(async (h) => {
    const { run, session, asked } = await waitingOnASite(h);
    asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => session.state === 'starting', 'the carry-on waiting for the reopen');
    h.machine.restartRavis(session);
    await run.next(isDone);
    assert.ok(chat(run).includes(CODEX_LINES.uncertain));
    assert.equal(session.settles.length, 2);
  }));

test('a carry-on whose answer is lost is sent again with the same key, and RAVIS starts it once', () =>
  withCodex(async (h) => {
    const { run, session, asked } = await waitingOnASite(h);
    h.fake.loseNextResponse(TURNS_ROUTE);
    asked[0].answer('Keep download.pytorch.org blocked');
    await waitFor(() => h.fake.seen.filter((seen) => seen.path.endsWith('/turns')).length === 2, 'the carry-on sent again, and received');
    assert.equal(session.turns.length, 1, 'started once');
    assert.equal(session.turns[0].text, 'The owner kept download.pytorch.org blocked. Carry on where you stopped.');
    const keys = h.fake.seen.filter((seen) => seen.path.endsWith('/turns')).map((seen) => seen.headers['idempotency-key']);
    assert.equal(keys[0], keys[1]);
    h.machine.finishReopen(session);
    await waitFor(() => session.activeTurn !== null, 'the carry-on turn');
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('a carry-on RAVIS refuses for now is sent again with the same key once this window hears RAVIS again, and starts once', () =>
  withCodex(async (h) => {
    const { run, session, asked } = await waitingOnASite(h);
    const turnsSeen = () => h.fake.seen.filter((seen) => seen.path.endsWith('/turns'));
    h.fake.reply(TURNS_ROUTE, 'the last turn still needs a settle');
    asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => turnsSeen().length === 1, 'the carry-on refused for now');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(session.turns.length, 0);
    session.stream.disconnect();
    await waitFor(() => turnsSeen().length === 2, 'the carry-on sent again');
    assert.equal(new Set(turnsSeen().map((seen) => seen.headers['idempotency-key'])).size, 1, 'one key for every try');
    assert.equal(session.turns.length, 1, 'started once');
    h.machine.finishReopen(session);
    await waitFor(() => session.activeTurn !== null, 'the carry-on turn');
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('a carry-on RAVIS took though every answer to it was lost is known taken once its turn begins: never sent again, and the run ends', () =>
  withCodex(async (h) => {
    const { run, session, asked } = await waitingOnASite(h);
    const turnsSeen = () => h.fake.seen.filter((seen) => seen.path.endsWith('/turns'));
    h.fake.loseNextResponse(TURNS_ROUTE);
    h.fake.loseNextResponse(TURNS_ROUTE);
    asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => turnsSeen().length === 2 && session.state === 'starting', 'RAVIS took it, and both answers were lost');
    h.machine.finishReopen(session);
    await waitFor(() => session.activeTurn !== null, 'the carry-on turn');
    h.machine.completeTurn(session);
    await run.next(isDone);
    assert.equal(turnsSeen().length, 2, 'never sent again');
    assert.equal(session.turns.length, 1, 'started once');
  }));

test("after another editor saved the work before the carry-on, this window's own save of the rest is said as its own", () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    h.machine.blockSites(session, ['download.pytorch.org']);
    await waitFor(() => asked.length === 1, 'the ask');
    h.fake.reply('POST /api/v1/agent-sessions/{sid}/settle-claim', errorAnswer(409, 'SETTLE_CLAIMED', undefined, { window: 'win-other' }));
    h.machine.completeTurn(session);
    await run.next((event) => event.text === CODEX_LINES.otherEditorSaving);
    const other = new RelayClient(h.http);
    const claim = await other.claimSettle(session.id, session.token, 'win-other');
    if (!claim.ok) throw new Error('the other editor could not claim');
    assert.ok((await other.settle(session.id, session.token, { claim_id: claim.value.claim_id, commit: COMMIT, next: 'idle' }, freshKey())).ok);

    asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => session.turns.length === 1, 'the carry-on');
    h.machine.finishReopen(session);
    await waitFor(() => session.activeTurn !== null, 'the carry-on turn');
    h.machine.completeItem(session, message('msg_rest', 'Done with the rest.'));
    h.machine.completeTurn(session);
    const done = await run.next(isDone);
    assert.equal(done.text, 'Done with the rest.');
    assert.equal(session.settles.length, 2);
  }));

test('a carry-on refused because a turn already runs is passed to that turn as a steer', () =>
  withCodex(async (h) => {
    const steered = await waitingOnASite(h);
    h.fake.reply(TURNS_ROUTE, 'a turn is active: steer instead');
    steered.asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => steered.session.steers.length === 1, 'the decisions passed on');
    assert.equal(steered.session.steers[0].text, 'The owner allowed download.pytorch.org. Carry on where you stopped.');
    assert.equal(steered.session.turns.length, 0);
    steered.core.stop();
    await steered.run.next(isDone);
  }));

test('a carry-on RAVIS refuses for good is said, and the run ends', () =>
  withCodex(async (h) => {
    const { run, asked } = await waitingOnASite(h);
    h.fake.reply(TURNS_ROUTE, 'the allowance is used up');
    asked[0].answer('Allow download.pytorch.org');
    await run.next(isDone);
    assert.ok(chat(run).some((line) => line.endsWith('Its work so far is in the project.')), chat(run).join(' | '));
  }));

test('with two windows following, only the window whose answer decided the last host carries the task on', () =>
  withCodex(async (h) => {
    const a = holdingAsker();
    const { run, session } = await started(h, h.core({ ask: a.ask }));
    keepToken(h, session);
    const b = holdingAsker();
    const coreB = h.core({ window: WINDOW_B, ask: b.ask, cursors: mapCursors(new Map()) });
    const runB = follow(coreB.attach(summaryOf(session), new AbortController().signal));
    await waitFor(() => coreB.isConnected, 'B to follow');

    h.machine.blockSites(session, ['download.pytorch.org', 'huggingface.co']);
    await waitFor(() => a.asked.length === 1 && b.asked.length === 1, 'both windows to ask');
    a.asked[0].answer('Allow download.pytorch.org');
    await waitFor(() => b.asked.length === 2 && a.asked.length === 2, 'both cards drawn again for the host left');
    assert.equal(b.asked[1].prompt.line, 'Codex was blocked from reaching huggingface.co (https).');
    b.asked[1].answer('Keep huggingface.co blocked');
    await waitFor(() => a.asked[1].signal.aborted, "A's card withdrawn");
    assert.ok(chat(run).includes(CODEX_LINES.answeredElsewhere));

    h.machine.completeTurn(session);
    await waitFor(() => session.turns.length === 1, 'the carry-on');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(session.turns.length, 1, 'carried on once');
    assert.ok(chat(runB).includes('Allowed download.pytorch.org; huggingface.co stays blocked. Codex carries on where it stopped.'));
    assert.equal(chat(run).some((line) => line.startsWith('Allowed')), false, 'A did not decide the last host');
    h.machine.finishReopen(session);
    await waitFor(() => session.activeTurn !== null, 'the carry-on turn');
    h.machine.completeTurn(session);
    await runB.next(isDone);
  }));

test('a window that picks a task up while RAVIS reopens it shows "Reconnecting" until Codex has let go, and asks the open site', () =>
  withCodex(async (h) => {
    const session = h.machine.seed();
    h.machine.blockSites(session, ['download.pytorch.org']);
    h.machine.completeTurn(session);
    keepToken(h, session);
    const { ask, asked } = holdingAsker();
    const core = h.core({ ask });
    const run = follow(core.attach(summaryOf(session), new AbortController().signal));
    await run.next((event) => event.kind === 'status' && event.text === SITE_LINES.reconnecting);
    await waitFor(() => asked.length === 1 && session.state === 'idle', 'the open site asked, and the work saved');
    h.machine.finishReopen(session);
    await run.next((event) => event.kind === 'status' && event.text === '');
    core.stop();
    await run.next(isDone);
    assert.equal(session.interrupts, 0);
  }));

// ── The sites a task needs, before it starts (C2b+) ──────────────────────────

test('before a start, the sites the task may need that Codex does not allow yet are asked about once; Allow and start adds them, then the task starts', () =>
  withCodex(async (h) => {
    const sites = h.fake.sites();
    const { ask, asked } = holdingAsker();
    const found = [
      { host: 'download.pytorch.org', foundIn: ['requirements.txt'] },
      { host: 'pypi.org', foundIn: ['requirements.txt'] },
    ];
    const core = h.core({ ask, sitesFor: () => found });
    const run = follow(core.start(TASK, new AbortController().signal));
    await waitFor(() => asked.length === 1, 'the ask before the start');

    assert.equal(asked[0].prompt.line, 'This task may need download.pytorch.org. Allow it before Codex starts?', 'a default site is never asked about');
    assert.deepEqual(asked[0].prompt.detail, ['download.pytorch.org: found in requirements.txt']);
    assert.deepEqual(h.git.begun, [], 'nothing touched while asking');
    assert.equal(h.machine.all.length, 0);

    asked[0].answer('Allow and start');
    await waitFor(() => h.machine.all.length === 1 && core.isConnected, 'the task to start');
    assert.deepEqual([...sites.added], ['download.pytorch.org']);
    assert.ok(chat(run).includes("Allowed download.pytorch.org for Codex's commands, in this task and every later one."));
    h.machine.completeTurn(h.machine.all[0]);
    await run.next(isDone);
  }));

test('Start without it starts with nothing added', () =>
  withCodex(async (h) => {
    const sites = h.fake.sites();
    const { ask, asked } = holdingAsker();
    const core = h.core({ ask, sitesFor: () => [{ host: 'download.pytorch.org', foundIn: ['the task'] }] });
    const run = follow(core.start(TASK, new AbortController().signal));
    await waitFor(() => asked.length === 1, 'the ask');
    asked[0].answer('Start without it');
    await waitFor(() => h.machine.all.length === 1 && core.isConnected, 'the task to start');
    assert.deepEqual(sites.posts, []);
    h.machine.completeTurn(h.machine.all[0]);
    await run.next(isDone);
  }));

test('Cancel at the ask before a start touches nothing: no branch, no session, and no failure', () =>
  withCodex(async (h) => {
    h.fake.sites();
    const { ask, asked } = holdingAsker();
    const core = h.core({ ask, sitesFor: () => [{ host: 'download.pytorch.org', foundIn: ['the task'] }] });
    const run = follow(core.start(TASK, new AbortController().signal));
    await waitFor(() => asked.length === 1, 'the ask');
    asked[0].answer('Cancel');
    const done = await run.next(isDone);
    assert.equal(done.text, SITE_LINES.cancelled);
    assert.equal(core.blocked, false);
    assert.deepEqual(h.git.begun, []);
    assert.equal(h.machine.all.length, 0);
  }));

test('a Stop while the sites are asked about ends the ask at once and starts nothing', () =>
  withCodex(async (h) => {
    h.fake.sites();
    const { ask, asked } = holdingAsker();
    const controller = new AbortController();
    const core = h.core({ ask, sitesFor: () => [{ host: 'download.pytorch.org', foundIn: ['the task'] }] });
    const run = follow(core.start(TASK, controller.signal));
    await waitFor(() => asked.length === 1, 'the ask');
    controller.abort();
    const done = await run.next(isDone);
    assert.equal(done.text, CODEX_LINES.stopped);
    assert.equal(asked[0].signal.aborted, true);
    assert.deepEqual(h.git.begun, []);
  }));

test('allowing before a start: a host RAVIS refuses is dropped and the rest asked again with why; one Codex did not add leaves only Start without and Cancel', () =>
  withCodex(async (h) => {
    const sites = h.fake.sites();
    sites.notAdded = 'overridden';
    h.fake.reply(ALLOW_SITES_ROUTE, errorAnswer(422, 'SITES_REFUSED', undefined, { refused: [{ host: 'huggingface.co', reason: 'local_name' }] }));
    const { ask, asked } = holdingAsker();
    const found = [
      { host: 'download.pytorch.org', foundIn: ['requirements.txt'] },
      { host: 'huggingface.co', foundIn: ['the task'] },
    ];
    const core = h.core({ ask, sitesFor: () => found });
    const run = follow(core.start(TASK, new AbortController().signal));
    await waitFor(() => asked.length === 1, 'the ask');
    asked[0].answer('Allow and start');
    await waitFor(() => asked.length === 2, 'the ask again, without the refused host');
    assert.equal(
      asked[1].prompt.line,
      "RAVIS allows only exact public host names, so nothing was added: huggingface.co (a name on this Mac or its network) can't be allowed. This task may need download.pytorch.org. Allow it before Codex starts?"
    );
    asked[1].answer('Allow and start');
    await waitFor(() => asked.length === 3, 'the ask again, without Allow');
    assert.equal(asked[2].prompt.line, "Codex didn't add download.pytorch.org, so it stays blocked. Start Codex without download.pytorch.org?");
    assert.deepEqual(labelsOf(asked[2]), ['Start without it', 'Cancel']);
    asked[2].answer('Start without it');
    await waitFor(() => h.machine.all.length === 1 && core.isConnected, 'the task to start');
    assert.deepEqual([...sites.added], []);
    h.machine.completeTurn(h.machine.all[0]);
    await run.next(isDone);
  }));

test('nothing is asked before a start when RAVIS cannot say which sites Codex allows, or when the look through the project fails', () =>
  withCodex(async (h) => {
    const sites = h.fake.sites();
    sites.unreadable = true;
    const { ask, asked } = holdingAsker();
    const unreadable = await started(h, h.core({ ask, sitesFor: () => [{ host: 'download.pytorch.org', foundIn: ['the task'] }] }));
    assert.equal(asked.length, 0);
    assert.equal(h.sent.filter((line) => line === 'GET /api/v1/codex/sites').length, 1);
    h.machine.completeTurn(unreadable.session);
    await unreadable.run.next(isDone);
  }));

test('a look through the project that fails asks RAVIS nothing about sites, and the task starts', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const failing = () => {
      throw new Error('EACCES');
    };
    const { run, session } = await started(h, h.core({ ask, sitesFor: failing }));
    assert.equal(asked.length, 0);
    assert.equal(h.sent.some((line) => line.includes('/codex/sites')), false);
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('no more hosts are asked about before a start than one allow takes', () =>
  withCodex(async (h) => {
    const sites = h.fake.sites();
    const { ask, asked } = holdingAsker();
    const found = Array.from({ length: 25 }, (_, index) => ({ host: `mirror${index}.example.com`, foundIn: ['the task'] }));
    const core = h.core({ ask, sitesFor: () => found });
    const run = follow(core.start(TASK, new AbortController().signal));
    await waitFor(() => asked.length === 1, 'the ask');
    assert.equal(asked[0].prompt.detail.length, 20);
    asked[0].answer('Allow and start');
    await waitFor(() => h.machine.all.length === 1 && core.isConnected, 'the task to start');
    assert.equal((sites.posts[0] as string[]).length, 20);
    h.machine.completeTurn(h.machine.all[0]);
    await run.next(isDone);
  }));

// ── The model and effort a task runs at (C2b+, R5) ───────────────────────────

test("a new task runs at the owner's chosen model and effort, and the chat says which", () =>
  withCodex(async (h) => {
    const { run, session } = await started(h, h.core({ codexChoice: () => ({ model: 'gpt-6-astra', effort: 'high' }) }));
    const [body] = createBodies(h);
    assert.deepEqual([body.model, body.effort], ['gpt-6-astra', 'high']);
    assert.equal(session.effort, 'high');
    await run.next((event) => event.text === 'Codex is using gpt-6-astra, at high effort.');
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('with nothing chosen, a task leaves the model and effort to Codex, and says what Codex runs', () =>
  withCodex(async (h) => {
    const { run, session } = await started(h, h.core({ codexChoice: () => ({}) }));
    const [body] = createBodies(h);
    assert.equal(body.model, '');
    assert.equal('effort' in body, false);
    await run.next((event) => event.text === 'Codex is using gpt-6-astra, at its default effort.');
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('a chosen model Codex no longer offers becomes the default, at its default effort, and the chat says so', () =>
  withCodex(async (h) => {
    const { run, session } = await started(h, h.core({ codexChoice: () => ({ model: 'gpt-5-gone', effort: 'high' }) }));
    const [body] = createBodies(h);
    assert.deepEqual([body.model, body.effort], ['gpt-6-astra', 'low']);
    await run.next((event) => event.text.startsWith('Codex no longer offers gpt-5-gone, so this task uses gpt-6-astra at low effort.'));
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('a model or an effort RAVIS refuses at the start is said plainly, with where to choose again, and the branch is tidied away', () =>
  withCodex(async (h) => {
    const listed = { id: 'gpt-6-astra', display_name: 'gpt-6-astra', is_default: true, default_effort: 'low', efforts: ['low', 'medium'] };
    h.machine.models = [listed];
    const effort = h.core({ codexChoice: () => ({ model: 'gpt-6-astra', effort: 'high' }) });
    const effortDone = await follow(effort.start(TASK, new AbortController().signal)).next(isDone);
    assert.equal(effortDone.text, "gpt-6-astra doesn't offer high effort (it offers low and medium). Choose another under Codex in the bowtie menu by the prompt.");
    assert.equal(effort.blocked, true);

    h.machine.models = [{ ...listed, id: 'gpt-7', display_name: 'gpt-7' }];
    const model = h.core({ codexChoice: () => ({ model: 'gpt-6-astra', effort: 'low' }) });
    const modelDone = await follow(model.start(TASK, new AbortController().signal)).next(isDone);
    assert.equal(modelDone.text, "Codex doesn't offer gpt-6-astra to this ChatGPT account (it offers gpt-7). Choose another under Codex in the bowtie menu by the prompt.");
    assert.equal(h.git.abandoned, 2);
    assert.equal(h.machine.all.length, 0);
  }));

test("a chosen model before Codex has listed its models isn't an error: Codex isn't ready yet", () =>
  withCodex(async (h) => {
    const signedIn = exampleNamed(CODEX_STATE_ROUTE, 'signed in, three projects busy, read by a named caller').response.body as CodexState;
    h.fake.reply(CODEX_STATE_ROUTE, { status: 200, body: { ...signedIn, models: [] } });
    const early = h.core({ codexChoice: () => ({ model: 'gpt-6-astra', effort: 'high' }) });
    const earlyDone = await follow(early.start(TASK, new AbortController().signal)).next(isDone);
    assert.equal(earlyDone.text, CODEX_LINES.modelsNotListed);
    assert.equal(early.blocked, false);
    assert.deepEqual(h.git.begun, [], 'nothing touched');

    // Listed when read, not yet when the session is created: RAVIS's 503 says the same.
    h.machine.models = [];
    const race = h.core({ codexChoice: () => ({ model: 'gpt-6-astra', effort: 'high' }) });
    const raceDone = await follow(race.start(TASK, new AbortController().signal)).next(isDone);
    assert.equal(raceDone.text, CODEX_LINES.modelsNotListed);
    assert.equal(race.blocked, false);
    assert.equal(h.git.abandoned, 1);
  }));

test('RAVIS narrowing a request draws it again from what it offers now, and that is what is sent', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    const request = h.machine.openCalibrationRequest(session, K2_COMMANDS[1]);
    await waitFor(() => asked.length === 1, 'the command to be asked');

    h.machine.narrowRequest(session, request.id, ['skip', 'stop']);
    asked[0].answer('Run it');
    await waitFor(() => asked.length === 2, 'the command to be drawn again');
    assert.deepEqual(labelsOf(asked[1]), ['Skip it', 'Stop the run']);
    assert.ok(chat(run).includes(CODEX_LINES.decisionNarrowed));

    asked[1].answer('Skip it');
    await waitFor(() => session.answers.length === 1, 'the answer');
    assert.deepEqual(session.answers.map((answer) => [answer.requestId, answer.decision]), [[request.id, 'skip']]);
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('words typed while a command waits go to Codex as a steer, and the command is asked again', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    const request = h.machine.openCalibrationRequest(session, K2_COMMANDS[3]);
    await waitFor(() => asked.length === 1, 'the command to be asked');

    asked[0].answer('put it in build/ instead');
    await waitFor(() => session.steers.length === 1 && asked.length === 2, 'the steer, and the command asked again');
    assert.equal(session.steers[0].text, 'put it in build/ instead');
    assert.equal(asked[1].again, true, 'its buttons offered again without repeating its line');
    assert.equal(session.answers.length, 0, 'nothing answered by the typed words');

    asked[1].answer('Skip it');
    await waitFor(() => session.answers.length === 1, 'the answer');
    assert.deepEqual(session.answers.map((answer) => [answer.requestId, answer.decision]), [[request.id, 'skip']]);
    h.machine.completeTurn(session);
    await run.next(isDone);
  }));

test('"Stop the run" stops the task as Stop does: the question let go, RAVIS interrupted, no answer sent', () =>
  withCodex(async (h) => {
    const { ask, asked } = holdingAsker();
    const { run, session } = await started(h, h.core({ ask }));
    h.machine.openCalibrationRequest(session, K11_FOR_THE_SESSION);
    await waitFor(() => asked.length === 1, 'the command to be asked');

    asked[0].answer('Stop the run');
    const done = await run.next(isDone);

    assert.equal(done.text, CODEX_LINES.stopped);
    assert.ok(chat(run).includes(CODEX_LINES.stopping));
    assert.equal(session.interrupts, 1);
    assert.deepEqual(session.answers, []);
    assert.equal(chat(run).some((line) => line.startsWith('Stopped from')), false, "said as this window's own stop");
  }));
